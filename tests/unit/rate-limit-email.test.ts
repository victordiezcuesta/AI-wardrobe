import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emailRateKey, rateLimitByEmail, EMAIL_RATE_SCOPES } from "@/lib/rate-limit/email";

/**
 * Fase 19.13a — claves pseudonimizadas por email y rateLimitByEmail. `rateLimit` y el entorno están simulados (sin base de
 * datos): AUTH_SECRET se controla desde la prueba porque `env()` real cachea el entorno.
 */
const rl = vi.hoisted(() => ({ rateLimit: vi.fn(async (..._a: unknown[]) => undefined as unknown) }));
vi.mock("@/lib/rate-limit/index", () => ({ rateLimit: rl.rateLimit }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: rl.rateLimit }));
const cfg = vi.hoisted(() => ({ secret: "s".repeat(32) as unknown }));
vi.mock("@/lib/env", () => ({ env: () => ({ AUTH_SECRET: cfg.secret }) }));

const SECRET = "s".repeat(32);
const EMAIL = "ana@example.com";
/** Implementación de referencia INDEPENDIENTE (prueba de respuesta conocida del algoritmo documentado). */
const reference = (secret: string, scope: string, email: string) =>
  createHmac("sha256", createHmac("sha256", secret).update("rate-limit:email-key:v1").digest()).update(`${scope}:${email}`).digest("hex").slice(0, 32);

let spies: ReturnType<typeof vi.spyOn>[];
beforeEach(() => {
  cfg.secret = SECRET;
  rl.rateLimit.mockReset(); rl.rateLimit.mockResolvedValue(undefined);
  spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
});
afterEach(() => { vi.restoreAllMocks(); });

describe("emailRateKey: derivación", () => {
  it("coincide con el algoritmo documentado (HMAC con subclave derivada, 128 bits) y con vectores fijos", () => {
    expect(emailRateKey("register-email", EMAIL)).toBe(`register-email:${reference(SECRET, "register-email", EMAIL)}`);
    expect(emailRateKey("forgot-email", EMAIL)).toBe(`forgot-email:${reference(SECRET, "forgot-email", EMAIL)}`);
    // Vectores fijos (secreto de 32 «s», mensaje firmado "<scope>:<email>"): detectan cualquier cambio accidental del algoritmo.
    expect(emailRateKey("register-email", "ana@example.com")).toBe("register-email:026745d61edc1e3e372e472a05fc9bee");
    expect(emailRateKey("forgot-email", "ana@example.com")).toBe("forgot-email:3de0d5719d11eb1ffa77e29c7eaeb791");
    expect(emailRateKey("forgot-email", "bob@example.org")).toBe("forgot-email:bbde70a2ca562e82a547b36b69e36bfa");
    expect(emailRateKey("register-email", "bob@example.org")).toBe("register-email:2e78d4423626bcb146797875cb3c3d5c");
  });
  it("mismo email y secreto → misma clave, siempre", () => {
    const first = emailRateKey("register-email", EMAIL);
    for (let i = 0; i < 5; i++) expect(emailRateKey("register-email", EMAIL)).toBe(first);
  });
  it("emails distintos → claves distintas", () => {
    const keys = new Set(["ana@example.com", "ana@example.org", "bob@example.com", "ana+tag@example.com", "a.na@example.com"].map((e) => emailRateKey("register-email", e)));
    expect(keys.size).toBe(5);
  });
  it("scopes distintos → claves distintas para el mismo email (registro y recuperación nunca comparten contador)", () => {
    const a = emailRateKey("register-email", EMAIL); const b = emailRateKey("forgot-email", EMAIL);
    expect(a).not.toBe(b);
    expect(a.startsWith("register-email:")).toBe(true); expect(b.startsWith("forgot-email:")).toBe(true);
  });
  it("el MISMO email genera hashes distintos en cada scope (no se pueden correlacionar las filas), no solo prefijos distintos", () => {
    for (const e of [EMAIL, "bob@example.org", "x@y.zz"]) {
      const hashOf = (scope: "register-email" | "forgot-email") => emailRateKey(scope, e).split(":")[1]!;
      expect(hashOf("register-email")).toMatch(/^[0-9a-f]{32}$/);
      expect(hashOf("forgot-email")).toMatch(/^[0-9a-f]{32}$/);
      expect(hashOf("register-email")).not.toBe(hashOf("forgot-email"));
    }
  });
  it("el hash de un scope es estable aunque se calcule el del otro entre medias", () => {
    const first = emailRateKey("register-email", EMAIL);
    emailRateKey("forgot-email", EMAIL);
    expect(emailRateKey("register-email", EMAIL)).toBe(first);
  });
  it("cambiar AUTH_SECRET cambia la clave", () => {
    const a = emailRateKey("register-email", EMAIL);
    cfg.secret = "t".repeat(32);
    const b = emailRateKey("register-email", EMAIL);
    expect(b).not.toBe(a);
    expect(b).toBe(`register-email:${reference("t".repeat(32), "register-email", EMAIL)}`);
    expect(b.split(":")[1]).not.toBe(a.split(":")[1]); // el hash (no solo la clave entera) cambia
  });
  it("la clave no contiene el email, su parte local, su dominio ni «@»", () => {
    for (const e of ["ana@example.com", "persona.larga+etiqueta@dominio-largo.example.org"]) {
      const key = emailRateKey("forgot-email", e);
      expect(key).not.toContain("@");
      expect(key).not.toContain(e);
      expect(key).not.toContain(e.split("@")[0]!);
      expect(key).not.toContain(e.split("@")[1]!);
    }
  });
  it("longitud fija: 32 hex en minúsculas, aunque el email sea muy largo o tenga caracteres raros", () => {
    for (const e of ["a@b.co", "x".repeat(300) + "@example.com", "ñandú@exämple.com", "a".repeat(100_000) + "@x.com"]) {
      const key = emailRateKey("register-email", e);
      expect(key).toMatch(/^register-email:[0-9a-f]{32}$/);
      expect(key).toHaveLength("register-email:".length + 32);
    }
    expect(emailRateKey("forgot-email", EMAIL)).toHaveLength("forgot-email:".length + 32);
  });
  it("normaliza como los esquemas (recorte y minúsculas): las formas equivalentes comparten clave", () => {
    const base = emailRateKey("register-email", "ana@example.com");
    for (const v of ["ANA@EXAMPLE.COM", "  Ana@Example.com ", "\tana@example.com\n"]) expect(emailRateKey("register-email", v)).toBe(base);
  });
  it("no aplica normalizaciones de proveedor: alias +tag y puntos son direcciones distintas", () => {
    expect(emailRateKey("register-email", "ana+1@example.com")).not.toBe(emailRateKey("register-email", "ana@example.com"));
    expect(emailRateKey("register-email", "a.na@example.com")).not.toBe(emailRateKey("register-email", "ana@example.com"));
  });
});

describe("validación de entradas y secreto", () => {
  it.each([["login"], ["register"], ["forgot"], ["Register-Email"], ["register-email "], [""], ["__proto__"], [undefined], [null], [5], [{}], [["register-email"]]])(
    "scope %j no permitido → TypeError", (scope) => {
      expect(() => emailRateKey(scope as never, EMAIL)).toThrow(TypeError);
    });
  it.each([[""], ["   "], ["\n\t"], [undefined], [null], [5], [{}], [["a@b.co"]], [true]])("email %j no válido → TypeError", (email) => {
    expect(() => emailRateKey("register-email", email as never)).toThrow(TypeError);
  });
  it.each([[undefined], [null], [""], ["corto"], ["x".repeat(15)], [12345678901234567890], [{}]])("AUTH_SECRET %j ausente o inválido → falla sin generar clave", (secret) => {
    cfg.secret = secret;
    expect(() => emailRateKey("register-email", EMAIL)).toThrow();
  });
  it("el error por secreto inválido no revela el secreto ni el email", () => {
    cfg.secret = "corto";
    try { emailRateKey("register-email", EMAIL); throw new Error("no debía llegar"); } catch (e) {
      const text = `${(e as Error).message}\n${(e as Error).stack}`;
      expect(text).not.toContain("corto"); expect(text).not.toContain(EMAIL);
    }
  });
  it("un secreto exactamente de 16 caracteres es válido (el mínimo del esquema de entorno)", () => {
    cfg.secret = "k".repeat(16);
    expect(emailRateKey("register-email", EMAIL)).toBe(`register-email:${reference("k".repeat(16), "register-email", EMAIL)}`);
  });
  it("los scopes permitidos son exactamente los dos previstos", () => { expect([...EMAIL_RATE_SCOPES]).toEqual(["register-email", "forgot-email"]); });
});

describe("rateLimitByEmail", () => {
  it("llama EXACTAMENTE una vez a rateLimit con la clave, el límite y la ventana esperados", async () => {
    await rateLimitByEmail("register-email", EMAIL, 3, 3600);
    expect(rl.rateLimit).toHaveBeenCalledTimes(1);
    expect(rl.rateLimit).toHaveBeenCalledWith(`register-email:${reference(SECRET, "register-email", EMAIL)}`, 3, 3600);
  });
  it("cada scope usa su propia clave y los parámetros se pasan tal cual", async () => {
    await rateLimitByEmail("forgot-email", "Bob@Example.org ", 3, 3600);
    await rateLimitByEmail("register-email", "bob@example.org", 2, 60);
    expect(rl.rateLimit.mock.calls).toEqual([[`forgot-email:${reference(SECRET, "forgot-email", "bob@example.org")}`, 3, 3600], [`register-email:${reference(SECRET, "register-email", "bob@example.org")}`, 2, 60]]);
  });
  it("devuelve el resultado original de rateLimit", async () => {
    const sentinel = { marca: "resultado-original" };
    rl.rateLimit.mockResolvedValueOnce(sentinel);
    await expect(rateLimitByEmail("register-email", EMAIL, 3, 3600)).resolves.toBe(sentinel);
    await expect(rateLimitByEmail("register-email", EMAIL, 3, 3600)).resolves.toBeUndefined();
  });
  it("propaga el 429 y los errores de almacenamiento sin alterarlos ni reintentar", async () => {
    const limited = Object.assign(new Error("Demasiadas solicitudes"), { status: 429, code: "RATE_LIMITED" });
    rl.rateLimit.mockRejectedValueOnce(limited);
    await expect(rateLimitByEmail("register-email", EMAIL, 3, 3600)).rejects.toBe(limited);
    const boom = Object.assign(new Error("db caída"), { code: "P1001" });
    rl.rateLimit.mockRejectedValueOnce(boom);
    await expect(rateLimitByEmail("forgot-email", EMAIL, 3, 3600)).rejects.toBe(boom);
    expect(rl.rateLimit).toHaveBeenCalledTimes(2);
  });
  it("propaga también un fallo síncrono del limitador", async () => {
    const boom = new Error("síncrono");
    rl.rateLimit.mockImplementationOnce(() => { throw boom; });
    await expect(rateLimitByEmail("register-email", EMAIL, 3, 3600)).rejects.toBe(boom);
  });
  it("no consulta si existe la cuenta: depende solo del limitador (no hay más dependencias que el entorno)", async () => {
    await rateLimitByEmail("forgot-email", "noexiste@example.com", 3, 3600);
    expect(rl.rateLimit).toHaveBeenCalledTimes(1);
  });
  it.each([["login"], ["register"], [""], [undefined], [null], [5]])("scope %j inválido → TypeError y rateLimit no se llama", async (scope) => {
    await expect(rateLimitByEmail(scope as never, EMAIL, 3, 3600)).rejects.toThrow(TypeError);
    expect(rl.rateLimit).not.toHaveBeenCalled();
  });
  it.each([[0], [-1], [1.5], [Number.NaN], [Infinity], [2_147_483_648], ["3"], [null], [undefined]])("límite %j inválido → TypeError sin llamar a rateLimit", async (limit) => {
    await expect(rateLimitByEmail("register-email", EMAIL, limit as never, 3600)).rejects.toThrow(TypeError);
    expect(rl.rateLimit).not.toHaveBeenCalled();
  });
  it("un bigint no es un límite válido (no serializable en el nombre de la prueba)", async () => {
    await expect(rateLimitByEmail("register-email", EMAIL, 3n as never, 3600)).rejects.toThrow(TypeError);
    await expect(rateLimitByEmail("register-email", EMAIL, 3, 3600n as never)).rejects.toThrow(TypeError);
    expect(rl.rateLimit).not.toHaveBeenCalled();
  });
  it.each([[0], [-1], [1.5], [Number.NaN], [Infinity], [2_147_483_648], ["3600"], [null], [undefined]])("ventana %j inválida → TypeError sin llamar a rateLimit", async (windowSec) => {
    await expect(rateLimitByEmail("register-email", EMAIL, 3, windowSec as never)).rejects.toThrow(TypeError);
    expect(rl.rateLimit).not.toHaveBeenCalled();
  });
  it.each([[""], ["  "], [undefined], [null], [5]])("email %j inválido → TypeError sin llamar a rateLimit", async (email) => {
    await expect(rateLimitByEmail("register-email", email as never, 3, 3600)).rejects.toThrow(TypeError);
    expect(rl.rateLimit).not.toHaveBeenCalled();
  });
  it("sin secreto válido falla (fail-closed) y no llama a rateLimit", async () => {
    cfg.secret = undefined;
    await expect(rateLimitByEmail("register-email", EMAIL, 3, 3600)).rejects.toThrow();
    expect(rl.rateLimit).not.toHaveBeenCalled();
  });
  it("los valores límite válidos (1 y el máximo entero) se aceptan", async () => {
    await rateLimitByEmail("register-email", EMAIL, 1, 1);
    await rateLimitByEmail("register-email", EMAIL, 2_147_483_647, 2_147_483_647);
    expect(rl.rateLimit).toHaveBeenCalledTimes(2);
  });
});

describe("sin filtraciones", () => {
  it("ni el secreto, ni el email, ni el hash aparecen en logs ni en los mensajes de error", async () => {
    const key = emailRateKey("register-email", EMAIL);
    const hash = key.split(":")[1]!;
    const errors: string[] = [];
    const collect = async (fn: () => unknown) => { try { await fn(); } catch (e) { errors.push(`${(e as Error).message}\n${(e as Error).stack ?? ""}`); } };
    await rateLimitByEmail("register-email", EMAIL, 3, 3600);
    await collect(() => rateLimitByEmail("login" as never, EMAIL, 3, 3600));
    await collect(() => rateLimitByEmail("register-email", EMAIL, 0, 3600));
    await collect(() => rateLimitByEmail("register-email", "", 3, 3600));
    await collect(() => emailRateKey("forgot-email", undefined as never));
    cfg.secret = "x";
    await collect(() => rateLimitByEmail("register-email", EMAIL, 3, 3600));
    rl.rateLimit.mockRejectedValueOnce(new Error("fallo"));
    cfg.secret = SECRET;
    await collect(() => rateLimitByEmail("register-email", EMAIL, 3, 3600));
    const logs = spies.flatMap((s) => s.mock.calls.flat()).map(String).join("\n");
    expect(logs).toBe(""); // el helper no escribe nada en consola
    expect(errors.length).toBeGreaterThanOrEqual(5);
    for (const secret of [SECRET, EMAIL, "ana", hash]) for (const text of errors) expect(text, secret).not.toContain(secret);
  });
});
