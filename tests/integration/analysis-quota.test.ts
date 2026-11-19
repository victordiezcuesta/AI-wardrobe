import { deflateSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { startTestDb, type TestDb } from "../helpers/db";
import { prismaProxy, setTestEnv } from "../helpers/mock-prisma";

/**
 * Cuota del análisis de prendas de extremo a extremo: POST /api/wardrobe/analyze real (handler → servicios →
 * repositorios → Prisma sobre PGlite) con sesión real. Solo se simula lo externo: Cloudinary, el `fetch` hacia
 * OpenRouter y `next/headers` (no existe fuera de Next).
 */
const holder = vi.hoisted(() => ({ prisma: null as PrismaClient | null }));
const req = vi.hoisted(() => ({ cookie: "" }));
vi.mock("@/lib/prisma", () => ({ prisma: prismaProxy(holder) }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ cookie: req.cookie, host: "localhost:3000", "x-forwarded-proto": "http" }),
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined, delete: () => undefined }),
}));
vi.mock("@/lib/cloudinary", () => {
  let n = 0;
  const stored = () => { n++; return { publicId: `ai-wardrobe/u/wardrobe/img${n}`, url: `https://res.cloudinary.com/demo/img${n}.png`, thumbUrl: `https://res.cloudinary.com/demo/t${n}.png`, width: 64, height: 64 }; };
  return { uploadBuffer: vi.fn(async () => stored()), uploadCrop: vi.fn(async () => stored()), deleteImage: vi.fn(async () => undefined) };
});

const BASE = "http://localhost:3000";
const LIMIT = 60; // AI_DAILY_LIMIT_PER_USER por defecto (no se cambia)
const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";

const ITEM = { name: "Camisa blanca", category: "SHIRT", subcategory: null, primaryColor: "blanco", secondaryColors: [], pattern: null, material: null, style: [], seasons: [], formality: null, occasions: [], visualTraits: [], description: null, confidence: 0.95, uncertainFields: [], box: null };
const ok = (content: unknown = { items: [ITEM] }) =>
  new Response(JSON.stringify({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 100, completion_tokens: 40 } }), { status: 200 });
const httpError = (status: number, body = "error interno del proveedor sk-or-v1-secreto") => new Response(body, { status });

/** Respuestas del proveedor en orden; registra cuántas llamadas recibe. Ignora otros fetch. */
let calls = 0;
function provider(...replies: (() => Response | Promise<Response>)[]) {
  calls = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
    if (String(url) !== OPENROUTER) throw new Error(`fetch inesperado: ${String(url)}`);
    const next = replies[Math.min(calls, replies.length - 1)]!;
    calls++;
    return next();
  }));
}

function png(): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let r = -1; for (const x of b) r = crcTable[(r ^ x) & 255]! ^ (r >>> 8); return (r ^ -1) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(4, 0); ihdr.writeUInt32BE(4, 4); ihdr[8] = 8; ihdr[9] = 2;
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.alloc(4 * 13))), chunk("IEND", Buffer.alloc(0))]));
}

let t: TestDb;
let userId: string;

beforeAll(async () => {
  setTestEnv();
  Object.assign(process.env, { AUTH_URL: BASE, AUTH_TRUST_HOST: "true" });
  t = await startTestDb();
  holder.prisma = t.prisma;
}, 60_000);
afterAll(async () => { await t?.stop(); });
let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const { sessionService } = await import("@/services/session.service");
  const { encode } = await import("@auth/core/jwt");
  const u = await t.prisma.user.create({ data: { email: `q${Math.random().toString(36).slice(2)}@q.com`, passwordHash: "x", profile: { create: {} } } });
  userId = u.id;
  const sid = await sessionService.start(u.id);
  req.cookie = `authjs.session-token=${await encode({ token: { sub: u.id, sid }, secret: "x".repeat(32), salt: "authjs.session-token", maxAge: 3600 })}`;
});
afterEach(() => { errSpy.mockRestore(); vi.unstubAllGlobals(); });

async function analyze(fields: Record<string, string> = {}, file: Uint8Array | null = png()) {
  const { POST } = await import("@/app/api/wardrobe/analyze/route");
  const fd = new FormData();
  if (file) fd.set("file", new File([file as BlobPart], "foto.png", { type: "image/png" }));
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  const res = await POST(new Request(`${BASE}/api/wardrobe/analyze`, { method: "POST", body: fd, headers: { cookie: req.cookie } }));
  return { status: res.status, body: (await res.json()) as { status?: string; reason?: string; items?: { name: string; needsReview: boolean }[]; error?: { code: string; message: string } } };
}
const units = (id = userId) => t.prisma.aiUsageLog.count({ where: { userId: id } });
const rows = (id = userId) => t.prisma.aiUsageLog.findMany({ where: { userId: id } });
const fill = (n: number, id = userId) => t.prisma.aiUsageLog.createMany({ data: Array.from({ length: n }, () => ({ userId: id, task: "OUTFIT_GENERATION" as const, provider: "openrouter", model: "m", success: true })) });

describe("análisis correcto", () => {
  it("consume exactamente una unidad, registrada como éxito con sus tokens", async () => {
    provider(() => ok());
    const r = await analyze();
    expect([r.status, r.body.status, r.body.items?.[0]?.name]).toEqual([200, "ok", "Camisa blanca"]);
    const [log] = await rows();
    expect(await units()).toBe(1);
    expect(log).toMatchObject({ task: "ITEM_ANALYSIS", success: true, inputTokens: 100, outputTokens: 40 });
    expect(log!.latencyMs).not.toBeNull();
  });

  it("si hace falta el reintento interno por salida inválida, sigue siendo UNA unidad (antes, dos)", async () => {
    provider(() => ok("esto no es json"), () => ok());
    const r = await analyze();
    expect(r.body.status).toBe("ok");
    expect(calls).toBe(2);
    expect(await units()).toBe(1);
    expect((await rows())[0]).toMatchObject({ success: true, inputTokens: 200, outputTokens: 80 }); // tokens de ambas llamadas
  });
});

describe("errores previos al análisis: no consumen", () => {
  it("archivo inválido, archivo ausente o modo inválido → error de validación y 0 unidades, sin llamar a la IA", async () => {
    provider(() => ok());
    expect((await analyze({}, new TextEncoder().encode("no soy una imagen"))).status).toBe(415);
    expect((await analyze({}, null)).status).toBe(422);
    expect((await analyze({ mode: "hackeado" })).status).toBe(422);
    expect(calls).toBe(0);
    expect(await units()).toBe(0);
  });

  it("IA sin configurar → 0 unidades y un motivo sin detalles internos", async () => {
    const key = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    vi.resetModules();
    try {
      provider(() => ok());
      const r = await analyze();
      expect(r.body.status).toBe("analysis_failed");
      expect(r.body.reason).toBe("El análisis automático no está disponible en este momento.");
      expect(r.body.reason).not.toMatch(/OPENROUTER|API_KEY/);
      expect(calls).toBe(0);
      expect(await units()).toBe(0);
    } finally {
      process.env.OPENROUTER_API_KEY = key;
      vi.resetModules();
    }
  });

  it("cuota agotada → no llama a la IA ni consume, y lo explica", async () => {
    await fill(LIMIT);
    provider(() => ok());
    const r = await analyze();
    expect(r.body.status).toBe("analysis_failed");
    expect(r.body.reason).toMatch(/Demasiadas solicitudes/);
    expect(calls).toBe(0);
    expect(await units()).toBe(LIMIT);
  });
});

describe("errores del proveedor", () => {
  it("rechazo HTTP (4xx) → la unidad se devuelve; la prenda queda «por revisar» y no se filtra nada interno", async () => {
    provider(() => httpError(401));
    const r = await analyze();
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("analysis_failed");
    expect(r.body.items?.[0]?.needsReview).toBe(true);
    expect(r.body.reason).toBe("La IA no ha podido analizar la foto. Completa los datos a mano o inténtalo más tarde.");
    expect(JSON.stringify(r.body)).not.toMatch(/OpenRouter|sk-or|401/);
    expect(calls).toBe(1);
    expect(await units()).toBe(0);
  });

  it.each([400, 402])("otros rechazos previos al procesamiento (%i) → la unidad se devuelve", async (status) => {
    provider(() => httpError(status));
    const r = await analyze();
    expect(r.body.status).toBe("analysis_failed");
    expect(await units()).toBe(0);
  }, 20_000);

  it.each([500, 502, 503, 504, 429])("%i en todos los reintentos → no hay garantía de que no se procesara: UNA unidad consumida", async (status) => {
    provider(() => httpError(status));
    const r = await analyze();
    expect(r.body.status).toBe("analysis_failed");
    expect(r.body.reason).toBe("La IA no ha podido analizar la foto. Completa los datos a mano o inténtalo más tarde.");
    expect(calls).toBe(3);
    expect(await units()).toBe(1); // tres intentos, una sola unidad
    expect((await rows())[0]).toMatchObject({ success: false });
  }, 20_000);

  it("403 → dudoso (no todos sus motivos son previos al procesamiento): consumida", async () => {
    provider(() => httpError(403));
    const r = await analyze();
    expect(r.body.status).toBe("analysis_failed");
    expect(calls).toBe(1);
    expect(await units()).toBe(1);
    expect((await rows())[0]).toMatchObject({ success: false });
  });

  it("un intento dudoso (5xx o red) seguido de un 403 → la unidad tampoco se devuelve", async () => {
    provider(() => httpError(503), () => httpError(403));
    await analyze();
    expect(calls).toBe(2);
    expect(await units()).toBe(1);
    provider(() => { throw new TypeError("fetch failed"); }, () => httpError(403));
    await analyze();
    expect(await units()).toBe(2);
  }, 20_000);

  it.each([408, 418, 499])("408 o estado desconocido (%i) → dudoso: consumida", async (status) => {
    provider(() => httpError(status));
    await analyze();
    expect(calls).toBe(1);
    expect(await units()).toBe(1);
  });

  it("503, 503 y éxito → una sola unidad, registrada como éxito", async () => {
    provider(() => httpError(503), () => httpError(503), () => ok());
    expect((await analyze()).body.status).toBe("ok");
    expect(calls).toBe(3);
    expect(await units()).toBe(1);
    expect((await rows())[0]).toMatchObject({ success: true });
  }, 20_000);

  it("un intento dudoso (5xx o red) seguido de un rechazo previo (401) → la unidad NO se devuelve", async () => {
    provider(() => httpError(502), () => httpError(401));
    await analyze();
    expect(await units()).toBe(1);
    provider(() => { throw new TypeError("fetch failed"); }, () => httpError(401));
    await analyze();
    expect(await units()).toBe(2);
  }, 20_000);

  it("5xx y después éxito → una unidad", async () => {
    provider(() => httpError(502), () => ok());
    expect((await analyze()).body.status).toBe("ok");
    expect(await units()).toBe(1);
  }, 20_000);

  it("timeout o error de red (sin respuesta) → dudoso: queda consumida (opción segura)", async () => {
    provider(() => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); });
    const r = await analyze();
    expect(r.body.status).toBe("analysis_failed");
    expect(r.body.reason).not.toMatch(/timeout|aborted/i);
    expect(await units()).toBe(1);
    expect((await rows())[0]).toMatchObject({ success: false });
  }, 20_000);

  it("respuesta inválida (dos veces) → el proveedor respondió: UNA unidad consumida, marcada como fallo", async () => {
    provider(() => ok({ items: [{ ...ITEM, category: "INVENTADA" }] }));
    const r = await analyze();
    expect(r.body.status).toBe("analysis_failed");
    expect(calls).toBe(2);
    expect(await units()).toBe(1);
    expect((await rows())[0]).toMatchObject({ success: false, inputTokens: 200 });
  });

  it("salida inválida y luego rechazo HTTP → hubo una respuesta facturada: consumida", async () => {
    provider(() => ok("{roto"), () => httpError(400));
    await analyze();
    expect(await units()).toBe(1);
  });
});

describe("error al guardar el resultado", () => {
  it("el análisis se completó (y se facturó): la unidad queda consumida; el cliente recibe un 500 genérico", async () => {
    provider(() => ok());
    const spy = vi.spyOn(t.prisma.wardrobeItem, "create").mockRejectedValueOnce(new Error("Neon caído"));
    const r = await analyze();
    spy.mockRestore();
    expect(r.status).toBe(500);
    expect(r.body.error).toEqual({ code: "INTERNAL", message: "Error interno" });
    expect(await units()).toBe(1);
    expect((await rows())[0]).toMatchObject({ success: true });
  });
});

describe("concurrencia y reintentos", () => {
  it("5 análisis simultáneos con una sola unidad libre → solo uno se analiza y no se supera el límite", async () => {
    await fill(LIMIT - 1);
    provider(() => new Promise((resolve) => setTimeout(() => resolve(ok()), 50)));
    const results = await Promise.all(Array.from({ length: 5 }, () => analyze()));
    expect(results.filter((r) => r.body.status === "ok")).toHaveLength(1);
    expect(results.filter((r) => r.body.status === "analysis_failed" && /Demasiadas/.test(r.body.reason ?? ""))).toHaveLength(4);
    expect(calls).toBe(1);
    expect(await units()).toBe(LIMIT);
  }, 30_000);

  it("simultáneos con fallos que devuelven la unidad: nunca se supera el límite ni se recupera más de lo reservado", async () => {
    await fill(LIMIT - 2);
    provider(() => new Promise((resolve) => setTimeout(() => resolve(httpError(401)), 30)));
    await Promise.all(Array.from({ length: 6 }, () => analyze()));
    expect(await units()).toBe(LIMIT - 2); // todas las reservas devueltas, ni una fila ajena borrada
  }, 30_000);

  it("liberar una reserva dos veces no devuelve más de una unidad; completar una liberada no la resucita", async () => {
    const { aiUsageService } = await import("@/services/ai-usage.service");
    await fill(3);
    const id = await aiUsageService.reserve(userId, { task: "ITEM_ANALYSIS", provider: "openrouter", model: "m" });
    expect(await units()).toBe(4);
    await aiUsageService.release(id);
    await aiUsageService.release(id);
    expect(await units()).toBe(3);
    await aiUsageService.complete(id, { success: true });
    expect(await units()).toBe(3);
  });

  it("reintentos del cliente tras fallos que no se completaron no acumulan consumo; tras dudosos sí cuentan", async () => {
    provider(() => httpError(401));
    for (let i = 0; i < 3; i++) await analyze();
    expect(await units()).toBe(0);
    provider(() => { throw new TypeError("fetch failed"); });
    await analyze();
    expect(await units()).toBe(1);
  }, 30_000);
});

describe("el cliente no controla la cuota", () => {
  it("campos manipulados en la petición se ignoran y no afectan a la cuota propia ni a la de otro usuario", async () => {
    const other = await t.prisma.user.create({ data: { email: `otro${Math.random()}@q.com`, passwordHash: "x" } });
    await fill(5, other.id);
    await fill(LIMIT);
    provider(() => ok());
    const r = await analyze({ userId: other.id, quota: "999", used: "0", limit: "1000", task: "TRY_ON", success: "false" });
    expect(r.body.status).toBe("analysis_failed"); // sigue agotada: los campos no cuentan
    expect(calls).toBe(0);
    expect(await units()).toBe(LIMIT);
    expect(await units(other.id)).toBe(5);
  });

  it("ninguna ruta de la API escribe en la cuota directamente (solo los servicios del servidor)", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const path = await import("node:path");
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const f = path.join(d, n); return statSync(f).isDirectory() ? walk(f) : [f]; });
    const routes = walk(path.join(process.cwd(), "src/app/api")).filter((f) => f.endsWith("route.ts"));
    expect(routes.length).toBeGreaterThan(20);
    for (const f of routes) expect(readFileSync(f, "utf8"), f).not.toMatch(/aiUsage|AiUsageLog/);
  });
});
