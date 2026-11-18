import { describe, expect, it } from "vitest";
import { assertSameOrigin, handler } from "@/lib/errors";

const req = (method: string, headers: Record<string, string>) => new Request("https://app.example.com/api/x", { method, headers });

describe("assertSameOrigin (CSRF)", () => {
  it("permite lecturas desde cualquier origen", () => {
    expect(() => assertSameOrigin(req("GET", { origin: "https://evil.com", host: "app.example.com" }))).not.toThrow();
  });
  it("permite mutaciones del propio sitio", () => {
    expect(() => assertSameOrigin(req("POST", { origin: "https://app.example.com", host: "app.example.com" }))).not.toThrow();
    expect(() => assertSameOrigin(req("DELETE", { origin: "https://app.example.com", "x-forwarded-host": "app.example.com", host: "interno:3000" }))).not.toThrow();
  });
  it("bloquea mutaciones desde otro origen u origen opaco", () => {
    expect(() => assertSameOrigin(req("POST", { origin: "https://evil.com", host: "app.example.com" }))).toThrowError(/Origen no permitido/);
    expect(() => assertSameOrigin(req("PUT", { origin: "null", host: "app.example.com" }))).toThrowError(/Origen/);
    expect(() => assertSameOrigin(req("PATCH", { origin: "https://app.example.com.evil.com", host: "app.example.com" }))).toThrowError(/Origen/);
  });
});

describe("handler", () => {
  it("responde 403 a una mutación cross-site sin ejecutar la lógica", async () => {
    let ran = false;
    const route = handler("t", async (_r: Request) => { ran = true; return new Response("ok"); });
    const res = await route(req("POST", { origin: "https://evil.com", host: "app.example.com" }));
    expect(res.status).toBe(403);
    expect(ran).toBe(false);
    expect((await res.json()).error.code).toBe("BAD_ORIGIN");
  });
  it("convierte errores inesperados en 500 sin filtrar el mensaje interno", async () => {
    const route = handler("t", async (_r: Request) => { throw new Error("password=hunter2 en 10.0.0.5"); });
    const res = await route(req("GET", {}));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("hunter2");
  });
});
