import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { startTestDb, type TestDb } from "../helpers/db";
import { prismaProxy, setTestEnv } from "../helpers/mock-prisma";

/**
 * Fase 19.12f.3 — registro, recuperación, restablecimiento y verificación de email con el límite por IP fiable.
 * Rutas reales (`handler`, `assertSameOrigin`, Zod), limitador real sobre PGlite y `authService` espiado: lo que se
 * comprueba es SI la operación sensible se ejecuta. Solo se interpone un envoltorio sobre `@/lib/rate-limit` para
 * registrar el orden de las llamadas e INYECTAR fallos de almacenamiento; sin fallos, delega en la implementación real.
 */
const holder = vi.hoisted(() => ({ prisma: null as PrismaClient | null }));
const faults = vi.hoisted(() => ({ fail: false, calls: [] as string[] }));
vi.mock("@/lib/prisma", () => ({ prisma: prismaProxy(holder) }));
vi.mock("@/lib/rate-limit", async (orig) => {
  const real = await orig<typeof import("@/lib/rate-limit")>();
  return {
    ...real,
    rateLimit: async (key: string, limit: number, windowSec: number) => {
      faults.calls.push(`${key}|${limit}|${windowSec}`);
      if (faults.fail) throw new Error("fallo de almacenamiento simulado");
      return real.rateLimit(key, limit, windowSec);
    },
  };
});

const IP_A = "203.0.113.7"; const IP_B = "198.51.100.9";
const PASS = "Abcdefghi1"; const TOKEN = "t".repeat(40);

interface RouteCase {
  name: string; module: string; scope: string; limit: number; service: "register" | "requestReset" | "resetPassword" | "verifyEmail";
  body: unknown; invalidBody: unknown; okStatus: number; okJson: unknown;
}
const ROUTES: RouteCase[] = [
  { name: "register", module: "@/app/api/auth/register/route", scope: "register", limit: 5, service: "register",
    body: { email: "ana@l.com", password: PASS }, invalidBody: { email: "no-es-email", password: "x" }, okStatus: 201,
    okJson: { ok: true, message: "Si el email es válido, recibirás un enlace de confirmación." } },
  { name: "forgot-password", module: "@/app/api/auth/forgot-password/route", scope: "forgot", limit: 5, service: "requestReset",
    body: { email: "ana@l.com" }, invalidBody: { email: "no-es-email" }, okStatus: 200, okJson: { ok: true, message: "Si la cuenta existe, recibirás un enlace." } },
  { name: "reset-password", module: "@/app/api/auth/reset-password/route", scope: "reset", limit: 10, service: "resetPassword",
    body: { token: TOKEN, password: PASS }, invalidBody: { token: "corto", password: "x" }, okStatus: 200, okJson: { ok: true } },
  { name: "verify-email", module: "@/app/api/auth/verify-email/route", scope: "verify", limit: 20, service: "verifyEmail",
    body: { token: TOKEN }, invalidBody: { token: "corto" }, okStatus: 200, okJson: { ok: true } },
];

let t: TestDb;
let authService: typeof import("@/services/auth.service").authService;
const handlers = new Map<string, (req: Request) => Promise<Response>>();
let spies: Record<RouteCase["service"], ReturnType<typeof vi.spyOn>>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  setTestEnv(); t = await startTestDb(); holder.prisma = t.prisma;
  ({ authService } = await import("@/services/auth.service"));
  for (const r of ROUTES) handlers.set(r.name, ((await import(r.module)) as { POST: (req: Request) => Promise<Response> }).POST);
}, 60_000);
afterAll(async () => { await t?.stop(); });
beforeEach(async () => {
  vi.stubEnv("VERCEL", "1");
  faults.fail = false; faults.calls.length = 0;
  await t.prisma.$executeRawUnsafe(`DELETE FROM "RateLimit"`);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  spies = {
    register: vi.spyOn(authService, "register").mockResolvedValue(undefined),
    requestReset: vi.spyOn(authService, "requestReset").mockResolvedValue(undefined),
    resetPassword: vi.spyOn(authService, "resetPassword").mockResolvedValue(undefined),
    verifyEmail: vi.spyOn(authService, "verifyEmail").mockResolvedValue(undefined),
  };
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

/**
 * `register` (19.13b) y `forgot-password` (19.13c) tienen además un límite por email (3 por hora): para que estas pruebas de
 * IP no choquen con él, cada petición a esas rutas usa por defecto un email distinto. El resto de rutas usan su cuerpo fijo.
 */
let seq = 0;
/** Rutas con límite por email además del de IP: register (19.13b) y forgot-password (19.13c), 3 por hora y email. */
const hasEmailLimit = (r: RouteCase) => r.name === "register" || r.name === "forgot-password";
const defaultBody = (r: RouteCase) => {
  if (r.name === "register") return { email: `u${++seq}@l.com`, password: PASS };
  if (r.name === "forgot-password") return { email: `u${++seq}@l.com` };
  return r.body;
};
/** Contadores por IP (los del scope de la ruta sin «-email»); y llamadas al limitador que corresponden a ellos. */
const IP_KEY = /^(register|forgot|reset|verify):/;
const ipKeys = async () => (await keys()).filter((k) => IP_KEY.test(k));
const ipCalls = () => faults.calls.filter((c) => IP_KEY.test(c));
/**
 * Contadores y llamadas al limitador que debe ver cada ruta. En `register` y `forgot-password` conviven el límite por IP y el
 * de email (`register-email:` / `forgot-email:`), así que ahí se filtran los de IP. En las demás rutas NO se filtra nada: cualquier contador o llamada
 * inesperados (fuera de los cuatro scopes de IP) hacen fallar la prueba.
 */
const routeKeys = (r: RouteCase) => (hasEmailLimit(r) ? ipKeys() : keys());
const routeCalls = (r: RouteCase) => (hasEmailLimit(r) ? ipCalls() : faults.calls);

/**
 * Ninguna clave puede quedar oculta por los filtros: toda clave de IP pertenece al scope de ESTA ruta (`<scope>:v4|v6:…`) y,
 * en las rutas con límite por email, cualquier otra clave es exactamente `<scope>-email:` + 32 hex. En el resto de rutas no
 * se admite ninguna clave que no sea de IP.
 */
async function expectOnlyKnownKeys(r: RouteCase) {
  for (const k of await keys()) {
    if (IP_KEY.test(k)) { expect(k, `clave de IP de otra ruta: ${k}`).toMatch(new RegExp(`^${r.scope}:v[46]:`)); continue; }
    expect(hasEmailLimit(r), `clave inesperada en ${r.name}: ${k}`).toBe(true);
    expect(k, `clave de email inesperada en ${r.name}: ${k}`).toMatch(new RegExp(`^${r.scope}-email:[0-9a-f]{32}$`));
  }
}

/** Petición POST; devuelve también el Request para comprobar si su cuerpo llegó a leerse. */
function send(r: RouteCase, o: { ip?: string; headers?: Record<string, string>; body?: unknown; origin?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-host": "localhost:3000", ...o.headers };
  if (o.ip) headers["x-forwarded-for"] = o.ip;
  if (o.origin) headers.origin = o.origin;
  const req = new Request(`http://localhost:3000/api/auth/${r.name}`, { method: "POST", headers, body: JSON.stringify(o.body ?? defaultBody(r)) });
  return { req, res: handlers.get(r.name)!(req) };
}
const status = async (p: ReturnType<typeof send>) => (await p.res).status;
const count = async (key: string) => (await t.prisma.rateLimit.findUnique({ where: { key } }))?.count ?? null;
const keys = async () => (await t.prisma.rateLimit.findMany({ select: { key: true }, orderBy: { key: "asc" } })).map((x) => x.key);
const seed = (key: string, n: number, secondsAgo = 0) =>
  t.prisma.$executeRawUnsafe(`INSERT INTO "RateLimit" ("key", "count", "windowStart") VALUES ('${key}', ${n}, NOW() - INTERVAL '${secondsAgo} seconds') ON CONFLICT ("key") DO UPDATE SET "count" = ${n}, "windowStart" = NOW() - INTERVAL '${secondsAgo} seconds'`);

describe.each(ROUTES)("$name", (r) => {
  const key = (ip = IP_A) => `${r.scope}:v4:${ip}`;

  it(`límite exacto de ${r.limit} por 3600 s y clave «${r.scope}:v4:<ip>»: las ${r.limit} primeras pasan y la siguiente da 429`, async () => {
    for (let i = 1; i <= r.limit; i++) expect(await status(send(r, { ip: IP_A })), `petición ${i}`).toBe(r.okStatus);
    expect(spies[r.service]).toHaveBeenCalledTimes(r.limit);
    const blocked = await send(r, { ip: IP_A }).res;
    expect(blocked.status).toBe(429);
    const body = await blocked.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.error.message).toMatch(/^Demasiadas solicitudes\. Inténtalo en \d+s$/);
    expect(spies[r.service]).toHaveBeenCalledTimes(r.limit); // la operación sensible NO se ejecutó
    expect(await routeKeys(r)).toEqual([key()]);
    expect(await count(key())).toBe(r.limit + 1);
    expect(routeCalls(r).every((c) => c === `${key()}|${r.limit}|3600`)).toBe(true);
    await expectOnlyKnownKeys(r);
  });

  it("ventana de una hora (3600 s): a los 3500 s sigue bloqueada y a los 3700 s se abre una ventana nueva", async () => {
    // Márgenes amplios (±100 s) para que la prueba no dependa de lo que tarde en ejecutarse; el límite exacto de la ventana
    // ya está cubierto en rate-limit-status.test.ts.
    await seed(key(), r.limit, 3500);
    expect(await status(send(r, { ip: IP_A }))).toBe(429);
    await seed(key(), r.limit, 3700);
    expect(await status(send(r, { ip: IP_A }))).toBe(r.okStatus);
    expect(await count(key())).toBe(1);
  });

  it("IP distintas: contadores independientes", async () => {
    await seed(key(IP_A), r.limit);
    expect(await status(send(r, { ip: IP_A }))).toBe(429);
    expect(await status(send(r, { ip: IP_B }))).toBe(r.okStatus);
    expect(await count(key(IP_B))).toBe(1);
    expect(await count(key(IP_A))).toBe(r.limit + 1);
  });

  it("IPv4-mapped IPv6 comparte contador con la IPv4; otra /64 IPv6 usa su propia clave v6", async () => {
    await seed(key(IP_A), r.limit);
    expect(await status(send(r, { ip: `::ffff:${IP_A}` }))).toBe(429);
    expect(await status(send(r, { ip: "2001:db8:85a3:8d3::1" }))).toBe(r.okStatus);
    expect(await count(`${r.scope}:v6:2001:db8:85a3:8d3`)).toBe(1);
  });

  it("IP bloqueada: la operación sensible no se ejecuta y el cuerpo ni se lee (el límite va antes que el parseo)", async () => {
    await seed(key(), r.limit);
    const p = send(r, { ip: IP_A });
    expect((await p.res).status).toBe(429);
    expect(spies[r.service]).not.toHaveBeenCalled();
    expect(p.req.bodyUsed).toBe(false);
  });

  it("un cuerpo inválido ya consumió el contador (límite antes que Zod) y responde 422 con el formato de siempre", async () => {
    const p = send(r, { ip: IP_A, body: r.invalidBody });
    const res = await p.res;
    expect(res.status).toBe(422);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error).toMatchObject({ code: "VALIDATION", message: "Datos no válidos" });
    expect(p.req.bodyUsed).toBe(true);
    expect(await count(key())).toBe(1);
    expect(spies[r.service]).not.toHaveBeenCalled();
  });

  it("respuesta pública correcta con IP válida (código y cuerpo sin cambios)", async () => {
    const res = await send(r, { ip: IP_A }).res;
    expect(res.status).toBe(r.okStatus);
    expect(await res.json()).toEqual(r.okJson);
    expect(spies[r.service]).toHaveBeenCalledTimes(1);
  });

  describe("sin IP fiable: ningún contador por IP", () => {
    it.each([
      ["sin VERCEL (local o autoalojado), aunque haya x-forwarded-for", {}, IP_A, false],
      ["Vercel sin cabecera", {}, undefined, true],
      ["Vercel con varias IP", { "x-forwarded-for": `${IP_A}, ${IP_B}` }, undefined, true],
      ["Vercel con IP inválida", { "x-forwarded-for": "unknown" }, undefined, true],
      ["Vercel con puerto", { "x-forwarded-for": `${IP_A}:8080` }, undefined, true],
      ["Vercel con x-real-ip", { "x-real-ip": IP_A }, undefined, true],
      ["Vercel con x-vercel-forwarded-for", { "x-vercel-forwarded-for": IP_A }, undefined, true],
      ["Vercel con Forwarded", { forwarded: `for=${IP_A}` }, undefined, true],
    ] as const)("%s", async (_n, headers, ip, onVercel) => {
      if (!onVercel) vi.stubEnv("VERCEL", "");
      for (let i = 0; i < r.limit + 5; i++) expect(await status(send(r, { ip, headers: headers as Record<string, string> })), `petición ${i + 1}`).toBe(r.okStatus);
      expect(await routeKeys(r)).toEqual([]);     // ninguna fila RateLimit (con límite por email, ninguna POR IP: la de email es independiente)
      expect(routeCalls(r)).toEqual([]);          // ni siquiera se llamó al limitador (con límite por email, al de IP)
      expect(spies[r.service]).toHaveBeenCalledTimes(r.limit + 5); // y las demás protecciones/pasos siguen funcionando
      await expectOnlyKnownKeys(r);
    });
    it("el resto de protecciones siguen activas: un cuerpo inválido sigue dando 422 y un origen ajeno 403", async () => {
      expect(await status(send(r, { body: r.invalidBody }))).toBe(422);
      const foreign = await send(r, { origin: "https://evil.example" }).res;
      expect(foreign.status).toBe(403);
      expect(((await foreign.json()) as { error: { code: string } }).error.code).toBe("BAD_ORIGIN");
    });
  });

  describe("origen y orden", () => {
    it("un origen ajeno da 403 ANTES del límite: no incrementa ningún contador, no lee el cuerpo ni ejecuta la operación", async () => {
      const p = send(r, { ip: IP_A, origin: "https://evil.example" });
      const res = await p.res;
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("BAD_ORIGIN");
      expect(await keys()).toEqual([]);
      expect(faults.calls).toEqual([]);
      expect(p.req.bodyUsed).toBe(false);
      expect(spies[r.service]).not.toHaveBeenCalled();
    });
    it("el origen propio sí pasa", async () => {
      expect(await status(send(r, { ip: IP_A, origin: "http://localhost:3000" }))).toBe(r.okStatus);
    });
    it("orden: límite → cuerpo → servicio (el servicio se llama tras haber contado y leído)", async () => {
      const order: string[] = [];
      spies[r.service].mockImplementation(async () => { order.push(`servicio(cuenta=${await count(key())},cuerpo leído)`); });
      const p = send(r, { ip: IP_A });
      await p.res;
      expect(routeCalls(r)).toHaveLength(1); // una sola llamada por IP; las demás rutas no llaman a nada más
      expect(order).toEqual(["servicio(cuenta=1,cuerpo leído)"]);
      await expectOnlyKnownKeys(r);
      expect(p.req.bodyUsed).toBe(true);
    });
  });

  describe("fallos de almacenamiento: fail-closed", () => {
    it("500 genérico, sin ejecutar la operación sensible y sin leer el cuerpo", async () => {
      faults.fail = true;
      const p = send(r, { ip: IP_A });
      const res = await p.res;
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: { code: "INTERNAL", message: "Error interno" } });
      expect(spies[r.service]).not.toHaveBeenCalled();
      expect(p.req.bodyUsed).toBe(false);
    });
    it("sin IP fiable no se consulta el almacenamiento por IP: un fallo simulado solo afecta a las rutas con límite por email", async () => {
      faults.fail = true;
      // register y forgot-password también cuentan por email (19.13b/c): ese contador SÍ consulta el almacenamiento y falla en modo seguro.
      expect(await status(send(r, {}))).toBe(hasEmailLimit(r) ? 500 : r.okStatus);
      expect(routeCalls(r)).toEqual([]); // sin IP, ninguna llamada por IP (en las demás rutas, ninguna en absoluto)
      if (!hasEmailLimit(r)) expect(await keys()).toEqual([]);
      await expectOnlyKnownKeys(r);
    });
  });
});

describe("aislamiento entre rutas y datos públicos", () => {
  it("el mismo IP tiene un contador distinto por ruta, con su propio límite", async () => {
    for (const r of ROUTES) await status(send(r, { ip: IP_A }));
    expect(await ipKeys()).toEqual(ROUTES.map((r) => `${r.scope}:v4:${IP_A}`).sort());
    await seed(`register:v4:${IP_A}`, 5);
    expect(await status(send(ROUTES[0]!, { ip: IP_A }))).toBe(429);
    expect(await status(send(ROUTES[3]!, { ip: IP_A }))).toBe(200); // verify: otro contador
  });
  it("ni la IP ni la clave aparecen en las respuestas ni en los logs", async () => {
    const seen: string[] = [];
    for (const r of ROUTES) {
      await seed(`${r.scope}:v4:${IP_A}`, r.limit);
      seen.push(await (await send(r, { ip: IP_A }).res).text()); // 429
      seen.push(await (await send(r, { ip: IP_B }).res).text()); // 200/201
      faults.fail = true;
      seen.push(await (await send(r, { ip: IP_B }).res).text()); // 500
      faults.fail = false;
    }
    const logged = errSpy.mock.calls.flat().map((x: unknown) => (x instanceof Error ? `${x.message}\n${x.stack}` : String(x))).join("\n");
    for (const secret of [IP_A, IP_B, "v4:", "ana@l.com"]) { expect(seen.join("\n"), secret).not.toContain(secret); expect(logged, secret).not.toContain(secret); }
    // Los emails generados por defecto para register y forgot-password (u<n>@l.com) tampoco aparecen.
    expect(seen.join("\n")).not.toMatch(/u\d+@l\.com/); expect(logged).not.toMatch(/u\d+@l\.com/);
  });
});
