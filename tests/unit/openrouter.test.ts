import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const schema = z.object({ items: z.array(z.object({ name: z.string() })) });
const ok = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 11, completion_tokens: 7 } }), { status: 200 });

beforeEach(() => {
  vi.resetModules();
  Object.assign(process.env, { DATABASE_URL: "postgres://x", AUTH_SECRET: "x".repeat(32), CLOUDINARY_CLOUD_NAME: "c", CLOUDINARY_API_KEY: "k", CLOUDINARY_API_SECRET: "s", OPENROUTER_API_KEY: "or-test" });
});
afterEach(() => { vi.unstubAllGlobals(); delete process.env.OPENROUTER_API_KEY; });

describe("chat (OpenRouter)", () => {
  it("pide JSON Schema estricto sin la clave $schema y devuelve texto y uso de tokens", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok('{"items":[]}'));
    vi.stubGlobal("fetch", fetchMock);
    const { chat } = await import("@/lib/openrouter/client");
    const r = await chat({ model: "m", messages: [{ role: "user", content: "hola" }], schema, schemaName: "x" });
    expect(r.text).toBe('{"items":[]}');
    expect(r.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer or-test");
    const body = JSON.parse(init.body as string);
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema.$schema).toBeUndefined();
    expect(body.response_format.json_schema.schema.additionalProperties).toBe(false);
  });

  it("si el modelo rechaza response_format (400) reintenta sin él", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 400 })).mockResolvedValueOnce(ok('{"items":[]}'));
    vi.stubGlobal("fetch", fetchMock);
    const { chat } = await import("@/lib/openrouter/client");
    const r = await chat({ model: "m", messages: [{ role: "user", content: "hola" }], schema });
    expect(r.text).toBe('{"items":[]}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string).response_format).toBeDefined();
    expect(JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string).response_format).toBeUndefined();
  });

  it("un 4xx sin schema no se reintenta y no filtra detalles", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("clave inválida sk-secreta", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const { chat } = await import("@/lib/openrouter/client");
    await expect(chat({ model: "m", messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ status: 502, code: "AI_UPSTREAM" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falla con claridad si falta la clave", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const { chat } = await import("@/lib/openrouter/client");
    await expect(chat({ model: "m", messages: [] })).rejects.toMatchObject({ code: "AI_NOT_CONFIGURED" });
  });

  it("parseJson tolera vallas de código y valida con Zod", async () => {
    const { parseJson, asAiError } = await import("@/lib/openrouter/client");
    expect(parseJson('```json\n{"items":[{"name":"a"}]}\n```', schema).items).toHaveLength(1);
    expect(() => parseJson('{"items":[{"name":5}]}', schema)).toThrow();
    expect(asAiError(new SyntaxError("x"))).toMatchObject({ status: 502, code: "AI_INVALID" });
  });

  it("OPENROUTER_MODEL es el valor por defecto de las tres tareas y las específicas lo sustituyen", async () => {
    process.env.OPENROUTER_MODEL = "proveedor/modelo-comun";
    process.env.OPENROUTER_MODEL_CHEAP = "proveedor/barato";
    const { env } = await import("@/lib/env");
    expect(env()).toMatchObject({ OPENROUTER_MODEL_VISION: "proveedor/modelo-comun", OPENROUTER_MODEL_STYLIST: "proveedor/modelo-comun", OPENROUTER_MODEL_CHEAP: "proveedor/barato" });
    delete process.env.OPENROUTER_MODEL; delete process.env.OPENROUTER_MODEL_CHEAP;
  });
});
