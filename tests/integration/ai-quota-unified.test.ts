import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { startTestDb, type TestDb } from "../helpers/db";
import { prismaProxy, setTestEnv } from "../helpers/mock-prisma";

/**
 * Cuotas de IA unificadas en todos los servicios: estilista, compras y probador con el mismo mecanismo de reserva
 * atómica que el análisis de prendas. Servicios, repositorios y Prisma reales sobre PGlite, y el cliente de OpenRouter
 * REAL (reintentos y clasificación de errores). Solo se simula lo externo: `fetch` hacia OpenRouter, Pollinations,
 * Cloudinary, el clima y `after()` de Next (los trabajos en segundo plano se ejecutan a mano).
 */
const holder = vi.hoisted(() => ({ prisma: null as PrismaClient | null }));
const bg = vi.hoisted(() => ({ jobs: [] as (() => Promise<unknown>)[] }));
const PNG = vi.hoisted(() => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6]));
const pollinations = vi.hoisted(() => ({ edit: vi.fn() }));

vi.mock("@/lib/prisma", () => ({ prisma: prismaProxy(holder) }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => Promise<unknown>) => { bg.jobs.push(fn); } }));
vi.mock("@/lib/pollinations/client", () => ({ editImage: pollinations.edit }));
vi.mock("@/lib/cloudinary", () => ({
  signedUrl: (id: string) => `https://api.cloudinary.com/signed/${id}`,
  uploadPrivate: vi.fn(async (_b: Buffer, folder: string) => ({ publicId: `${folder}/r${Math.random()}`, width: 1, height: 1 })),
  deletePrivateImages: vi.fn(async () => undefined),
}));
vi.mock("@/services/weather.service", () => ({ weatherService: { getForecast: vi.fn(async () => { throw new Error("sin clima en tests"); }) } }));

const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";
const GENERAL = 60; // AI_DAILY_LIMIT_PER_USER (sin cambios)
const TRYON = 10; // TRYON_DAILY_LIMIT_PER_USER (sin cambios)

type Reply = (ctx: { schema: string; user: string }) => Response | Promise<Response>;
let calls: string[] = [];
/** OpenRouter simulado por nombre de esquema; cada entrada es una respuesta por llamada (la última se repite). */
function openrouter(replies: Partial<Record<"outfits" | "wardrobe_gaps" | "shopping_ranking", Reply[]>>) {
  calls = [];
  const seen: Record<string, number> = {};
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (String(url) !== OPENROUTER) return new Response(new Uint8Array(PNG), { status: 200 }); // descargas de referencias del probador
    const body = JSON.parse(String(init?.body)) as { response_format?: { json_schema?: { name?: string } }; messages: { content: unknown }[] };
    const schema = body.response_format?.json_schema?.name ?? "?";
    calls.push(schema);
    const list = replies[schema as keyof typeof replies] ?? [];
    const i = Math.min(seen[schema] ?? 0, list.length - 1);
    seen[schema] = (seen[schema] ?? 0) + 1;
    if (!list[i]) throw new Error(`Sin respuesta simulada para ${schema}`);
    return list[i]!({ schema, user: String(body.messages[body.messages.length - 1]!.content) });
  }));
}
const json = (content: unknown) => () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
const http = (status: number) => () => new Response("detalle interno del proveedor sk-or-v1-x", { status });
const netError = () => { throw new TypeError("fetch failed"); };

const alias = (prompt: string, name: string) => new RegExp(`(?:^|\\n)(i\\d+) \\| ${name} \\|`).exec(prompt)?.[1] ?? "i-no";
const look = (name: string, ids: string[]) => ({ name, description: "d", occasion: "o", reasoning: "r", colorExplanation: "c", weatherFit: "w", styleFit: "s", itemIds: ids, alternatives: [] });
/** Tres conjuntos válidos y distintos (no fuerza segundo intento). */
const threeLooks: Reply = ({ user }) => json({ outfits: [
  look("A", [alias(user, "Camiseta"), alias(user, "Vaqueros")]),
  look("B", [alias(user, "Camisa"), alias(user, "Chinos")]),
  look("C", [alias(user, "Jersey"), alias(user, "Vaqueros")]),
] })();
const oneLook: Reply = ({ user }) => json({ outfits: [look("Solo uno", [alias(user, "Camiseta"), alias(user, "Vaqueros")])] })();
const gaps = json({ gaps: [{ category: "SHIRT", color: null, label: "Camisa", reason: "Desbloquea más conjuntos", combinesWith: [], searchTerms: ["camisa"] }] });
const ranking: Reply = ({ user }) => json({ gaps: [{ gap: "g1", ranking: [{ productId: /(p\d+) \| Camisa celeste/.exec(user)?.[1] ?? "p1", score: 90, reason: "Buen color y precio", combinesWith: [] }] }] })();

let t: TestDb;
beforeAll(async () => {
  setTestEnv();
  t = await startTestDb(); holder.prisma = t.prisma;
  const { catalogRepository } = await import("@/repositories/catalog.repository");
  await catalogRepository.upsertBatch({ provider: "awin", feedId: "1", store: "Mango" }, [
    { externalId: "s1", name: "Camisa celeste", brand: "Mango", description: null, category: "SHIRT", colorKey: "celeste", colorText: "celeste", priceCents: 2999, imageUrl: "https://img.example.com/x.jpg", url: "https://www.awin1.com/cread.php?p=s1" },
  ]);
}, 60_000);
afterAll(async () => { await t?.stop(); });
let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { bg.jobs.length = 0; pollinations.edit.mockReset(); pollinations.edit.mockResolvedValue(PNG); errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined); });
afterEach(() => { errSpy.mockRestore(); vi.unstubAllGlobals(); });
const runBackground = async () => { while (bg.jobs.length) await bg.jobs.shift()!(); };

/** Usuario con armario (6 prendas), consentimiento y foto para el probador, y un conjunto. */
async function user() {
  const photo = "ai-wardrobe/u/personal/p1";
  const u = await t.prisma.user.create({ data: { email: `u${Math.random().toString(36).slice(2)}@q.com`, profile: { create: { aiPhotoConsent: true, consentAt: new Date(), photoPublicIds: [photo] } } } });
  const ids: string[] = [];
  for (const [name, category, color] of [["Camiseta", "TSHIRT", "blanco"], ["Camisa", "SHIRT", "azul"], ["Jersey", "SWEATER", "gris"], ["Vaqueros", "JEANS", "azul"], ["Chinos", "TROUSERS", "beige"], ["Zapatillas", "SNEAKERS", "blanco"]] as const) {
    ids.push((await t.prisma.wardrobeItem.create({ data: { userId: u.id, name, category, primaryColor: color, imageUrl: `https://res.cloudinary.com/demo/${name}.jpg` } })).id);
  }
  const outfitId = (await t.prisma.outfit.create({ data: { userId: u.id, name: "Look", description: "d", items: { create: [{ itemId: ids[0]! }, { itemId: ids[3]! }] } } })).id;
  return { id: u.id, tryOnInput: { outfitId, photoPublicId: photo, scenario: "studio" as const, pose: "standing" as const } };
}
const req = { location: { name: "Madrid", latitude: 40.4, longitude: -3.7 }, date: "2026-11-19", occasion: "Trabajo" };
const count = (userId: string, task?: "OUTFIT_GENERATION" | "SHOPPING_GAPS" | "SHOPPING_RANKING" | "TRY_ON" | "ITEM_ANALYSIS") =>
  t.prisma.aiUsageLog.count({ where: { userId, ...(task && { task }) } });
const fill = (userId: string, n: number, task: "OUTFIT_GENERATION" | "TRY_ON" | "ITEM_ANALYSIS" = "ITEM_ANALYSIS") =>
  t.prisma.aiUsageLog.createMany({ data: Array.from({ length: n }, () => ({ userId, task, provider: "x", model: "m", success: true })) });
const services = async () => ({
  stylist: (await import("@/services/stylist.service")).stylistService,
  shopping: (await import("@/services/shopping.service")).shoppingService,
  tryOn: (await import("@/services/tryon.service")).tryOnService,
});

describe("estilista", () => {
  it("éxito con segundo intento de corrección → UNA unidad de OUTFIT_GENERATION", async () => {
    const u = await user();
    openrouter({ outfits: [oneLook, threeLooks] });
    const r = await (await services()).stylist.generate(u.id, req);
    expect(r.outfits.length).toBeGreaterThan(1);
    expect(calls).toEqual(["outfits", "outfits"]);
    expect(await count(u.id)).toBe(1);
    expect(await t.prisma.aiUsageLog.findFirst({ where: { userId: u.id } })).toMatchObject({ task: "OUTFIT_GENERATION", success: true, inputTokens: 20, outputTokens: 10 });
  });

  it("rechazo previo (401) → devuelve la unidad y el cliente no ve detalles del proveedor", async () => {
    const u = await user();
    openrouter({ outfits: [http(401)] });
    const err = await (await services()).stylist.generate(u.id, req).then(() => null, (e: { message: string; code: string }) => e);
    expect(err).toMatchObject({ code: "AI_UPSTREAM", message: "El servicio de IA no ha podido responder. Inténtalo de nuevo en unos minutos." });
    expect(err!.message).not.toMatch(/OpenRouter|401|sk-or/);
    expect(await count(u.id)).toBe(0);
  });

  it.each([["5xx en todos los intentos", http(503)], ["error de red", netError], ["403", http(403)]] as const)("%s → dudoso: UNA unidad consumida", async (_n, reply) => {
    const u = await user();
    openrouter({ outfits: [reply] });
    await expect((await services()).stylist.generate(u.id, req)).rejects.toMatchObject({ status: 502 });
    expect(await count(u.id)).toBe(1);
    expect(await t.prisma.aiUsageLog.findFirst({ where: { userId: u.id } })).toMatchObject({ success: false });
  }, 20_000);

  it("armario insuficiente → no reserva nada", async () => {
    const u = await t.prisma.user.create({ data: { email: `vacio${Math.random()}@q.com` } });
    openrouter({ outfits: [threeLooks] });
    await expect((await services()).stylist.generate(u.id, req)).rejects.toMatchObject({ code: "WARDROBE_TOO_SMALL" });
    expect(calls).toHaveLength(0);
    expect(await count(u.id)).toBe(0);
  });

  it("su cuota sigue siendo propia: solo cuentan las filas OUTFIT_GENERATION (otras tareas no la agotan)", async () => {
    const u = await user();
    await fill(u.id, GENERAL, "ITEM_ANALYSIS"); // cuota general agotada…
    openrouter({ outfits: [threeLooks] });
    await (await services()).stylist.generate(u.id, req); // …pero el estilista sigue disponible, como antes
    await fill(u.id, GENERAL - 1, "OUTFIT_GENERATION");
    await expect((await services()).stylist.generate(u.id, req)).rejects.toMatchObject({ status: 429 }); // ya 60 de OUTFIT_GENERATION
    expect(await count(u.id, "OUTFIT_GENERATION")).toBe(GENERAL);
  });

  it("5 generaciones simultáneas con una unidad libre → solo una llama a la IA y no se supera el límite", async () => {
    const u = await user();
    await fill(u.id, GENERAL - 1, "OUTFIT_GENERATION");
    openrouter({ outfits: [(c) => new Promise((res) => setTimeout(() => res(threeLooks(c)), 40))] });
    const results = await Promise.allSettled(Array.from({ length: 5 }, async () => (await services()).stylist.generate(u.id, req)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected" && (r.reason as { status?: number }).status === 429)).toHaveLength(4);
    expect(calls.length).toBeLessThanOrEqual(2); // solo la generación que obtuvo la unidad llamó a la IA (con su posible 2.º intento)
    expect(await count(u.id, "OUTFIT_GENERATION")).toBe(GENERAL);
  }, 30_000);
});

describe("compras", () => {
  it("huecos + ordenación → una unidad por tarea (como antes), sin cobrar aparte el reintento interno", async () => {
    const u = await user();
    openrouter({ wardrobe_gaps: [json("no es el formato"), gaps], shopping_ranking: [ranking] });
    const batch = await (await services()).shopping.recommend(u.id, { force: true });
    expect(batch.gaps[0]!.aiRanked).toBe(true);
    expect(calls).toEqual(["wardrobe_gaps", "wardrobe_gaps", "shopping_ranking"]);
    expect(await count(u.id, "SHOPPING_GAPS")).toBe(1);
    expect(await count(u.id, "SHOPPING_RANKING")).toBe(1);
  });

  it("rechazo previo en huecos → 0 unidades y error genérico", async () => {
    const u = await user();
    openrouter({ wardrobe_gaps: [http(402)] });
    const err = await (await services()).shopping.recommend(u.id, { force: true }).then(() => null, (e: { message: string }) => e);
    expect(err!.message).not.toMatch(/OpenRouter|402/);
    expect(await count(u.id)).toBe(0);
  });

  it("ordenación dudosa (5xx) → su unidad queda consumida y se usa la puntuación determinista", async () => {
    const u = await user();
    openrouter({ wardrobe_gaps: [gaps], shopping_ranking: [http(502)] });
    const batch = await (await services()).shopping.recommend(u.id, { force: true });
    expect(batch.gaps[0]!.aiRanked).toBe(false);
    expect(await count(u.id, "SHOPPING_GAPS")).toBe(1);
    expect(await count(u.id, "SHOPPING_RANKING")).toBe(1);
  }, 20_000);

  it("con una sola unidad general: los huecos la usan y la ordenación NO supera el límite (recurre a la determinista)", async () => {
    const u = await user();
    await fill(u.id, GENERAL - 1);
    openrouter({ wardrobe_gaps: [gaps], shopping_ranking: [ranking] });
    const batch = await (await services()).shopping.recommend(u.id, { force: true });
    expect(batch.gaps[0]!.aiRanked).toBe(false);
    expect(calls).toEqual(["wardrobe_gaps"]); // la ordenación no llegó a llamar a la IA
    expect(await count(u.id)).toBe(GENERAL);
  });

  it("cuota general agotada → 429 sin llamar a la IA", async () => {
    const u = await user();
    await fill(u.id, GENERAL);
    openrouter({ wardrobe_gaps: [gaps] });
    await expect((await services()).shopping.recommend(u.id, { force: true })).rejects.toMatchObject({ status: 429 });
    expect(calls).toHaveLength(0);
  });

  it("la caché (mismo armario) no reserva ni consume", async () => {
    const u = await user();
    openrouter({ wardrobe_gaps: [gaps], shopping_ranking: [ranking] });
    await (await services()).shopping.recommend(u.id);
    const before = await count(u.id);
    const again = await (await services()).shopping.recommend(u.id);
    expect(again.fromCache).toBe(true);
    expect(await count(u.id)).toBe(before);
  });
});

describe("cuota general compartida entre servicios", () => {
  it("compras + análisis simultáneos con una sola unidad general → no se supera el límite", async () => {
    const u = await user();
    await fill(u.id, GENERAL - 1, "OUTFIT_GENERATION"); // las filas de otras tareas cuentan en la general
    openrouter({ wardrobe_gaps: [() => new Promise((res) => setTimeout(() => res(gaps()), 40))], shopping_ranking: [ranking] });
    const { aiUsageService } = await import("@/services/ai-usage.service");
    const analysis = aiUsageService.reserve(u.id, { task: "ITEM_ANALYSIS", provider: "openrouter", model: "m" });
    const shopping = (await services()).shopping.recommend(u.id, { force: true });
    await Promise.allSettled([analysis, shopping]);
    expect(await count(u.id)).toBe(GENERAL);
  });
});

describe("probador (cuota independiente)", () => {
  it("la unidad se reserva al crear el trabajo (un pendiente ya cuenta) y queda como éxito al terminar", async () => {
    const u = await user();
    const { tryOn } = await services();
    const dto = await tryOn.create(u.id, u.tryOnInput);
    expect(await count(u.id, "TRY_ON")).toBe(1); // antes, 0 hasta que el trabajo terminaba
    openrouter({});
    await runBackground();
    expect((await tryOn.get(u.id, dto.id)).status).toBe("COMPLETED");
    expect(await t.prisma.aiUsageLog.findFirst({ where: { userId: u.id, task: "TRY_ON" } })).toMatchObject({ success: true, provider: "pollinations" });
    expect(await count(u.id, "TRY_ON")).toBe(1);
  });

  it("con 9 de 10 usados no se pueden crear dos trabajos (antes sí: la cuota se escribía al terminar)", async () => {
    const u = await user();
    await fill(u.id, TRYON - 1, "TRY_ON");
    const { tryOn } = await services();
    await tryOn.create(u.id, u.tryOnInput);
    await expect(tryOn.create(u.id, u.tryOnInput)).rejects.toMatchObject({ status: 429 });
    expect(await count(u.id, "TRY_ON")).toBe(TRYON);
  });

  it("creaciones simultáneas con una unidad libre → solo una", async () => {
    const u = await user();
    await fill(u.id, TRYON - 1, "TRY_ON");
    const { tryOn } = await services();
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => tryOn.create(u.id, u.tryOnInput)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await count(u.id, "TRY_ON")).toBe(TRYON);
  });

  it("fallo ANTES de llamar a Pollinations (consentimiento retirado) → la unidad se devuelve", async () => {
    const u = await user();
    const { tryOn } = await services();
    await tryOn.create(u.id, u.tryOnInput);
    await t.prisma.userProfile.update({ where: { userId: u.id }, data: { aiPhotoConsent: false } });
    openrouter({});
    await runBackground();
    expect(pollinations.edit).not.toHaveBeenCalled();
    expect(await count(u.id, "TRY_ON")).toBe(0);
  });

  it("fallo de Pollinations (sin garantías de no facturación) → consumida; el reintento reserva otra unidad", async () => {
    const u = await user();
    const { AppError } = await import("@/lib/errors");
    pollinations.edit.mockRejectedValue(new AppError("El servicio de imágenes está saturado", 503, "TRYON_BUSY"));
    const { tryOn } = await services();
    const dto = await tryOn.create(u.id, u.tryOnInput);
    openrouter({});
    await runBackground();
    expect(await count(u.id, "TRY_ON")).toBe(1);
    await tryOn.retry(u.id, dto.id);
    await runBackground();
    expect(await count(u.id, "TRY_ON")).toBe(2); // un intento = una unidad, igual que antes
  });

  it("su cuota es independiente: la general agotada no lo bloquea, pero sus filas sí cuentan en la general", async () => {
    const u = await user();
    await fill(u.id, GENERAL);
    const { tryOn } = await services();
    await expect(tryOn.create(u.id, u.tryOnInput)).resolves.toBeTruthy();
    const v = await user();
    await fill(v.id, GENERAL - 1);
    await tryOn.create(v.id, v.tryOnInput); // TRY_ON cuenta en la general (regla previa, sin cambios)
    openrouter({ wardrobe_gaps: [gaps] });
    await expect((await services()).shopping.recommend(v.id, { force: true })).rejects.toMatchObject({ status: 429 });
  });

  it("un trabajo que ya no está pendiente cuando arranca devuelve su unidad", async () => {
    const u = await user();
    const { tryOn } = await services();
    const dto = await tryOn.create(u.id, u.tryOnInput);
    await t.prisma.generatedImage.update({ where: { id: dto.id }, data: { status: "FAILED" } }); // p. ej. marcado como atascado
    await runBackground();
    expect(await count(u.id, "TRY_ON")).toBe(0);
  });
});
