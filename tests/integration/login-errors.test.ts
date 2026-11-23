import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import type { PrismaClient } from "@/generated/prisma/client";
import { LOGIN_MESSAGES, loginErrorMessage } from "@/features/authentication/login-errors";
import { startTestDb, type TestDb } from "../helpers/db";
import { prismaProxy, setTestEnv } from "../helpers/mock-prisma";

/**
 * Errores del login de extremo a extremo con Auth.js real (@auth/core), Prisma real sobre PGlite y el rate limit real.
 * Se llama igual que `signIn("credentials", { redirect: false })` de next-auth/react (cabecera X-Auth-Return-Redirect)
 * y se extraen `error` y `code` de la URL como hace ese cliente; después se aplica el mismo mapeo que el formulario.
 */
const holder = vi.hoisted(() => ({ prisma: null as PrismaClient | null }));
vi.mock("@/lib/prisma", () => ({ prisma: prismaProxy(holder) }));

const BASE = "http://localhost:3000";
const SECRET = "x".repeat(32);
const LIMIT = 10; // política actual: 10 intentos / 15 min por email

let t: TestDb;
let Auth: typeof import("@auth/core").Auth;
let authOptions: typeof import("@/lib/auth").authOptions;
let emailKey: (email: string) => string; // clave HMAC `login-email` (19.15a)

beforeAll(async () => {
  setTestEnv();
  t = await startTestDb();
  holder.prisma = t.prisma;
  ({ Auth } = await import("@auth/core"));
  ({ authOptions } = await import("@/lib/auth"));
  const { emailRateKey } = await import("@/lib/rate-limit/email");
  emailKey = (email) => emailRateKey("login-email", email);
}, 60_000);
afterAll(async () => { await t?.stop(); });
// Auth.js registra con console.error todo fallo de login (también los esperados): se silencia y se inspecciona.
let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined); return () => errSpy.mockRestore(); });

const config = () => ({ ...authOptions, secret: SECRET, basePath: "/api/auth", trustHost: true });
const cookiesOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]!);

interface Attempt { error?: string; code?: string; url: string; sessionCookie: boolean; message: string | null }

async function attempt(email: string, password: string): Promise<Attempt> {
  const csrfRes = await Auth(new Request(`${BASE}/api/auth/csrf`), config());
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  const res = await Auth(new Request(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Auth-Return-Redirect": "1", cookie: cookiesOf(csrfRes).join("; ") },
    body: new URLSearchParams({ csrfToken, email, password, callbackUrl: `${BASE}/dashboard` }),
  }), config());
  const { url } = (await res.json()) as { url: string };
  const params = new URL(url).searchParams;
  const out = { error: params.get("error") ?? undefined, code: params.get("code") ?? undefined };
  return { ...out, url, sessionCookie: cookiesOf(res).some((c) => c.startsWith("authjs.session-token=")), message: loginErrorMessage(out) };
}

async function createUser(email: string, password: string) {
  return t.prisma.user.create({ data: { email, emailVerified: new Date(), passwordHash: await bcrypt.hash(password, 4), profile: { create: {} } } });
}

describe("respuestas del login", () => {
  it("login correcto: sin error, con cookie de sesión y sesión creada", async () => {
    const u = await createUser("ok@l.com", "Clave-12345");
    const r = await attempt("ok@l.com", "Clave-12345");
    expect(r.error).toBeUndefined();
    expect(r.message).toBeNull();
    expect(r.sessionCookie).toBe(true);
    expect(await t.prisma.session.count({ where: { userId: u.id } })).toBe(1);
  });

  it("contraseña incorrecta: mensaje genérico de credenciales, sin sesión", async () => {
    const u = await createUser("mal@l.com", "Clave-12345");
    const r = await attempt("mal@l.com", "Otra-12345");
    expect([r.error, r.code]).toEqual(["CredentialsSignin", "credentials"]);
    expect(r.message).toBe(LOGIN_MESSAGES.invalid);
    expect(r.sessionCookie).toBe(false);
    expect(await t.prisma.session.count({ where: { userId: u.id } })).toBe(0);
  });

  it("usuario inexistente: respuesta idéntica a la de contraseña incorrecta", async () => {
    await createUser("existe@l.com", "Clave-12345");
    const wrong = await attempt("existe@l.com", "Otra-12345");
    const missing = await attempt("no-existe@l.com", "Otra-12345");
    expect({ error: missing.error, code: missing.code, message: missing.message, cookie: missing.sessionCookie })
      .toEqual({ error: wrong.error, code: wrong.code, message: wrong.message, cookie: wrong.sessionCookie });
  });
});

describe("límite de intentos", () => {
  it(`al superar ${LIMIT} intentos: código rate_limited y mensaje de espera, incluso con la contraseña correcta`, async () => {
    const u = await createUser("bruta@l.com", "Clave-12345");
    for (let i = 0; i < LIMIT; i++) expect((await attempt("bruta@l.com", "Mala-12345")).code).toBe("credentials");

    const blocked = await attempt("bruta@l.com", "Mala-12345");
    expect([blocked.error, blocked.code]).toEqual(["CredentialsSignin", "rate_limited"]);
    expect(blocked.message).toBe(LOGIN_MESSAGES.rateLimited);
    expect(blocked.url).not.toMatch(/Configuration|Demasiadas|\d+s/); // sin tiempos ni textos internos en la URL

    const correct = await attempt("bruta@l.com", "Clave-12345"); // la protección se mantiene
    expect(correct.code).toBe("rate_limited");
    expect(correct.sessionCookie).toBe(false);
    expect(await t.prisma.session.count({ where: { userId: u.id } })).toBe(0);
  }, 30_000);

  it("el bloqueo no permite enumerar: igual para un email inexistente", async () => {
    for (let i = 0; i < LIMIT; i++) await attempt("fantasma@l.com", "Mala-12345");
    const r = await attempt("fantasma@l.com", "Mala-12345");
    expect([r.error, r.code, r.message]).toEqual(["CredentialsSignin", "rate_limited", LOGIN_MESSAGES.rateLimited]);
  }, 30_000);

  it("el límite es por email: otra cuenta no se ve afectada", async () => {
    await createUser("vecina@l.com", "Clave-12345");
    expect((await attempt("vecina@l.com", "Clave-12345")).message).toBeNull();
  });

  it("la política no cambia: 10 intentos por ventana de 15 minutos", async () => {
    await createUser("ventana@l.com", "Clave-12345");
    for (let i = 0; i < LIMIT; i++) await attempt("ventana@l.com", "Mala-12345");
    const row = await t.prisma.rateLimit.findUniqueOrThrow({ where: { key: emailKey("ventana@l.com") } });
    expect(row.count).toBe(LIMIT);
    expect((await attempt("ventana@l.com", "Mala-12345")).code).toBe("rate_limited");
    // Ventana vencida (más de 15 min): el contador se reinicia y vuelve a responder «credenciales».
    await t.prisma.rateLimit.update({ where: { key: emailKey("ventana@l.com") }, data: { windowStart: new Date(Date.now() - 15 * 60_000 - 1000) } });
    expect((await attempt("ventana@l.com", "Mala-12345")).code).toBe("credentials");
  }, 30_000);
});

describe("errores inesperados", () => {
  it("si falla la base de datos en el rate limit: error genérico, sin detalles internos ni sesión", async () => {
    await createUser("caida@l.com", "Clave-12345");
    const spy = vi.spyOn(t.prisma, "$queryRaw").mockRejectedValueOnce(new Error("conexión con Neon perdida"));
    const r = await attempt("caida@l.com", "Clave-12345");
    spy.mockRestore();
    expect(r.error).toBe("Configuration");
    expect(r.code).toBeUndefined();
    expect(r.url).not.toMatch(/Neon|conexi/);
    expect(r.message).toBe(LOGIN_MESSAGES.unexpected);
    expect(r.sessionCookie).toBe(false);
  });

  it("si falla la base de datos al comprobar las credenciales: mismo error genérico", async () => {
    await createUser("caida2@l.com", "Clave-12345");
    const spy = vi.spyOn(t.prisma.user, "findUnique").mockRejectedValueOnce(new Error("timeout"));
    const r = await attempt("caida2@l.com", "Clave-12345");
    spy.mockRestore();
    expect([r.error, r.message]).toEqual(["Configuration", LOGIN_MESSAGES.unexpected]);
  });
});
