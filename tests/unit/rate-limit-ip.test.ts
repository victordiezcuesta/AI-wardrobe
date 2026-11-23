import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fase 19.12f.2 — rateLimitByIp. `rateLimit` está simulado (sin base de datos). El módulo mantiene un indicador de
 * «ya avisado» por proceso: cada prueba importa una copia NUEVA (vi.resetModules) para que el estado no se filtre entre
 * pruebas, y el contador de llamadas se reinicia en cada una.
 */
const rl = vi.hoisted(() => ({ rateLimit: vi.fn(async (..._a: unknown[]) => undefined) }));
vi.mock("@/lib/rate-limit/index", () => ({ rateLimit: rl.rateLimit }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: rl.rateLimit }));

type Mod = typeof import("@/lib/rate-limit/ip");
let mod: Mod;
let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  vi.resetModules();
  rl.rateLimit.mockReset(); rl.rateLimit.mockResolvedValue(undefined);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  mod = await import("@/lib/rate-limit/ip");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const req = (headers: Record<string, string> = {}) => new Request("http://localhost:3000/api/auth/register", { method: "POST", headers });
const warnings = () => errSpy.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.includes("rate_limit.ip_unavailable"));

describe("con IP fiable (VERCEL=1)", () => {
  beforeEach(() => { vi.stubEnv("VERCEL", "1"); });

  it("IPv4: llama UNA vez a rateLimit con la clave y los parámetros exactos", async () => {
    await mod.rateLimitByIp(req({ "x-forwarded-for": "203.0.113.7" }), "register", 5, 3600);
    expect(rl.rateLimit).toHaveBeenCalledTimes(1);
    expect(rl.rateLimit).toHaveBeenCalledWith("register:v4:203.0.113.7", 5, 3600);
  });
  it("IPv6: usa la clave canónica del resolvedor (/64)", async () => {
    await mod.rateLimitByIp(req({ "x-forwarded-for": "2001:DB8:85a3:8d3:1319:8a2e:370:7344" }), "forgot", 5, 3600);
    expect(rl.rateLimit).toHaveBeenCalledTimes(1);
    expect(rl.rateLimit).toHaveBeenCalledWith("forgot:v6:2001:db8:85a3:8d3", 5, 3600);
  });
  it("IPv4-mapped IPv6: misma clave que la IPv4", async () => {
    await mod.rateLimitByIp(req({ "x-forwarded-for": "::ffff:203.0.113.7" }), "reset", 10, 3600);
    expect(rl.rateLimit).toHaveBeenCalledWith("reset:v4:203.0.113.7", 10, 3600);
  });
  it("cada scope y cada parámetro se pasan tal cual", async () => {
    await mod.rateLimitByIp(req({ "x-forwarded-for": "198.51.100.9" }), "verify", 20, 3600);
    await mod.rateLimitByIp(req({ "x-forwarded-for": "198.51.100.9" }), "otro", 1, 60);
    expect(rl.rateLimit.mock.calls).toEqual([["verify:v4:198.51.100.9", 20, 3600], ["otro:v4:198.51.100.9", 1, 60]]);
  });
  it("IP distintas → claves distintas", async () => {
    await mod.rateLimitByIp(req({ "x-forwarded-for": "203.0.113.7" }), "register", 5, 3600);
    await mod.rateLimitByIp(req({ "x-forwarded-for": "203.0.113.8" }), "register", 5, 3600);
    expect(rl.rateLimit.mock.calls.map((c) => c[0])).toEqual(["register:v4:203.0.113.7", "register:v4:203.0.113.8"]);
  });
  it("con IP válida no emite ningún aviso", async () => {
    await mod.rateLimitByIp(req({ "x-forwarded-for": "203.0.113.7" }), "register", 5, 3600);
    expect(warnings()).toEqual([]);
  });
});

describe("errores de rateLimit: se propagan", () => {
  beforeEach(() => { vi.stubEnv("VERCEL", "1"); });
  it("el 429 llega tal cual al llamador", async () => {
    const limited = Object.assign(new Error("Demasiadas solicitudes"), { status: 429, code: "RATE_LIMITED" });
    rl.rateLimit.mockRejectedValueOnce(limited);
    await expect(mod.rateLimitByIp(req({ "x-forwarded-for": "203.0.113.7" }), "register", 5, 3600)).rejects.toBe(limited);
  });
  it("un error de almacenamiento llega tal cual (no se convierte en éxito)", async () => {
    const boom = Object.assign(new Error("db caída"), { code: "P1001" });
    rl.rateLimit.mockRejectedValueOnce(boom);
    await expect(mod.rateLimitByIp(req({ "x-forwarded-for": "203.0.113.7" }), "register", 5, 3600)).rejects.toBe(boom);
  });
  it("tampoco se reintenta: una sola llamada aunque falle", async () => {
    rl.rateLimit.mockRejectedValue(new Error("x"));
    await mod.rateLimitByIp(req({ "x-forwarded-for": "203.0.113.7" }), "register", 5, 3600).catch(() => undefined);
    expect(rl.rateLimit).toHaveBeenCalledTimes(1);
  });
});

describe("sin IP resoluble: rateLimit no se llama nunca", () => {
  it.each([
    ["sin VERCEL", {}, { "x-forwarded-for": "203.0.113.7" }],
    ["VERCEL=0", { VERCEL: "0" }, { "x-forwarded-for": "203.0.113.7" }],
    ["VERCEL vacío", { VERCEL: "" }, { "x-forwarded-for": "203.0.113.7" }],
    ["Vercel sin cabecera", { VERCEL: "1" }, {}],
    ["Vercel con varias IP", { VERCEL: "1" }, { "x-forwarded-for": "203.0.113.7, 198.51.100.9" }],
    ["Vercel con IP inválida", { VERCEL: "1" }, { "x-forwarded-for": "unknown" }],
    ["Vercel con puerto", { VERCEL: "1" }, { "x-forwarded-for": "203.0.113.7:80" }],
    ["Vercel con cabeceras alternativas", { VERCEL: "1" }, { "x-real-ip": "203.0.113.7", "x-vercel-forwarded-for": "203.0.113.7", forwarded: "for=203.0.113.7" }],
  ] as const)("%s", async (_n, env, headers) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    if (!("VERCEL" in env)) vi.stubEnv("VERCEL", "");
    await expect(mod.rateLimitByIp(req(headers as Record<string, string>), "register", 5, 3600)).resolves.toBeUndefined();
    expect(rl.rateLimit).not.toHaveBeenCalled();
  });
  it("nunca usa una clave compartida: ninguna llamada contiene «unknown»", async () => {
    vi.stubEnv("VERCEL", "1");
    for (let i = 0; i < 5; i++) await mod.rateLimitByIp(req(), "register", 5, 3600);
    expect(rl.rateLimit).not.toHaveBeenCalled();
  });
});

describe("aviso de configuración", () => {
  it("Vercel sin IP: se emite UNA sola vez aunque se invoque muchas veces (distintas peticiones y scopes)", async () => {
    vi.stubEnv("VERCEL", "1");
    for (let i = 0; i < 10; i++) await mod.rateLimitByIp(req(), ["register", "forgot", "reset", "verify"][i % 4]!, 5, 3600);
    expect(warnings()).toHaveLength(1);
  });
  it("el aviso no se repite aunque llegue una IP válida entre medias y luego otra ausente", async () => {
    vi.stubEnv("VERCEL", "1");
    await mod.rateLimitByIp(req(), "register", 5, 3600);
    await mod.rateLimitByIp(req({ "x-forwarded-for": "203.0.113.7" }), "register", 5, 3600);
    await mod.rateLimitByIp(req({ "x-forwarded-for": "basura" }), "register", 5, 3600);
    expect(warnings()).toHaveLength(1);
  });
  it("una copia nueva del módulo (otro proceso) vuelve a avisar una vez", async () => {
    vi.stubEnv("VERCEL", "1");
    await mod.rateLimitByIp(req(), "register", 5, 3600);
    expect(warnings()).toHaveLength(1);
    vi.resetModules();
    const fresh = await import("@/lib/rate-limit/ip");
    await fresh.rateLimitByIp(req(), "register", 5, 3600);
    await fresh.rateLimitByIp(req(), "register", 5, 3600);
    expect(warnings()).toHaveLength(2);
  });
  it.each([["sin VERCEL", ""], ["VERCEL=0", "0"], ["VERCEL=true", "true"]])("%s (local o autoalojado): sin aviso", async (_n, v) => {
    vi.stubEnv("VERCEL", v);
    for (let i = 0; i < 3; i++) await mod.rateLimitByIp(req(), "register", 5, 3600);
    await mod.rateLimitByIp(req({ "x-forwarded-for": "203.0.113.7" }), "register", 5, 3600);
    expect(warnings()).toEqual([]);
    expect(errSpy).not.toHaveBeenCalled();
  });
  it("en local, tampoco al saltar el aviso se marca como emitido: un cambio posterior a Vercel sí avisa", async () => {
    vi.stubEnv("VERCEL", "");
    await mod.rateLimitByIp(req(), "register", 5, 3600);
    vi.stubEnv("VERCEL", "1");
    await mod.rateLimitByIp(req(), "register", 5, 3600);
    expect(warnings()).toHaveLength(1);
  });
  it("el aviso es genérico: sin IP, cabeceras, scope ni datos de la petición", async () => {
    vi.stubEnv("VERCEL", "1");
    await mod.rateLimitByIp(
      new Request("http://localhost:3000/api/auth/register?token=SECRETO", { method: "POST", headers: {
        "x-forwarded-for": "203.0.113.7, 198.51.100.9", authorization: "Bearer SECRETO-TOKEN", cookie: "session=SECRETO", "user-agent": "agente-secreto", "x-real-ip": "192.0.2.1",
      } }),
      "register-secreto", 5, 3600,
    );
    const [line] = warnings();
    expect(line).toBeDefined();
    const entry = JSON.parse(line!) as { scope: string; message: string };
    expect(entry.scope).toBe("rate_limit.ip_unavailable");
    expect(entry.message).toBe("Sin IP fiable en Vercel: el límite por IP está desactivado en esta petición");
    for (const secret of ["203.0.113.7", "198.51.100.9", "192.0.2.1", "SECRETO", "agente-secreto", "register-secreto", "localhost", "authorization", "cookie"]) {
      expect(line, secret).not.toContain(secret);
    }
  });
  it("un fallo del log nunca afecta a la petición", async () => {
    vi.stubEnv("VERCEL", "1");
    errSpy.mockImplementation(() => { throw new Error("log roto"); });
    await expect(mod.rateLimitByIp(req(), "register", 5, 3600)).resolves.toBeUndefined();
    expect(rl.rateLimit).not.toHaveBeenCalled();
  });
});
