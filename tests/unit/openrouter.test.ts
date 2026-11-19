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

/** ¿Pudo facturarse alguna llamada? Lo usa el análisis de prendas para decidir si devuelve la unidad de cuota. */
describe("chat: maybeBilled", () => {
  const msgs = [{ role: "user" as const, content: "x" }];
  /** Ejecuta chat con fetch simulado (temporizadores falsos para no esperar los reintentos) y devuelve el error. */
  const run = async (fetchMock: ReturnType<typeof vi.fn>, opts: { schema?: boolean } = {}) => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", fetchMock);
      const { chat, AiProviderError } = await import("@/lib/openrouter/client");
      const p = chat({ model: "m", messages: msgs, ...(opts.schema && { schema }) }).then(() => null, (e: unknown) => e);
      await vi.runAllTimersAsync();
      const err = await p;
      expect(err).toBeInstanceOf(AiProviderError);
      return err as InstanceType<typeof AiProviderError>;
    } finally {
      vi.useRealTimers();
    }
  };
  const status = (s: number, body = "x") => () => Promise.resolve(new Response(body, { status: s }));
  const always = (s: number) => vi.fn(status(s));

  it.each([400, 401, 402])("rechazo documentado como previo al procesamiento (%i) → no facturado, sin reintentos", async (s) => {
    const f = always(s);
    expect(await run(f)).toMatchObject({ status: 502, code: "AI_UPSTREAM", maybeBilled: false }); // mismo código y estado que antes
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("400 por response_format y luego 401 → reintento sin schema, ambos rechazos previos: no facturado", async () => {
    const f = vi.fn().mockImplementationOnce(status(400)).mockImplementationOnce(status(401));
    expect(await run(f, { schema: true })).toMatchObject({ code: "AI_UPSTREAM", maybeBilled: false });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("403 → dudoso (rechazos de distinto tipo, no todos garantizados como previos), sin reintentos", async () => {
    const f = always(403);
    expect(await run(f)).toMatchObject({ status: 502, code: "AI_UPSTREAM", maybeBilled: true });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("408 → dudoso (el proveedor no respondió a tiempo), sin reintentos", async () => {
    const f = always(408);
    expect(await run(f)).toMatchObject({ code: "AI_UPSTREAM", maybeBilled: true });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it.each([429, 500, 502, 503, 504])("%i en todos los intentos → dudoso (mismo código y número de reintentos que antes)", async (s) => {
    const f = always(s);
    expect(await run(f)).toMatchObject({ status: 502, code: "AI_UNAVAILABLE", maybeBilled: true });
    expect(f).toHaveBeenCalledTimes(3);
  });

  it.each([404, 409, 413, 418, 422, 499])("estado no clasificado como rechazo previo (%i) → dudoso", async (s) => {
    expect(await run(always(s))).toMatchObject({ code: "AI_UPSTREAM", maybeBilled: true });
  });

  it("error de red → dudoso", async () => {
    expect(await run(vi.fn().mockRejectedValue(new TypeError("fetch failed")))).toMatchObject({ code: "AI_UNAVAILABLE", maybeBilled: true });
  });

  it("timeout (AbortSignal.timeout) → dudoso", async () => {
    expect(await run(vi.fn().mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError")))).toMatchObject({ maybeBilled: true });
  });

  it("200 sin contenido o con un error en el cuerpo → el proveedor aceptó la petición: dudoso", async () => {
    expect(await run(vi.fn(() => Promise.resolve(new Response(JSON.stringify({ choices: [] }), { status: 200 }))))).toMatchObject({ maybeBilled: true });
    expect(await run(vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: { message: "provider disconnect" } }), { status: 200 }))))).toMatchObject({ maybeBilled: true });
  });

  it("un intento dudoso seguido de un rechazo previo (401) → sigue dudoso", async () => {
    for (const first of [status(500), status(503), status(429), () => Promise.reject(new TypeError("fetch failed"))]) {
      const f = vi.fn().mockImplementationOnce(first).mockImplementationOnce(status(401));
      expect(await run(f)).toMatchObject({ code: "AI_UPSTREAM", maybeBilled: true });
      expect(f).toHaveBeenCalledTimes(2);
    }
  });

  it("un intento dudoso seguido de un 403 → dudoso", async () => {
    for (const first of [status(500), status(503), status(429), () => Promise.reject(new TypeError("fetch failed"))]) {
      const f = vi.fn().mockImplementationOnce(first).mockImplementationOnce(status(403));
      expect(await run(f)).toMatchObject({ code: "AI_UPSTREAM", maybeBilled: true });
      expect(f).toHaveBeenCalledTimes(2);
    }
  });
});
