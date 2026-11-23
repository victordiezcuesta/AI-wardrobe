import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import type { PrismaClient } from "@/generated/prisma/client";
import { LOGIN_MESSAGES, loginErrorMessage } from "@/features/authentication/login-errors";
import { startTestDb, type TestDb } from "../helpers/db";
import { prismaProxy, setTestEnv } from "../helpers/mock-prisma";

/**
 * Fase 19.12e — límites por IP y por email del login, de extremo a extremo con Auth.js real (@auth/core), Prisma real
 * sobre PGlite y el rate limiter real. Solo se interpone un envoltorio sobre `@/lib/rate-limit` para INYECTAR fallos de
 * infraestructura por clave; sin fallos configurados delega siempre en la implementación real.
 */
const holder = vi.hoisted(() => ({ prisma: null as PrismaClient | null }));
const faults = vi.hoisted(() => ({ status: null as ((key: string) => boolean) | null, increment: null as ((key: string) => boolean) | null, calls: [] as string[] }));
vi.mock("@/lib/prisma", () => ({ prisma: prismaProxy(holder) }));
vi.mock("@/lib/rate-limit", async (orig) => {
  const real = await orig<typeof import("@/lib/rate-limit")>();
  return {
    ...real,
    rateLimit: async (key: string, limit: number, windowSec: number) => {
      faults.calls.push(`inc:${key}`);
      if (faults.increment?.(key)) throw new Error("fallo de almacenamiento simulado");
      return real.rateLimit(key, limit, windowSec);
    },
    rateLimitStatus: async (key: string, limit: number, windowSec: number) => {
      faults.calls.push(`status:${key}`);
      if (faults.status?.(key)) throw new Error("fallo de almacenamiento simulado");
      return real.rateLimitStatus(key, limit, windowSec);
    },
  };
});

const BASE = "http://localhost:3000";
const SECRET = "x".repeat(32);
const IP_A = "203.0.113.7"; const IP_B = "198.51.100.9";
const KEY_A = `v4:${IP_A}`; const KEY_B = `v4:${IP_B}`;
const PASS = "Abcdefghi1";

let t: TestDb;
let Auth: typeof import("@auth/core").Auth;
let authOptions: typeof import("@/lib/auth").authOptions;
let authService: typeof import("@/services/auth.service").authService;
let compareSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  setTestEnv(); t = await startTestDb(); holder.prisma = t.prisma;
  ({ Auth } = await import("@auth/core"));
  ({ authOptions } = await import("@/lib/auth"));
  ({ authService } = await import("@/services/auth.service"));
}, 60_000);
afterAll(async () => { await t?.stop(); });
beforeEach(async () => {
  vi.stubEnv("VERCEL", "1");
  faults.status = null; faults.increment = null; faults.calls.length = 0;
  await t.prisma.$executeRawUnsafe(`DELETE FROM "RateLimit"`);
  await t.prisma.$executeRawUnsafe(`DELETE FROM "User"`); // cascada: sesiones y perfil
  compareSpy = vi.spyOn(bcrypt, "compare");
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const config = () => ({ ...authOptions, secret: SECRET, basePath: "/api/auth", trustHost: true });
const cookiesOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]!);
interface Attempt { error?: string; code?: string; url: string; sessionCookie: boolean; message: string | null }

/** Intento de login como el de next-auth/react; `headers` añade cabeceras de proxy (x-forwarded-for, etc.). */
async function attempt(email: string, password: string, headers: Record<string, string> = {}): Promise<Attempt> {
  const csrfRes = await Auth(new Request(`${BASE}/api/auth/csrf`), config());
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  const res = await Auth(new Request(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Auth-Return-Redirect": "1", cookie: cookiesOf(csrfRes).join("; "), ...headers },
    body: new URLSearchParams({ csrfToken, email, password, callbackUrl: `${BASE}/dashboard` }),
  }), config());
  const { url } = (await res.json()) as { url: string };
  const params = new URL(url).searchParams;
  const out = { error: params.get("error") ?? undefined, code: params.get("code") ?? undefined };
  return { ...out, url, sessionCookie: cookiesOf(res).some((c) => c.startsWith("authjs.session-token=")), message: loginErrorMessage(out) };
}
const xff = (ip: string) => ({ "x-forwarded-for": ip });
const createUser = async (email: string, verified = true) =>
  t.prisma.user.create({ data: { email, emailVerified: verified ? new Date() : null, passwordHash: await bcrypt.hash(PASS, 4), profile: { create: {} } } });
const count = async (key: string) => (await t.prisma.rateLimit.findUnique({ where: { key } }))?.count ?? null;
const seed = (key: string, n: number) => t.prisma.$executeRawUnsafe(`INSERT INTO "RateLimit" ("key", "count", "windowStart") VALUES ('${key}', ${n}, NOW()) ON CONFLICT ("key") DO UPDATE SET "count" = ${n}, "windowStart" = NOW()`);
const keys = async () => (await t.prisma.rateLimit.findMany({ select: { key: true }, orderBy: { key: "asc" } })).map((r) => r.key);
const RATE_LIMITED = ["CredentialsSignin", "rate_limited"];
const limited = (a: Attempt) => [a.error, a.code];
const configuration = (a: Attempt) => a.error;

describe("resolución de IP: qué contadores se aplican", () => {
  it("en Vercel con x-forwarded-for válido: los tres contadores por IP y el de email", async () => {
    await createUser("a@l.com");
    const r = await attempt("a@l.com", PASS, xff(IP_A));
    expect(r.sessionCookie).toBe(true);
    expect(await count(`login-ip-1m:${KEY_A}`)).toBe(1);
    expect(await count(`login-ip-15m:${KEY_A}`)).toBe(1);
    expect(await count("login:a@l.com")).toBe(1);
    expect(await count(`login-fail-ip:${KEY_A}`)).toBeNull(); // un éxito no cuenta como fallo
    expect(faults.calls[0]).toBe(`status:login-fail-ip:${KEY_A}`);
    expect(faults.calls.slice(1)).toEqual([`inc:login-ip-1m:${KEY_A}`, `inc:login-ip-15m:${KEY_A}`, "inc:login:a@l.com"]); // orden exacto
  });
  it("sin VERCEL (local o autoalojado): solo el contador por email, aunque haya x-forwarded-for", async () => {
    vi.stubEnv("VERCEL", "");
    await createUser("a@l.com");
    await attempt("a@l.com", PASS, xff(IP_A));
    expect(await keys()).toEqual(["login:a@l.com"]);
    expect(faults.calls).toEqual(["inc:login:a@l.com"]);
  });
  it.each([
    ["x-real-ip", { "x-real-ip": IP_A }], ["x-vercel-forwarded-for", { "x-vercel-forwarded-for": IP_A }], ["Forwarded", { forwarded: `for=${IP_A}` }],
    ["todas juntas sin x-forwarded-for", { "x-real-ip": IP_A, "x-vercel-forwarded-for": IP_A, forwarded: `for=${IP_A}` }],
  ])("%s no se usa: solo el contador por email", async (_n, headers) => {
    await createUser("a@l.com");
    await attempt("a@l.com", PASS, headers);
    expect(await keys()).toEqual(["login:a@l.com"]);
  });
  it.each([["varias IP", "203.0.113.7, 198.51.100.9"], ["con puerto", "203.0.113.7:80"], ["texto", "unknown"], ["vacía", ""]])(
    "x-forwarded-for no fiable (%s) → solo el contador por email", async (_n, v) => {
      await createUser("a@l.com");
      await attempt("a@l.com", PASS, xff(v));
      expect(await keys()).toEqual(["login:a@l.com"]);
    });
  it("sin IP, el límite por email sigue aplicándose (10 por 15 min) y bcrypt no se ejecuta al superarlo", async () => {
    vi.stubEnv("VERCEL", "");
    await createUser("a@l.com");
    await seed("login:a@l.com", 10);
    compareSpy.mockClear();
    expect(limited(await attempt("a@l.com", PASS))).toEqual(RATE_LIMITED);
    expect(compareSpy).not.toHaveBeenCalled();
  });
  it("IPv4-mapped IPv6 comparte los contadores con la IPv4 equivalente", async () => {
    await createUser("a@l.com");
    await attempt("a@l.com", PASS, xff(`::ffff:${IP_A}`));
    expect(await count(`login-ip-1m:${KEY_A}`)).toBe(1);
  });
});

describe("bloqueos: bcrypt no se ejecuta y no se consumen contadores posteriores", () => {
  beforeEach(async () => { await createUser("a@l.com"); compareSpy.mockClear(); });

  it("IP bloqueada por fallos (30): rechaza con la contraseña correcta, sin bcrypt y sin incrementar nada", async () => {
    await seed(`login-fail-ip:${KEY_A}`, 30);
    const r = await attempt("a@l.com", PASS, xff(IP_A));
    expect(limited(r)).toEqual(RATE_LIMITED); expect(r.sessionCookie).toBe(false);
    expect(compareSpy).not.toHaveBeenCalled();
    expect(await keys()).toEqual([`login-fail-ip:${KEY_A}`]); // ni 1m, ni 15m, ni email
    expect(await count(`login-fail-ip:${KEY_A}`)).toBe(30);
  });
  it("IP bloqueada por el límite de 1 minuto (20): sin bcrypt; no consume el de 15 min ni el de email", async () => {
    await seed(`login-ip-1m:${KEY_A}`, 20);
    expect(limited(await attempt("a@l.com", PASS, xff(IP_A)))).toEqual(RATE_LIMITED);
    expect(compareSpy).not.toHaveBeenCalled();
    expect(await count(`login-ip-1m:${KEY_A}`)).toBe(21);
    expect(await count(`login-ip-15m:${KEY_A}`)).toBeNull();
    expect(await count("login:a@l.com")).toBeNull();
  });
  it("IP bloqueada por el límite de 15 minutos (120): sin bcrypt; no consume el de email", async () => {
    await seed(`login-ip-15m:${KEY_A}`, 120);
    expect(limited(await attempt("a@l.com", PASS, xff(IP_A)))).toEqual(RATE_LIMITED);
    expect(compareSpy).not.toHaveBeenCalled();
    expect(await count(`login-ip-1m:${KEY_A}`)).toBe(1);
    expect(await count(`login-ip-15m:${KEY_A}`)).toBe(121);
    expect(await count("login:a@l.com")).toBeNull();
  });
  it("email bloqueado (10): sin bcrypt; los contadores de IP ya se habían consumido", async () => {
    await seed("login:a@l.com", 10);
    expect(limited(await attempt("a@l.com", PASS, xff(IP_A)))).toEqual(RATE_LIMITED);
    expect(compareSpy).not.toHaveBeenCalled();
    expect(await count(`login-ip-1m:${KEY_A}`)).toBe(1);
    expect(await count(`login-ip-15m:${KEY_A}`)).toBe(1);
    expect(await count(`login-fail-ip:${KEY_A}`)).toBeNull();
  });
  it("justo por debajo de cada límite se permite el intento (19 / 119 / 29 / 9)", async () => {
    await seed(`login-ip-1m:${KEY_A}`, 19); await seed(`login-ip-15m:${KEY_A}`, 119); await seed(`login-fail-ip:${KEY_A}`, 29); await seed("login:a@l.com", 9);
    const r = await attempt("a@l.com", PASS, xff(IP_A));
    expect(r.sessionCookie).toBe(true);
    expect(compareSpy).toHaveBeenCalledTimes(1);
  });
  it("el bloqueo por IP y el de email devuelven EXACTAMENTE la misma respuesta pública", async () => {
    await seed(`login-fail-ip:${KEY_A}`, 30);
    const byIp = await attempt("a@l.com", PASS, xff(IP_A));
    await t.prisma.$executeRawUnsafe(`DELETE FROM "RateLimit"`);
    await seed("login:a@l.com", 10);
    const byEmail = await attempt("a@l.com", PASS, xff(IP_B));
    expect(limited(byIp)).toEqual(limited(byEmail));
    expect(byIp.message).toBe(LOGIN_MESSAGES.rateLimited); expect(byEmail.message).toBe(LOGIN_MESSAGES.rateLimited);
    expect(byIp.url).toBe(byEmail.url);
  });
  it("el bloqueo no depende de que la cuenta exista: mismo resultado y sin bcrypt para un correo inexistente", async () => {
    await seed(`login-ip-1m:${KEY_A}`, 20);
    const r = await attempt("noexiste@l.com", PASS, xff(IP_A));
    expect(limited(r)).toEqual(RATE_LIMITED);
    expect(compareSpy).not.toHaveBeenCalled();
  });
});

describe("errores de infraestructura: fail-closed (bcrypt no se ejecuta)", () => {
  beforeEach(async () => { await createUser("a@l.com"); compareSpy.mockClear(); });
  it.each([
    ["la consulta de fallos por IP", "status", `login-fail-ip:${KEY_A}`],
    ["el contador de 1 minuto", "increment", `login-ip-1m:${KEY_A}`],
    ["el contador de 15 minutos", "increment", `login-ip-15m:${KEY_A}`],
    ["el contador por email", "increment", "login:a@l.com"],
  ] as const)("falla %s → error interno, sin sesión y sin bcrypt", async (_n, kind, key) => {
    faults[kind] = (k) => k === key;
    const r = await attempt("a@l.com", PASS, xff(IP_A));
    expect(configuration(r)).toBe("Configuration");
    expect(r.sessionCookie).toBe(false);
    expect(compareSpy).not.toHaveBeenCalled();
    expect(r.message).toBe(LOGIN_MESSAGES.unexpected);
  });
  it("un fallo del contador por email sin IP también es fail-closed", async () => {
    vi.stubEnv("VERCEL", "");
    faults.increment = () => true;
    expect(configuration(await attempt("a@l.com", PASS))).toBe("Configuration");
    expect(compareSpy).not.toHaveBeenCalled();
  });
});

describe("credenciales y contador de fallos por IP", () => {
  it("login correcto: comportamiento conservado y sin fallo registrado", async () => {
    const u = await createUser("a@l.com");
    const r = await attempt("a@l.com", PASS, xff(IP_A));
    expect([r.error, r.code, r.sessionCookie]).toEqual([undefined, undefined, true]);
    expect(await t.prisma.session.count({ where: { userId: u.id } })).toBe(1);
    expect(await count(`login-fail-ip:${KEY_A}`)).toBeNull();
  });
  it("contraseña incorrecta: respuesta de siempre y +1 fallo por IP", async () => {
    await createUser("a@l.com");
    const r = await attempt("a@l.com", "Mala-12345", xff(IP_A));
    expect([r.error, r.code]).toEqual(["CredentialsSignin", "credentials"]); // código genérico de Auth.js, distinto de rate_limited
    expect(r.message).toBe(LOGIN_MESSAGES.invalid);
    expect(await count(`login-fail-ip:${KEY_A}`)).toBe(1);
    await attempt("a@l.com", "Mala-12345", xff(IP_A));
    expect(await count(`login-fail-ip:${KEY_A}`)).toBe(2);
  }, 30_000);
  it("usuario inexistente: misma respuesta (se compara contra el hash ficticio) y +1 fallo por IP", async () => {
    const r = await attempt("noexiste@l.com", PASS, xff(IP_A));
    expect([r.error, r.code, r.message]).toEqual(["CredentialsSignin", "credentials", LOGIN_MESSAGES.invalid]);
    expect(compareSpy).toHaveBeenCalledTimes(1); // la comparación se ejecuta siempre: tiempos iguales
    expect(await count(`login-fail-ip:${KEY_A}`)).toBe(1);
  }, 30_000);
  it("email sin confirmar con la contraseña correcta: misma respuesta que un fallo y cuenta como fallo (indistinguible a propósito)", async () => {
    await createUser("sin@l.com", false);
    const r = await attempt("sin@l.com", PASS, xff(IP_A));
    expect([r.error, r.message]).toEqual(["CredentialsSignin", LOGIN_MESSAGES.invalid]);
    expect(await count(`login-fail-ip:${KEY_A}`)).toBe(1);
  });
  it("error INTERNO de autenticación: error de configuración y NO incrementa el contador de fallos", async () => {
    await createUser("a@l.com");
    vi.spyOn(authService, "verifyCredentials").mockRejectedValueOnce(Object.assign(new Error("db caída"), { code: "P1001" }));
    const r = await attempt("a@l.com", PASS, xff(IP_A));
    expect(configuration(r)).toBe("Configuration");
    expect(r.sessionCookie).toBe(false);
    expect(await count(`login-fail-ip:${KEY_A}`)).toBeNull();
    expect(await count(`login-ip-1m:${KEY_A}`)).toBe(1); // el intento sí se contó
  });
  it("fallo al registrar el contador (best-effort): el resultado sigue siendo credenciales incorrectas, nunca éxito ni error interno", async () => {
    await createUser("a@l.com");
    faults.increment = (k) => k.startsWith("login-fail-ip:");
    const bad = await attempt("a@l.com", "Mala-12345", xff(IP_A));
    expect([bad.error, bad.message, bad.sessionCookie]).toEqual(["CredentialsSignin", LOGIN_MESSAGES.invalid, false]);
    expect(await count(`login-fail-ip:${KEY_A}`)).toBeNull();
    const ok = await attempt("a@l.com", PASS, xff(IP_A)); // un login correcto no se ve afectado
    expect(ok.sessionCookie).toBe(true);
    const logged = errSpy.mock.calls.flat().map((x: unknown) => (x instanceof Error ? `${x.message}\n${x.stack}` : String(x))).join("\n");
    expect(logged).not.toContain(IP_A);
    expect(logged).not.toContain("a@l.com");
  }, 30_000);
  it("el incremento de fallos que supera su propio límite tampoco cambia el resultado", async () => {
    await createUser("a@l.com");
    await seed(`login-fail-ip:${KEY_A}`, 29); // pasa la consulta (29 < 30); el fallo lo lleva a 30, que aún no supera el límite
    const r = await attempt("a@l.com", "Mala-12345", xff(IP_A));
    expect(r.message).toBe(LOGIN_MESSAGES.invalid);
    expect(await count(`login-fail-ip:${KEY_A}`)).toBe(30);
    const next = await attempt("a@l.com", PASS, xff(IP_A)); // ahora la IP está bloqueada, incluso con la contraseña correcta
    expect(limited(next)).toEqual(RATE_LIMITED);
  }, 30_000);
  it("un payload inválido no cuenta nada ni ejecuta bcrypt", async () => {
    compareSpy.mockClear();
    await attempt("no-es-un-email", PASS, xff(IP_A));
    expect(await keys()).toEqual([]);
    expect(compareSpy).not.toHaveBeenCalled();
  });
});

describe("aislamiento", () => {
  it("dos IP distintas tienen contadores independientes", async () => {
    await createUser("a@l.com");
    await seed(`login-fail-ip:${KEY_A}`, 30);
    expect(limited(await attempt("a@l.com", PASS, xff(IP_A)))).toEqual(RATE_LIMITED);
    const b = await attempt("a@l.com", PASS, xff(IP_B));
    expect(b.sessionCookie).toBe(true);
    expect(await count(`login-ip-1m:${KEY_B}`)).toBe(1);
    expect(await count(`login-ip-1m:${KEY_A}`)).toBeNull();
  });
  it("una IP no bloquea a otra por fallos de la primera y viceversa", async () => {
    await createUser("a@l.com");
    for (let i = 0; i < 2; i++) await attempt("a@l.com", "Mala-12345", xff(IP_A));
    expect(await count(`login-fail-ip:${KEY_A}`)).toBe(2);
    expect(await count(`login-fail-ip:${KEY_B}`)).toBeNull();
  }, 30_000);
  it("el contador por email conserva su comportamiento: 10 intentos y el undécimo se bloquea, desde IP distintas", async () => {
    await createUser("a@l.com");
    for (let i = 0; i < 10; i++) await attempt("a@l.com", "Mala-12345", xff(i % 2 ? IP_A : IP_B));
    compareSpy.mockClear();
    const r = await attempt("a@l.com", PASS, xff("192.0.2.55"));
    expect(limited(r)).toEqual(RATE_LIMITED);
    expect(compareSpy).not.toHaveBeenCalled();
  }, 60_000);
  it("ninguna IP, clave ni correo aparece en la respuesta pública ni en los logs", async () => {
    await createUser("a@l.com");
    await seed(`login-fail-ip:${KEY_A}`, 30);
    const blocked = await attempt("a@l.com", PASS, xff(IP_A));
    const bad = await attempt("a@l.com", "Mala-12345", xff(IP_B));
    const everything = JSON.stringify([blocked, bad]) + [...errSpy.mock.calls, ...infoSpy.mock.calls].flat().map((x: unknown) => (x instanceof Error ? `${x.message}\n${x.stack}` : String(x))).join("\n");
    for (const secret of [IP_A, IP_B, KEY_A, KEY_B, "login-fail-ip", "login-ip-1m", "login-ip-15m", "a@l.com"]) expect(everything, secret).not.toContain(secret);
  }, 30_000);
  it("no se registra nada por cada login fallido (sin logs propios de este flujo)", async () => {
    await createUser("a@l.com");
    errSpy.mockClear();
    await attempt("a@l.com", "Mala-12345", xff(IP_A));
    const own = errSpy.mock.calls.flat().map(String).filter((s: string) => s.includes("auth.login"));
    expect(own).toEqual([]);
  }, 30_000);
});
