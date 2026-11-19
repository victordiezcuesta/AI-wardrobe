import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { startTestDb, type TestDb } from "../helpers/db";
import { prismaProxy, setTestEnv } from "../helpers/mock-prisma";

const holder = vi.hoisted(() => ({ prisma: null as PrismaClient | null }));
const ai = vi.hoisted(() => ({ calls: [] as { schemaName?: string; user: string }[], responses: [] as ((opts: { schemaName?: string }) => unknown)[] }));

vi.mock("@/lib/prisma", () => ({ prisma: prismaProxy(holder) }));
vi.mock("@/lib/openrouter/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/openrouter/client")>()),
  chat: vi.fn(async (opts: { schemaName?: string; messages: { content: unknown }[] }) => {
    const user = String(opts.messages[opts.messages.length - 1]!.content);
    ai.calls.push({ schemaName: opts.schemaName, user });
    const next = ai.responses.shift();
    if (!next) throw new Error("Sin respuesta simulada");
    const out = next(opts);
    if (out instanceof Error) throw out;
    return { text: JSON.stringify(out), usage: { inputTokens: 10, outputTokens: 20 }, model: "m", latencyMs: 5 };
  }),
}));
vi.mock("@/services/weather.service", () => ({
  weatherService: { getForecast: vi.fn(async () => ({ date: "2026-11-18", timezone: "Europe/Madrid", daily: { tMin: 6, tMax: 13, apparentMin: 4, apparentMax: 11, precipProbMax: 80, windMax: 20, code: 61, description: "lluvia ligera" }, hourly: [] })) },
}));

let t: TestDb;
beforeAll(async () => { setTestEnv(); t = await startTestDb(); holder.prisma = t.prisma; }, 60_000);
afterAll(async () => { await t?.stop(); });
beforeEach(() => { ai.calls.length = 0; ai.responses.length = 0; });

/** Extrae el alias (i1, i2…) que el prompt asignó a una prenda por su nombre. */
const aliasOf = (prompt: string, name: string) => new RegExp(`(?:^|\\n)(i\\d+) \\| ${name} \\|`).exec(prompt)?.[1] ?? "i-no-existe";
const outfit = (name: string, ids: string[], extra: object = {}) => ({ name, description: "d", occasion: "o", reasoning: "r", colorExplanation: "c", weatherFit: "w", styleFit: "s", itemIds: ids, alternatives: [], ...extra });

const request = { location: { name: "Madrid", latitude: 40.4, longitude: -3.7 }, date: "2026-11-18", occasion: "Cena informal con amigos" };

describe("estilista: la IA solo puede usar prendas reales, del usuario y disponibles", () => {
  let u: string, other: string;
  beforeAll(async () => {
    u = (await t.prisma.user.create({ data: { email: "stylist@test.com", profile: { create: { usualStyles: ["casual"], avoidedColors: ["rojo"] } } } })).id;
    other = (await t.prisma.user.create({ data: { email: "otro-estilista@test.com" } })).id;
    const mk = (userId: string, name: string, category: "TSHIRT" | "JEANS" | "SNEAKERS" | "JACKET" | "TROUSERS", color: string, extra: object = {}) =>
      t.prisma.wardrobeItem.create({ data: { userId, name, category, primaryColor: color, ...extra } });
    await mk(u, "Camiseta blanca", "TSHIRT", "blanco");
    await mk(u, "Vaqueros azules", "JEANS", "azul");
    await mk(u, "Zapatillas blancas", "SNEAKERS", "blanco");
    await mk(u, "Chaqueta negra", "JACKET", "negro");
    await mk(u, "Pantalon sucio", "TROUSERS", "gris", { status: "DIRTY" });
    await mk(other, "Camiseta AJENA secreta", "TSHIRT", "verde");
  });

  it("valida ids, descarta los inventados/repetidos y reintenta con correcciones", async () => {
    const { stylistService } = await import("@/services/stylist.service");
    ai.responses.push(
      (o) => ({ outfits: [
        outfit("Look válido", ["PLACEHOLDER"]),
      ] }),
    );
    // Se prepara una respuesta dinámica usando los alias reales que verá el modelo.
    ai.responses.length = 0;
    ai.responses.push(() => { const p = ai.calls[ai.calls.length - 1]!.user; const [c, v, z, j] = ["Camiseta blanca", "Vaqueros azules", "Zapatillas blancas", "Chaqueta negra"].map((n) => aliasOf(p, n));
      return { outfits: [
        outfit("Look válido", [c!, v!, z!], { alternatives: [{ itemId: j!, replacesItemId: z!, reason: "más abrigo" }, { itemId: "i999", replacesItemId: c!, reason: "inventada" }] }),
        outfit("Con prenda inventada", [c!, v!, "i999"]),
        outfit("Con id real de la base de datos", ["cmabc123456789012345678"]),
        outfit("Repetido", [z!, v!, c!]),
        outfit("Incompleto", [c!, z!]),
      ] }; });
    ai.responses.push(() => { const p = ai.calls[ai.calls.length - 1]!.user; const [c, v, j] = ["Camiseta blanca", "Vaqueros azules", "Chaqueta negra"].map((n) => aliasOf(p, n));
      return { outfits: [outfit("Segundo intento", [c!, v!, j!])] }; });

    const res = await stylistService.generate(u, request);

    expect(res.outfits.map((o) => o.name).sort()).toEqual(["Look válido", "Segundo intento"]);
    expect(res.warning).toContain("menos de 3");
    // 1) El prompt nunca contiene prendas de otro usuario ni no disponibles.
    const prompt = ai.calls[0]!.user;
    expect(prompt).not.toContain("AJENA");
    expect(prompt).not.toContain("sucio");
    expect(prompt).toContain("lluvia ligera"); // el clima real entra en el contexto
    expect(prompt).toContain("Cena informal");
    // 2) El reintento recibió las correcciones de lo rechazado.
    expect(ai.calls[1]!.user).toContain("CORRECCIONES");
    expect(ai.calls[1]!.user).toContain("i999");
    // 3) Lo persistido solo referencia prendas del usuario, disponibles.
    const persisted = await t.prisma.outfitItem.findMany({ where: { outfit: { userId: u } }, include: { item: true } });
    expect(persisted.length).toBeGreaterThan(0);
    for (const oi of persisted) { expect(oi.item.userId).toBe(u); expect(oi.item.status).toBe("AVAILABLE"); }
    // 4) La alternativa válida se guardó y la inventada no.
    const valid = res.outfits.find((o) => o.name === "Look válido")!;
    const withAlt = valid.items.find((i) => i.alternatives.length > 0)!;
    expect(withAlt.alternatives).toHaveLength(1);
    const alt = await t.prisma.wardrobeItem.findUniqueOrThrow({ where: { id: withAlt.alternatives[0]! } });
    expect(alt.name).toBe("Chaqueta negra");
    // 5) Se registró el consumo de IA: UNA unidad por generación aunque hubiera un segundo intento con correcciones
    //    (antes, una por llamada), con los tokens de ambas llamadas.
    const logs = await t.prisma.aiUsageLog.findMany({ where: { userId: u, task: "OUTFIT_GENERATION" } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ success: true, inputTokens: 20, outputTokens: 40 });
  });

  it("no repite combinaciones ya propuestas y lo indica a la IA", async () => {
    const { stylistService } = await import("@/services/stylist.service");
    ai.responses.push(() => { const p = ai.calls[0]!.user; const [c, v, z] = ["Camiseta blanca", "Vaqueros azules", "Zapatillas blancas"].map((n) => aliasOf(p, n));
      return { outfits: [outfit("Repetición de un look previo", [c!, v!, z!])] }; });
    ai.responses.push(() => ({ outfits: [] }));
    await expect(stylistService.generate(u, request)).rejects.toMatchObject({ code: "AI_INVALID", status: 502 }); // fallo de la IA: nunca un 422 «datos no válidos»
    expect(ai.calls[0]!.user).toContain("YA PROPUESTOS");
  });

  it("exige un armario mínimo", async () => {
    const { stylistService } = await import("@/services/stylist.service");
    const poor = (await t.prisma.user.create({ data: { email: "pobre@test.com" } })).id;
    await t.prisma.wardrobeItem.create({ data: { userId: poor, name: "Una sola", category: "TSHIRT" } });
    await expect(stylistService.generate(poor, request)).rejects.toMatchObject({ code: "WARDROBE_TOO_SMALL" });
    expect(ai.calls).toHaveLength(0); // ni siquiera se llamó a la IA
  });

  it("aprende: tras descartar looks, las preferencias negativas entran en el siguiente prompt", async () => {
    const { outfitService } = await import("@/services/outfit.service");
    const { stylistService } = await import("@/services/stylist.service");
    const o = await t.prisma.outfit.findFirstOrThrow({ where: { userId: u, name: "Segundo intento" } });
    await outfitService.feedback(u, o.id, "DISCARDED");
    await outfitService.feedback(u, o.id, "DISLIKE");
    const prefs = await t.prisma.userPreference.findMany({ where: { userId: u } });
    expect(prefs.find((p) => p.dimension === "color" && p.key === "negro")!.score).toBeLessThan(0);
    expect((await t.prisma.outfit.findUniqueOrThrow({ where: { id: o.id } })).discarded).toBe(true);

    ai.responses.push(() => ({ outfits: [] })); ai.responses.push(() => ({ outfits: [] }));
    await stylistService.generate(u, request).catch(() => undefined);
    expect(ai.calls[0]!.user).toContain("SUELE DESCARTAR");
    expect(ai.calls[0]!.user).toContain("color=negro");
  });

  it("'Me lo pongo' registra el historial y el uso de las prendas", async () => {
    const { outfitService } = await import("@/services/outfit.service");
    const o = await t.prisma.outfit.findFirstOrThrow({ where: { userId: u, name: "Look válido" }, include: { items: true } });
    await outfitService.feedback(u, o.id, "WORN", 5);
    expect(await t.prisma.outfitHistory.count({ where: { outfitId: o.id } })).toBe(1);
    const worn = await t.prisma.wardrobeItem.findMany({ where: { id: { in: o.items.map((i) => i.itemId) } } });
    expect(worn.every((w) => w.wearCount === 1 && w.lastWornAt)).toBe(true);
    expect((await t.prisma.outfit.findUniqueOrThrow({ where: { id: o.id } })).rating).toBe(5);
  });

  it("guardar como favorito suma preferencia una sola vez", async () => {
    const { outfitService } = await import("@/services/outfit.service");
    const o = await t.prisma.outfit.findFirstOrThrow({ where: { userId: u, name: "Look válido" } });
    await outfitService.setFavorite(u, o.id, true);
    await outfitService.setFavorite(u, o.id, true);
    expect(await t.prisma.outfitFeedback.count({ where: { outfitId: o.id, type: "SAVED" } })).toBe(1);
    expect((await outfitService.setFavorite(u, o.id, false)).isFavorite).toBe(false);
  });
});

describe("completa tu armario: solo productos reales del catálogo", () => {
  let u: string;
  beforeAll(async () => {
    u = (await t.prisma.user.create({ data: { email: "compras@test.com", profile: { create: { avoidedColors: ["rojo"], budgetMax: 60, favoriteBrands: ["Mango"] } } } })).id;
    for (const [n, c, col] of [["Camiseta", "TSHIRT", "blanco"], ["Vaqueros", "JEANS", "azul"], ["Zapatillas", "SNEAKERS", "blanco"], ["Chaqueta", "JACKET", "negro"], ["Pantalón", "TROUSERS", "beige"]] as const) {
      await t.prisma.wardrobeItem.create({ data: { userId: u, name: n, category: c, primaryColor: col } });
    }
    const { catalogRepository } = await import("@/repositories/catalog.repository");
    const row = (id: string, name: string, color: string | null, price: number, brand = "Mango") => ({ externalId: id, name, brand, description: null, category: "SHIRT" as const, colorKey: color, colorText: color, priceCents: price, imageUrl: "https://img.example.com/x.jpg", url: `https://www.awin1.com/cread.php?p=${id}` });
    await catalogRepository.upsertBatch({ provider: "awin", feedId: "1", store: "Mango" }, [
      row("s1", "Camisa celeste", "celeste", 2999), row("s2", "Camisa roja", "rojo", 2500), row("s3", "Camisa cara", "celeste", 9900), row("s4", "Camisa verde", "verde", 3500, "Otra"),
    ]);
  });

  const gaps = (o: { category: string; color: string | null; label: string }[]) => ({ gaps: o.map((g) => ({ ...g, reason: "Desbloquea looks", combinesWith: ["i1", "i999"], searchTerms: ["camisa"] })) });

  it("ordena con IA solo entre candidatos reales y filtra colores evitados y presupuesto", async () => {
    const { shoppingService } = await import("@/services/shopping.service");
    ai.responses.push(() => gaps([{ category: "SHIRT", color: null, label: "Camisa" }, { category: "BOOTS", color: "marrón", label: "Botas marrones" }]));
    ai.responses.push((_o) => {
      const p = ai.calls[1]!.user;
      const id = (name: string) => new RegExp(`(p\\d+) \\| ${name} \\|`).exec(p)?.[1] ?? "p-nope";
      return { gaps: [{ gap: "g1", ranking: [
        { productId: id("Camisa celeste"), score: 95, reason: "Color versátil y buen precio", combinesWith: ["i2", "i999"] },
        { productId: "p9999", score: 99, reason: "Producto inventado", combinesWith: [] },
        { productId: id("Camisa verde"), score: 60, reason: "Otra opción", combinesWith: [] },
      ] }] };
    });
    const batch = await shoppingService.recommend(u);

    const shirt = batch.gaps.find((g) => g.label === "Camisa")!;
    expect(shirt.status).toBe("found");
    expect(shirt.aiRanked).toBe(true);
    expect(shirt.products.map((p) => p.name)).toEqual(["Camisa celeste", "Camisa verde"]); // sin la inventada
    expect(shirt.products.every((p) => p.url.startsWith("https://www.awin1.com/"))).toBe(true);
    const prompt = ai.calls[1]!.user;
    expect(prompt).not.toContain("Camisa roja"); // color que el usuario evita
    expect(prompt).not.toContain("Camisa cara"); // fuera de presupuesto (60 €)
    expect(shirt.combinesWith.length).toBeLessThanOrEqual(1); // "i999" no existe: descartado
    expect(batch.gaps.find((g) => g.label === "Botas marrones")).toMatchObject({ status: "unavailable", products: [] });
  });

  it("reutiliza el análisis si el armario no cambia y la IA no se vuelve a llamar", async () => {
    const { shoppingService } = await import("@/services/shopping.service");
    const again = await shoppingService.recommend(u);
    expect(again.fromCache).toBe(true);
    expect(ai.calls).toHaveLength(0);
  });

  it("si la IA no puede ordenar, usa puntuación determinista con motivos veraces", async () => {
    const { shoppingService } = await import("@/services/shopping.service");
    ai.responses.push(() => gaps([{ category: "SHIRT", color: "celeste", label: "Camisa celeste" }]));
    ai.responses.push(() => new Error("proveedor caído"));
    const batch = await shoppingService.recommend(u, { force: true });
    const g = batch.gaps[0]!;
    expect(g.aiRanked).toBe(false);
    expect(g.products[0]).toMatchObject({ name: "Camisa celeste" });
    expect(g.products[0]!.matchReason).toContain("color buscado");
  });

  it("exige un armario mínimo antes de gastar IA", async () => {
    const { shoppingService } = await import("@/services/shopping.service");
    const poor = (await t.prisma.user.create({ data: { email: "poco@test.com" } })).id;
    await expect(shoppingService.recommend(poor)).rejects.toMatchObject({ code: "WARDROBE_TOO_SMALL" });
    expect(ai.calls).toHaveLength(0);
  });
});
