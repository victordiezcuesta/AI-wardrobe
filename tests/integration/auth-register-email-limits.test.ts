import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { startTestDb, type TestDb } from "../helpers/db";
import { prismaProxy, setTestEnv } from "../helpers/mock-prisma";

/**
 * Fase 19.13b — límite por email en POST /api/auth/register (`register-email`, 3 por 3600 s). Ruta real, limitador real
 * sobre PGlite y `authService.register` espiado. Un envoltorio sobre `@/lib/rate-limit` registra el orden de las llamadas
 * e inyecta fallos de almacenamiento por clave; sin fallos, delega en la implementación real.
 */
const holder = vi.hoisted(() => ({ prisma: null as PrismaClient | null }));
const faults = vi.hoisted(() => ({ failKey: null as ((key: string) => boolean) | null, calls: [] as string[] }));
vi.mock("@/lib/prisma", () => ({ prisma: prismaProxy(holder) }));
// F.3: la ruta de registro hace su trabajo en `after()` (ver auth-forgot-password-email-limits.test.ts): se simula y se espera tras responder.
const bg = vi.hoisted(() => ({ jobs: [] as Promise<unknown>[] }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => Promise<unknown>) => { bg.jobs.push(fn()); } }));
const flushAfter = () => Promise.all(bg.jobs.splice(0));
vi.mock("@/lib/rate-limit", async (orig) => {
  const real = await orig<typeof import("@/lib/rate-limit")>();
  return {
    ...real,
    rateLimit: async (key: string, limit: number, windowSec: number) => {
      faults.calls.push(`${key}|${limit}|${windowSec}`);
      if (faults.failKey?.(key)) throw new Error("fallo de almacenamiento simulado");
      return real.rateLimit(key, limit, windowSec);
    },
  };
});

const IP_A = "203.0.113.7";
const PASS = "Abcdefghi1";
const EMAIL = "ana@example.com";
const OK_JSON = { ok: true, message: "Si el email es válido, recibirás un enlace de confirmación." };
const EMAIL_KEY = /^register-email:[0-9a-f]{32}$/;
const IP_KEY = /^register:/;

let t: TestDb;
let authService: typeof import("@/services/auth.service").authService;
let POST: (req: Request) => Promise<Response>;
let registerSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;
let ipCounter = 0;

beforeAll(async () => {
  setTestEnv(); t = await startTestDb(); holder.prisma = t.prisma;
  ({ authService } = await import("@/services/auth.service"));
  const rawPost = ((await import("@/app/api/auth/register/route")) as { POST: (req: Request) => Promise<Response> }).POST;
  POST = async (req) => { const res = await rawPost(req); await flushAfter(); return res; };
}, 60_000);
afterAll(async () => { await t?.stop(); });
beforeEach(async () => {
  vi.stubEnv("VERCEL", "1");
  faults.failKey = null; faults.calls.length = 0;
  await t.prisma.$executeRawUnsafe(`DELETE FROM "RateLimit"`);
  await t.prisma.$executeRawUnsafe(`DELETE FROM "User"`);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
  registerSpy = vi.spyOn(authService, "register").mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

/** IP distinta en cada llamada (203.0.113.x) para que el límite por IP (5 por hora) no interfiera. */
const freshIp = () => `203.0.113.${(++ipCounter % 250) + 1}`;
function send(o: { email?: unknown; ip?: string | null; origin?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-host": "localhost:3000", ...o.headers };
  const ip = o.ip === undefined ? freshIp() : o.ip;
  if (ip) headers["x-forwarded-for"] = ip;
  if (o.origin) headers.origin = o.origin;
  const req = new Request("http://localhost:3000/api/auth/register", { method: "POST", headers, body: JSON.stringify({ email: o.email ?? EMAIL, password: PASS }) });
  return { req, res: POST(req) };
}
const status = async (p: ReturnType<typeof send>) => (await p.res).status;
const keys = async () => (await t.prisma.rateLimit.findMany({ select: { key: true }, orderBy: { key: "asc" } })).map((r) => r.key);
const emailKeys = async () => (await keys()).filter((k) => k.startsWith("register-email:"));
const ipKeys = async () => (await keys()).filter((k) => IP_KEY.test(k));
const count = async (key: string) => (await t.prisma.rateLimit.findUnique({ where: { key } }))?.count ?? null;
/** El mensaje del 429 incluye los segundos restantes, que varían: se normalizan para comparar cuerpos. */
const normalized = async (res: Response) => JSON.stringify(await res.json()).replace(/\d+s/g, "Ns");

describe("límite por email: 3 por 3600 s", () => {
  it("tres peticiones válidas para el mismo email pasan; la cuarta da 429 y el servicio no se ejecuta", async () => {
    for (let i = 1; i <= 3; i++) {
      const res = await send({ ip: IP_A }).res;
      expect(res.status, `petición ${i}`).toBe(201);
      expect(await res.json()).toEqual(OK_JSON);
    }
    expect(registerSpy).toHaveBeenCalledTimes(3);
    const blocked = await send({ ip: IP_A }).res;
    expect(blocked.status).toBe(429);
    const body = await blocked.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.error.message).toMatch(/^Demasiadas solicitudes\. Inténtalo en \d+s$/); // el mismo formato que el límite por IP
    expect(registerSpy).toHaveBeenCalledTimes(3);
    const [key] = await emailKeys();
    expect(key).toMatch(EMAIL_KEY);
    expect(await count(key!)).toBe(4);
  });
  it("el límite es de 3 con ventana de 3600 s: bloquea a los 3500 s y abre una ventana nueva a los 3700 s", async () => {
    await status(send({ ip: IP_A }));
    const [key] = await emailKeys();
    const seed = (secondsAgo: number) => t.prisma.$executeRawUnsafe(`UPDATE "RateLimit" SET "count" = 3, "windowStart" = NOW() - INTERVAL '${secondsAgo} seconds' WHERE "key" = '${key}'`);
    await seed(3500);
    expect(await status(send({ ip: freshIp() }))).toBe(429);
    await seed(3700);
    expect(await status(send({ ip: freshIp() }))).toBe(201);
    expect(await count(key!)).toBe(1);
  });
  it("las formas equivalentes del email (mayúsculas, espacios) comparten contador", async () => {
    for (const e of ["ana@example.com", "ANA@EXAMPLE.COM", "  Ana@Example.com "]) expect(await status(send({ email: e }))).toBe(201);
    expect(await status(send({ email: "ana@EXAMPLE.com" }))).toBe(429);
    expect(await emailKeys()).toHaveLength(1);
  });
  it("el mismo email desde IP distintas comparte el contador por email", async () => {
    for (let i = 0; i < 3; i++) expect(await status(send({ ip: freshIp() }))).toBe(201);
    expect(await status(send({ ip: freshIp() }))).toBe(429);
    expect(registerSpy).toHaveBeenCalledTimes(3);
  });
  it("emails diferentes tienen contadores independientes", async () => {
    for (let i = 0; i < 3; i++) await status(send({ email: "uno@example.com", ip: freshIp() }));
    expect(await status(send({ email: "uno@example.com", ip: freshIp() }))).toBe(429);
    for (let i = 0; i < 3; i++) expect(await status(send({ email: "dos@example.com", ip: freshIp() })), `dos #${i + 1}`).toBe(201);
    expect(await emailKeys()).toHaveLength(2);
  });
  it("sin IP fiable el límite por email sigue funcionando y no se crea ningún contador por IP", async () => {
    vi.stubEnv("VERCEL", "");
    for (let i = 0; i < 3; i++) expect(await status(send({ ip: null }))).toBe(201);
    expect(await status(send({ ip: null }))).toBe(429);
    expect(registerSpy).toHaveBeenCalledTimes(3);
    expect(await ipKeys()).toEqual([]);
    expect(await emailKeys()).toHaveLength(1);
  });
  it("con cabeceras de IP no fiables (x-real-ip, Forwarded) sigue contando por email", async () => {
    for (let i = 0; i < 3; i++) await status(send({ ip: null, headers: { "x-real-ip": "198.51.100.9", forwarded: "for=198.51.100.9" } }));
    expect(await status(send({ ip: null, headers: { "x-real-ip": "198.51.100.10" } }))).toBe(429);
    expect(await ipKeys()).toEqual([]);
  });
});

describe("orden de los controles", () => {
  it("origen → IP → cuerpo/Zod → email → servicio", async () => {
    const order: string[] = [];
    registerSpy.mockImplementation(async () => { order.push("servicio"); });
    const p = send({ ip: IP_A });
    await p.res;
    expect(faults.calls.map((c) => (IP_KEY.test(c) ? "ip" : c.startsWith("register-email:") ? "email" : "otro"))).toEqual(["ip", "email"]);
    expect(order).toEqual(["servicio"]);
    expect(p.req.bodyUsed).toBe(true);
  });
  it("un origen ajeno da 403 antes de todo: sin contadores (ni IP ni email), sin leer el cuerpo y sin servicio", async () => {
    const p = send({ ip: IP_A, origin: "https://evil.example" });
    expect((await p.res).status).toBe(403);
    expect(await keys()).toEqual([]);
    expect(faults.calls).toEqual([]);
    expect(p.req.bodyUsed).toBe(false);
    expect(registerSpy).not.toHaveBeenCalled();
  });
  it("una petición bloqueada por IP no consume el contador por email (ni lee el cuerpo ni ejecuta el servicio)", async () => {
    await t.prisma.$executeRawUnsafe(`INSERT INTO "RateLimit" ("key", "count", "windowStart") VALUES ('register:v4:${IP_A}', 5, NOW())`);
    const p = send({ ip: IP_A });
    expect((await p.res).status).toBe(429);
    expect(await emailKeys()).toEqual([]);
    expect(faults.calls.every((c) => IP_KEY.test(c))).toBe(true);
    expect(p.req.bodyUsed).toBe(false);
    expect(registerSpy).not.toHaveBeenCalled();
  });
  it("una petición bloqueada por email sí cuenta contra la IP (el límite por IP va antes) y no ejecuta el servicio", async () => {
    for (let i = 0; i < 3; i++) await status(send({ ip: freshIp() }));
    const before = registerSpy.mock.calls.length;
    expect(await status(send({ ip: IP_A }))).toBe(429);
    expect(await count(`register:v4:${IP_A}`)).toBe(1);
    expect(registerSpy.mock.calls.length).toBe(before);
  });
  it("el contador por email ya está contado cuando el servicio se ejecuta", async () => {
    let seen: number | null = null;
    registerSpy.mockImplementation(async () => { const [k] = await emailKeys(); seen = await count(k!); });
    await send({ ip: IP_A }).res;
    expect(seen).toBe(1);
  });
});

describe("emails inválidos", () => {
  it.each([["sin arroba", "no-es-email"], ["vacío", ""], ["solo espacios", "   "], ["sin dominio", "ana@"], ["no es texto", 42], ["objeto", { a: 1 }]])(
    "%s → 422 y ninguna fila por email (el contador por IP sí se cuenta)", async (_n, email) => {
      const res = await send({ email, ip: IP_A }).res;
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VALIDATION");
      expect(await emailKeys()).toEqual([]);
      expect(await count(`register:v4:${IP_A}`)).toBe(1);
      expect(registerSpy).not.toHaveBeenCalled();
    });
});

describe("existencia de la cuenta: no se comprueba ni se revela", () => {
  it("el contador se incrementa igual exista o no la cuenta", async () => {
    await t.prisma.user.create({ data: { email: "existe@example.com", emailVerified: new Date(), passwordHash: "x", profile: { create: {} } } });
    registerSpy.mockRestore(); // servicio real para la cuenta existente (no hace bcrypt ni envía correo: ya está verificada)
    expect(await status(send({ email: "existe@example.com", ip: freshIp() }))).toBe(201);
    registerSpy = vi.spyOn(authService, "register").mockResolvedValue(undefined);
    expect(await status(send({ email: "noexiste@example.com", ip: freshIp() }))).toBe(201);
    const keysNow = await emailKeys();
    expect(keysNow).toHaveLength(2);
    for (const k of keysNow) expect(await count(k)).toBe(1);
  });
  it("el 429 por email es idéntico para un email con cuenta y otro sin ella", async () => {
    await t.prisma.user.create({ data: { email: "existe@example.com", emailVerified: new Date(), passwordHash: "x", profile: { create: {} } } });
    registerSpy.mockRestore();
    const blocked = async (email: string) => {
      let last: Response | null = null;
      for (let i = 0; i < 4; i++) last = await send({ email, ip: freshIp() }).res;
      return last!;
    };
    const withAccount = await blocked("existe@example.com");
    const without = await blocked("noexiste@example.com");
    expect(withAccount.status).toBe(429); expect(without.status).toBe(429);
    expect(await normalized(withAccount)).toBe(await normalized(without));
    expect([...withAccount.headers.keys()].sort()).toEqual([...without.headers.keys()].sort());
    expect(withAccount.headers.get("content-type")).toBe(without.headers.get("content-type"));
  });
  it("las respuestas de éxito son idénticas con y sin cuenta (mensaje y código genéricos)", async () => {
    await t.prisma.user.create({ data: { email: "existe@example.com", emailVerified: new Date(), passwordHash: "x", profile: { create: {} } } });
    registerSpy.mockRestore();
    const a = await send({ email: "existe@example.com", ip: freshIp() }).res;
    const b = await send({ email: "noexiste@example.com", ip: freshIp() }).res;
    expect([a.status, await a.json()]).toEqual([b.status, await b.json()]);
  });
});

describe("privacidad y errores de almacenamiento", () => {
  it("las claves persistidas no contienen el email ni «@»; la respuesta y los logs tampoco", async () => {
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) seen.push(await (await send({ email: EMAIL, ip: freshIp() }).res).text());
    faults.failKey = (k) => k.startsWith("register-email:");
    seen.push(await (await send({ email: EMAIL, ip: freshIp() }).res).text());
    for (const key of await keys()) {
      expect(key).not.toContain("@"); expect(key).not.toContain("ana"); expect(key).not.toContain("example");
    }
    expect((await emailKeys())[0]).toMatch(EMAIL_KEY);
    const logged = [...errSpy.mock.calls, ...infoSpy.mock.calls].flat().map((x: unknown) => (x instanceof Error ? `${x.message}\n${x.stack}` : String(x))).join("\n");
    const hash = (await emailKeys())[0]!.split(":")[1]!;
    for (const secret of [EMAIL, "ana@", hash]) { expect(seen.join("\n"), secret).not.toContain(secret); expect(logged, secret).not.toContain(secret); }
  });
  it("fallo del almacenamiento del contador por email: 500 genérico, sin servicio (fail-closed)", async () => {
    faults.failKey = (k) => k.startsWith("register-email:");
    const res = await send({ ip: IP_A }).res;
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: "INTERNAL", message: "Error interno" } });
    expect(registerSpy).not.toHaveBeenCalled();
  });
  it("fallo del almacenamiento por IP: 500 genérico antes de contar por email y sin servicio", async () => {
    faults.failKey = (k) => IP_KEY.test(k);
    const p = send({ ip: IP_A });
    expect((await p.res).status).toBe(500);
    expect(faults.calls.some((c) => c.startsWith("register-email:"))).toBe(false);
    expect(p.req.bodyUsed).toBe(false);
    expect(registerSpy).not.toHaveBeenCalled();
  });
  it("un error del servicio de registro (ya en `after()`, F.3) no cambia la respuesta pública, se registra y no consume nada más que el contador ya contado", async () => {
    // Antes el servicio corría antes de responder y su fallo daba un 500 (oráculo de existencia de cuenta cuando fallaba solo para
    // algunas). Ahora la respuesta es la misma que en el éxito; el fallo queda en el log, sin datos de la consulta.
    registerSpy.mockRejectedValueOnce(new Error("fallo interno"));
    const res = await send({ ip: IP_A }).res;
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(OK_JSON);
    expect(JSON.stringify(errSpy.mock.calls)).toContain("auth.register.deferred");
    const [k] = await emailKeys();
    expect(await count(k!)).toBe(1);
  });
});

describe("concurrencia", () => {
  it("10 peticiones simultáneas para el mismo email (IP distintas): exactamente 3 llegan al servicio y el resto recibe 429", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => send({ ip: freshIp() }).res));
    const codes = results.map((r) => r.status);
    expect(codes.filter((c) => c === 201)).toHaveLength(3);
    expect(codes.filter((c) => c === 429)).toHaveLength(7);
    expect(registerSpy).toHaveBeenCalledTimes(3);
    const [k] = await emailKeys();
    expect(await count(k!)).toBe(10);
  });
});
