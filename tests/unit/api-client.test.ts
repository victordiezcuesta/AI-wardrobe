import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, SESSION_EXPIRED_MESSAGE } from "@/utils/api";

/** Cliente `api()` del navegador ante las respuestas de la API (fetch simulado). */
const reply = (body: string, init: ResponseInit & { redirected?: boolean } = {}) => {
  const res = new Response(body, { headers: { "Content-Type": "application/json" }, ...init });
  if (init.redirected) Object.defineProperty(res, "redirected", { value: true });
  vi.stubGlobal("fetch", vi.fn(async () => res));
};
const caught = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as ApiError; } throw new Error("no lanzó"); };

afterEach(() => vi.unstubAllGlobals());

describe("api()", () => {
  it("401 → ApiError con estado 401, código y mensaje de sesión caducada", async () => {
    reply(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "No autenticado" } }), { status: 401 });
    const e = await caught(api("/api/wardrobe"));
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(401);
    expect(e.code).toBe("UNAUTHORIZED");
    expect(e.message).toBe(SESSION_EXPIRED_MESSAGE);
  });

  it("401 sin cuerpo JSON → igualmente error de sesión", async () => {
    reply("", { status: 401 });
    const e = await caught(api("/api/wardrobe"));
    expect([e.status, e.message]).toEqual([401, SESSION_EXPIRED_MESSAGE]);
  });

  it("errores con el formato del proyecto conservan mensaje, código e issues", async () => {
    reply(JSON.stringify({ error: { code: "VALIDATION", message: "Datos no válidos", issues: [{ path: "name", message: "Requerido" }] } }), { status: 422 });
    const e = await caught(api("/api/wardrobe", { method: "POST", json: {} }));
    expect([e.status, e.code, e.message]).toEqual([422, "VALIDATION", "Datos no válidos"]);
    expect(e.issues).toEqual([{ path: "name", message: "Requerido" }]);
  });

  it("error sin cuerpo JSON → «Error inesperado»", async () => {
    reply("<html>500</html>", { status: 500 });
    const e = await caught(api("/api/wardrobe"));
    expect([e.status, e.message]).toEqual([500, "Error inesperado"]);
  });

  it("respuesta correcta en JSON → devuelve los datos", async () => {
    reply(JSON.stringify({ items: [], nextCursor: null }));
    await expect(api("/api/wardrobe")).resolves.toEqual({ items: [], nextCursor: null });
  });

  it("200 con HTML (p. ej. una redirección seguida hasta /login) → error, no {} silencioso", async () => {
    reply("<!doctype html><title>Login</title>", { status: 200, redirected: true });
    const e = await caught(api("/api/wardrobe"));
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe("INVALID_RESPONSE");
  });
});
