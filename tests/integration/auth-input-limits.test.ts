import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import type { PrismaClient } from "@/generated/prisma/client";
import { startTestDb, type TestDb } from "../helpers/db";
import { prismaProxy, setTestEnv } from "../helpers/mock-prisma";

/**
 * Fase 19.17b — límites de longitud de email (254, medido DESPUÉS de normalizar) y de token (20–64) en las rutas reales de
 * registro, recuperación, restablecimiento y verificación, con el servicio, Prisma (PGlite) y el limitador reales. Solo se
 * simula el envío de correo (para capturar el token real del enlace). Se comprueba que el rechazo es el 422 de validación de
 * siempre y que ocurre ANTES de cualquier efecto: sin hash bcrypt, sin consultas ni escrituras, sin correo y sin contador.
 * El login (Auth.js) está en login-ip-limits.test.ts.
 */
const holder = vi.hoisted(() => ({ prisma: null as PrismaClient | null }));
const mail = vi.hoisted(() => ({ sent: [] as { to: string; text: string }[] }));
vi.mock("@/lib/prisma", () => ({ prisma: prismaProxy(holder) }));
// F.2: la ruta de recuperación hace su trabajo en `after()` (ver auth-forgot-password-email-limits.test.ts): se simula y se espera tras responder.
const bg = vi.hoisted(() => ({ jobs: [] as Promise<unknown>[] }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => Promise<unknown>) => { bg.jobs.push(fn()); } }));
const flushAfter = () => Promise.all(bg.jobs.splice(0));
vi.mock("@/lib/mail", () => ({ sendMail: async (to: string, _subject: string, text: string) => { mail.sent.push({ to, text }); } }));

const PASS = "Abcdefghi1";
const NEW_PASS = "Zyxwvutsr9";
const BASE = "http://localhost:3000";
/** Email de exactamente `n` caracteres: local de `n - 8` + «@example.com» (12) → se ajusta la parte local. */
const emailOfLength = (n: number) => `${"a".repeat(n - "@example.com".length)}@example.com`;
const post = (path: string, body: unknown) => new Request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-host": "localhost:3000" }, body: JSON.stringify(body) });

let t: TestDb;
let routes: Record<"register" | "forgot" | "reset" | "verify", (req: Request) => Promise<Response>>;
let hashSpy: ReturnType<typeof vi.spyOn>;
let compareSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
beforeAll(async () => {
  setTestEnv(); t = await startTestDb(); holder.prisma = t.prisma;
  const load = async (m: string) => { const raw = ((await import(m)) as { POST: (req: Request) => Promise<Response> }).POST; return async (req: Request) => { const res = await raw(req); await flushAfter(); return res; }; };
  routes = {
    register: await load("@/app/api/auth/register/route"), forgot: await load("@/app/api/auth/forgot-password/route"),
    reset: await load("@/app/api/auth/reset-password/route"), verify: await load("@/app/api/auth/verify-email/route"),
  };
}, 60_000);
afterAll(async () => { await t?.stop(); });
beforeEach(async () => {
  vi.stubEnv("VERCEL", ""); // sin IP fiable: solo cuentan los límites por email, que es lo que se vigila aquí
  mail.sent.length = 0;
  await t.prisma.$executeRawUnsafe(`TRUNCATE "User", "VerificationToken", "RateLimit" CASCADE`);
  hashSpy = vi.spyOn(bcrypt, "hash");
  compareSpy = vi.spyOn(bcrypt, "compare");
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const rateKeys = async () => (await t.prisma.rateLimit.findMany({ select: { key: true } })).map((r) => r.key);
const tokenRows = () => t.prisma.verificationToken.findMany({ orderBy: { token: "asc" } });
const noEffects = async () => {
  expect(hashSpy).not.toHaveBeenCalled(); expect(compareSpy).not.toHaveBeenCalled(); // sin bcrypt
  expect(mail.sent).toEqual([]);                                                       // sin correo
  expect(await t.prisma.user.count()).toBe(0);                                          // sin escrituras
  expect(await tokenRows()).toEqual([]);
  expect(await rateKeys()).toEqual([]);                                                 // ni contador por email ni por IP
};
const validation = async (res: Response) => {
  expect(res.status).toBe(422);
  const body = (await res.json()) as { error: { code: string; message: string; issues: { path: string; message: string }[] } };
  expect(body.error.code).toBe("VALIDATION");
  return body.error.issues;
};
const tokenFromMail = () => /token=([0-9a-f]+)/.exec(mail.sent.at(-1)!.text)![1]!;
async function verifiedUser(email: string) {
  return t.prisma.user.create({ data: { email, emailVerified: new Date(), passwordHash: await bcrypt.hash(PASS, 4), profile: { create: {} } } });
}

describe("registro: email de hasta 254 caracteres", () => {
  it("un email de 3000 caracteres da 422 antes de bcrypt, consultas, escrituras, correo y del contador por email", async () => {
    const res = await routes.register(post("/api/auth/register", { email: emailOfLength(3000), password: PASS }));
    const issues = await validation(res);
    expect(issues.some((i) => i.path === "email" && /254/.test(i.message))).toBe(true);
    await noEffects();
  });
  it("255 caracteres → 422 sin efectos; 254 → pasa y crea la cuenta", async () => {
    await validation(await routes.register(post("/api/auth/register", { email: emailOfLength(255), password: PASS })));
    await noEffects();
    const ok = await routes.register(post("/api/auth/register", { email: emailOfLength(254), password: PASS }));
    expect(ok.status).toBe(201);
    expect(await t.prisma.user.count({ where: { email: emailOfLength(254) } })).toBe(1);
    expect(mail.sent).toHaveLength(1);
  }, 30_000);
  it("se mide DESPUÉS de normalizar: espacios exteriores y mayúsculas no cuentan ni se guardan", async () => {
    const e254 = emailOfLength(254);
    const res = await routes.register(post("/api/auth/register", { email: `   ${e254.toUpperCase()}   `, password: PASS })); // 260 en bruto, 254 normalizado
    expect(res.status).toBe(201);
    expect((await t.prisma.user.findFirstOrThrow()).email).toBe(e254);
    await t.prisma.$executeRawUnsafe(`TRUNCATE "User", "VerificationToken", "RateLimit" CASCADE`);
    hashSpy.mockClear(); mail.sent.length = 0;
    await validation(await routes.register(post("/api/auth/register", { email: ` ${emailOfLength(255)} `, password: PASS }))); // 257 en bruto, 255 normalizado
    await noEffects();
  }, 30_000);
  it("parte local y etiqueta de dominio excesivas → 422 sin efectos", async () => {
    for (const email of [`${"a".repeat(260)}@x.co`, `a@${"b".repeat(300)}.com`]) {
      await validation(await routes.register(post("/api/auth/register", { email, password: PASS })));
    }
    await noEffects();
  });
});

describe("recuperación: email de hasta 254 caracteres", () => {
  it("255 caracteres → 422 sin efectos (sin consulta de usuario, sin correo, sin token y sin contador por email)", async () => {
    await validation(await routes.forgot(post("/api/auth/forgot-password", { email: emailOfLength(255) })));
    await noEffects();
  });
  it("254 caracteres de una cuenta existente → 200 y se envía el enlace", async () => {
    await verifiedUser(emailOfLength(254));
    const res = await routes.forgot(post("/api/auth/forgot-password", { email: emailOfLength(254) }));
    expect(res.status).toBe(200);
    expect(mail.sent).toHaveLength(1);
    expect(tokenFromMail()).toHaveLength(64);
  });
  it("se mide tras normalizar (espacios y mayúsculas)", async () => {
    await verifiedUser(emailOfLength(254));
    expect((await routes.forgot(post("/api/auth/forgot-password", { email: `  ${emailOfLength(254).toUpperCase()}  ` }))).status).toBe(200);
  });
});

describe("tokens: de 20 a 64 caracteres", () => {
  async function resetToken(email: string) {
    await verifiedUser(email);
    await routes.forgot(post("/api/auth/forgot-password", { email }));
    return tokenFromMail();
  }
  it("restablecimiento: 65 caracteres → 422 sin consumir el token ni cambiar la contraseña; con el token real (64) funciona", async () => {
    const email = "ana@example.com";
    const token = await resetToken(email);
    expect(token).toHaveLength(64);
    const before = { tokens: await tokenRows(), hash: (await t.prisma.user.findUniqueOrThrow({ where: { email } })).passwordHash };
    hashSpy.mockClear();
    const res = await routes.reset(post("/api/auth/reset-password", { token: `${token}a`, password: NEW_PASS }));
    await validation(res);
    expect(await tokenRows()).toEqual(before.tokens);                                         // el token sigue ahí, intacto
    expect((await t.prisma.user.findUniqueOrThrow({ where: { email } })).passwordHash).toBe(before.hash);
    expect(hashSpy).not.toHaveBeenCalled();                                                    // sin hash de la contraseña nueva
    expect((await routes.reset(post("/api/auth/reset-password", { token, password: NEW_PASS }))).status).toBe(200); // 64: válido
    expect(await tokenRows()).toEqual([]);                                                     // ahora sí se consume
  }, 30_000);
  it("verificación: 65 caracteres → 422 sin consumir el token; con el token real (64) verifica el email", async () => {
    await routes.register(post("/api/auth/register", { email: "bea@example.com", password: PASS }));
    const token = tokenFromMail();
    const before = await tokenRows();
    await validation(await routes.verify(post("/api/auth/verify-email", { token: `${token}0` })));
    expect(await tokenRows()).toEqual(before);
    expect((await t.prisma.user.findUniqueOrThrow({ where: { email: "bea@example.com" } })).emailVerified).toBeNull();
    expect((await routes.verify(post("/api/auth/verify-email", { token }))).status).toBe(200);
    expect((await t.prisma.user.findUniqueOrThrow({ where: { email: "bea@example.com" } })).emailVerified).not.toBeNull();
  }, 30_000);
  it("20 caracteres conserva su comportamiento: supera la validación y el servicio responde 400 INVALID_TOKEN", async () => {
    for (const [path, route, body] of [["/api/auth/verify-email", routes.verify, { token: "t".repeat(20) }], ["/api/auth/reset-password", routes.reset, { token: "t".repeat(20), password: NEW_PASS }]] as const) {
      const res = await route(post(path, body));
      expect(res.status, path).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVALID_TOKEN");
    }
  });
  it("19 caracteres sigue siendo 422 (mínimo actual)", async () => {
    await validation(await routes.verify(post("/api/auth/verify-email", { token: "t".repeat(19) })));
    await validation(await routes.reset(post("/api/auth/reset-password", { token: "t".repeat(19), password: NEW_PASS })));
  });
});

describe("contraseñas: máximo 72 bytes UTF-8 (19.17c)", () => {
  const OK = "😀".repeat(17) + "Aa1x";   // 72 bytes (21 unidades UTF-16)
  const TOO_LONG = "😀".repeat(18) + "Aa1"; // 75 bytes
  const passwordIssue = (issues: { path: string; message: string }[]) => expect(issues.some((i) => i.path === "password" && /72 bytes UTF-8/.test(i.message))).toBe(true);
  it("registro con más de 72 bytes → 422 sin bcrypt, usuario, correo, token ni contador", async () => {
    passwordIssue(await validation(await routes.register(post("/api/auth/register", { email: "ana@example.com", password: TOO_LONG }))));
    passwordIssue(await validation(await routes.register(post("/api/auth/register", { email: "ana@example.com", password: `Aa1${"x".repeat(70)}` }))));
    await noEffects();
  });
  it("registro con exactamente 72 bytes funciona y la contraseña completa verifica", async () => {
    expect((await routes.register(post("/api/auth/register", { email: "ana@example.com", password: OK }))).status).toBe(201);
    const u = await t.prisma.user.findUniqueOrThrow({ where: { email: "ana@example.com" } });
    expect(await bcrypt.compare(OK, u.passwordHash!)).toBe(true);
  }, 30_000);
  it("restablecimiento con más de 72 bytes → 422 sin bcrypt, sin cambiar la contraseña y sin consumir el token", async () => {
    const email = "ana@example.com";
    await verifiedUser(email);
    await routes.forgot(post("/api/auth/forgot-password", { email }));
    const token = tokenFromMail();
    const before = { tokens: await tokenRows(), hash: (await t.prisma.user.findUniqueOrThrow({ where: { email } })).passwordHash };
    hashSpy.mockClear(); compareSpy.mockClear();
    passwordIssue(await validation(await routes.reset(post("/api/auth/reset-password", { token, password: TOO_LONG }))));
    expect(hashSpy).not.toHaveBeenCalled(); expect(compareSpy).not.toHaveBeenCalled();
    expect(await tokenRows()).toEqual(before.tokens);
    expect((await t.prisma.user.findUniqueOrThrow({ where: { email } })).passwordHash).toBe(before.hash);
    expect((await routes.reset(post("/api/auth/reset-password", { token, password: OK }))).status).toBe(200); // 72 bytes: válido
    expect(await tokenRows()).toEqual([]);
    const after = await t.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(await bcrypt.compare(OK, after.passwordHash!)).toBe(true);
  }, 30_000);
});
