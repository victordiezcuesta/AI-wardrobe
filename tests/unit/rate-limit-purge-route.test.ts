import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fase 19.14c — GET /api/cron/rate-limit-purge con el servicio SIMULADO: se comprueba la autorización, la proyección de la
 * respuesta y el tratamiento de errores. La autorización es la REAL (`isAuthorizedCron`); su comparación en tiempo constante
 * ya está cubierta en cron-auth.test.ts y aquí no se repite. El comportamiento del servicio con una base de datos real está en
 * tests/integration/rate-limit-purge.test.ts y tests/integration/rate-limit-purge-route.test.ts.
 */
const envState = vi.hoisted(() => ({ secret: undefined as string | undefined }));
vi.mock("@/lib/env", () => ({ env: () => ({ CRON_SECRET: envState.secret }) }));
// Cualquier acceso a la base de datos desde la ruta (fuera del servicio simulado) haría fallar la prueba.
vi.mock("@/lib/prisma", () => ({ prisma: new Proxy({}, { get() { throw new Error("acceso a la base de datos desde la ruta"); } }) }));
const purge = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/services/rate-limit-purge.service", () => ({ purgeExpiredRateLimits: (...a: unknown[]) => purge.fn(...a) }));

import * as route from "@/app/api/cron/rate-limit-purge/route";

const SECRET = ["cron", "prueba", "0123456789abcdef"].join("-"); // ficticio (sin literal: regla de higiene)
const URL_BASE = "http://localhost:3000/api/cron/rate-limit-purge";
const call = (auth?: string, query = "") => route.GET(new Request(`${URL_BASE}${query}`, { headers: auth === undefined ? {} : { authorization: auth } }));
let errSpy: ReturnType<typeof vi.spyOn>; let logSpies: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  envState.secret = SECRET;
  purge.fn.mockReset(); purge.fn.mockResolvedValue({ deleted: 7, batches: 2, complete: true });
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  logSpies = (["log", "info", "warn", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
});
afterEach(() => { envState.secret = undefined; vi.restoreAllMocks(); });

describe("autorización", () => {
  it.each([
    ["sin credenciales", undefined], ["vacía", ""], ["secreto incorrecto", `Bearer ${SECRET.slice(0, -1)}X`], ["sin «Bearer»", SECRET],
    ["más corto", `Bearer ${SECRET.slice(1)}`], ["más largo", `Bearer ${SECRET}x`], ["otro esquema", `Basic ${SECRET}`],
  ])("%s → 401 genérico y el servicio NO se invoca", async (_n, auth) => {
    const res = await call(auth);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "UNAUTHORIZED", message: "No autorizado" } });
    expect(purge.fn).not.toHaveBeenCalled(); // y la base de datos tampoco (su proxy lanzaría)
  });
  it("CRON_SECRET no configurado → 401 incluso con una cabecera «correcta» (fail-closed)", async () => {
    envState.secret = undefined;
    for (const auth of [`Bearer ${SECRET}`, "Bearer ", "Bearer undefined", undefined]) expect((await call(auth)).status, String(auth)).toBe(401);
    expect(purge.fn).not.toHaveBeenCalled();
  });
  it("CRON_SECRET vacío → 401", async () => {
    envState.secret = "";
    expect((await call("Bearer ")).status).toBe(401);
    expect(purge.fn).not.toHaveBeenCalled();
  });
  it("la autorización va antes que la purga: con secreto correcto el servicio se invoca exactamente una vez", async () => {
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(purge.fn).toHaveBeenCalledTimes(1);
  });
});

describe("respuesta", () => {
  it("200 con exactamente { ok, deleted, batches, complete }", async () => {
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, deleted: 7, batches: 2, complete: true });
    expect(Object.keys(body).sort()).toEqual(["batches", "complete", "deleted", "ok"]);
  });
  it("refleja complete false y 0 borradas tal cual", async () => {
    purge.fn.mockResolvedValueOnce({ deleted: 100_000, batches: 20, complete: false });
    expect(await (await call(`Bearer ${SECRET}`)).json()).toEqual({ ok: true, deleted: 100_000, batches: 20, complete: false });
    purge.fn.mockResolvedValueOnce({ deleted: 0, batches: 1, complete: true });
    expect(await (await call(`Bearer ${SECRET}`)).json()).toEqual({ ok: true, deleted: 0, batches: 1, complete: true });
  });
  it("proyecta explícitamente: cualquier campo extra del servicio (claves, emails, IP, hashes) no sale", async () => {
    purge.fn.mockResolvedValueOnce({ deleted: 1, batches: 1, complete: true, keys: ["login:ana@example.com", "register:v4:203.0.113.7"], sample: { key: "forgot-email:0123456789abcdef0123456789abcdef" } });
    const text = await (await call(`Bearer ${SECRET}`)).text();
    expect(JSON.parse(text)).toEqual({ ok: true, deleted: 1, batches: 1, complete: true });
    for (const secret of ["ana@example.com", "203.0.113.7", "0123456789abcdef", "login:", "forgot-email"]) expect(text, secret).not.toContain(secret);
  });
  it("el éxito no escribe nada en logs", async () => {
    await call(`Bearer ${SECRET}`);
    expect([errSpy, ...logSpies].flatMap((s) => s.mock.calls.flat()).map(String).join("")).toBe("");
  });
});

describe("sin configuración desde fuera", () => {
  it("los parámetros de la URL no llegan al servicio: se invoca sin argumentos", async () => {
    await call(`Bearer ${SECRET}`, "?retentionHours=1&batchSize=1&maxBatches=1&budgetMs=1&limit=5&force=true&dryRun=false");
    expect(purge.fn).toHaveBeenCalledTimes(1);
    expect(purge.fn.mock.calls[0]).toEqual([]);
  });
  it("un cuerpo en la petición GET tampoco influye", async () => {
    const req = new Request(URL_BASE, { method: "GET", headers: { authorization: `Bearer ${SECRET}` } });
    await route.GET(req);
    expect(purge.fn.mock.calls[0]).toEqual([]);
  });
  it("sin credenciales los parámetros no cambian el resultado (siguen siendo 401)", async () => {
    expect((await call(undefined, "?retentionHours=0&batchSize=999999")).status).toBe(401);
    expect(purge.fn).not.toHaveBeenCalled();
  });
});

describe("errores del servicio", () => {
  it("un error de base de datos da 500 genérico y el log solo lleva su código, sin claves", async () => {
    const dbError = Object.assign(new Error("Invalid `prisma.$executeRaw()` invocation: key login:secreto@example.com (203.0.113.7) violates"), { name: "PrismaClientKnownRequestError", code: "P2010" });
    purge.fn.mockRejectedValueOnce(dbError);
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: "INTERNAL", message: "Error interno" } });
    const logged = errSpy.mock.calls.flat().map(String).join("\n");
    expect(logged).toContain("P2010");
    for (const secret of ["secreto@example.com", "203.0.113.7", "login:"]) expect(logged, secret).not.toContain(secret);
  });
  it("un error inesperado cualquiera da 500 genérico sin detalles en la respuesta", async () => {
    purge.fn.mockRejectedValueOnce(new Error("detalle interno: login:secreto@example.com"));
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: { code: "INTERNAL", message: "Error interno" } });
    expect(text).not.toContain("secreto");
  });
  it("tras un error, la siguiente petición autorizada vuelve a funcionar (sin estado)", async () => {
    purge.fn.mockRejectedValueOnce(new Error("x"));
    expect((await call(`Bearer ${SECRET}`)).status).toBe(500);
    expect((await call(`Bearer ${SECRET}`)).status).toBe(200);
  });
});

describe("contrato del módulo", () => {
  it("solo exporta GET y maxDuration = 60: los demás métodos HTTP no existen (Next responde 405)", () => {
    expect(Object.keys(route).sort()).toEqual(["GET", "maxDuration"]);
    expect(route.maxDuration).toBe(60);
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) expect((route as Record<string, unknown>)[m], m).toBeUndefined();
  });
  it("maxDuration es coherente con el presupuesto del servicio (25 s) con margen para una cota por lote de 17 s", () => {
    expect(route.maxDuration).toBeGreaterThanOrEqual(25 + 17);
  });
});
