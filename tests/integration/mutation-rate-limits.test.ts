import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { unauthorized } from "@/lib/errors";
import { startTestDb, type TestDb } from "../helpers/db";
import { prismaProxy, setTestEnv } from "../helpers/mock-prisma";

/**
 * Fase 19.16 — límites por usuario de las mutaciones autenticadas, con los Route Handlers REALES, Prisma real sobre PGlite y el
 * limitador real. Solo se simulan: la sesión (`requireUserId`), Cloudinary (para comprobar que NO se llama tras un 429) y un
 * envoltorio sobre `@/lib/rate-limit` que registra las llamadas y permite inyectar fallos de infraestructura.
 * El contador es una sola sentencia atómica ya cubierta por las pruebas del limitador y de PostgreSQL real: aquí no se
 * repite la concurrencia del helper general.
 */
const holder = vi.hoisted(() => ({ prisma: null as PrismaClient | null }));
const session = vi.hoisted(() => ({ userId: "" as string }));
const lim = vi.hoisted(() => ({ calls: [] as { key: string; limit: number; windowSec: number }[], fail: false }));
const cloud = vi.hoisted(() => ({ deleteImage: vi.fn(async (_id?: string | null) => undefined), deletePrivateImages: vi.fn(async (_ids?: string[]) => undefined) }));
vi.mock("@/lib/prisma", () => ({ prisma: prismaProxy(holder) }));
vi.mock("@/lib/auth/session", async () => {
  const { unauthorized: unauth } = await import("@/lib/errors");
  return { requireUserId: async () => { if (!session.userId) throw unauth(); return session.userId; } };
});
vi.mock("@/lib/cloudinary", async (orig) => ({
  ...(await orig<typeof import("@/lib/cloudinary")>()),
  deleteImage: cloud.deleteImage,
  deletePrivateImages: cloud.deletePrivateImages,
  signedUrl: (id: string) => `https://api.cloudinary.com/signed/${id}`,
}));
vi.mock("@/lib/rate-limit", async (orig) => {
  const real = await orig<typeof import("@/lib/rate-limit")>();
  return {
    ...real,
    rateLimit: async (key: string, limit: number, windowSec: number) => {
      lim.calls.push({ key, limit, windowSec });
      if (lim.fail) throw new Error("fallo de almacenamiento simulado");
      return real.rateLimit(key, limit, windowSec);
    },
  };
});
void unauthorized;

const BASE = "http://localhost:3000";
let t: TestDb;
let errSpy: ReturnType<typeof vi.spyOn>;
let learn: ReturnType<typeof vi.spyOn>;
beforeAll(async () => {
  setTestEnv(); t = await startTestDb(); holder.prisma = t.prisma;
  const { preferenceService } = await import("@/services/preference.service");
  learn = vi.spyOn(preferenceService, "learn");
}, 60_000);
afterAll(async () => { await t?.stop(); });
beforeEach(async () => {
  session.userId = ""; lim.fail = false; lim.calls.length = 0;
  cloud.deleteImage.mockClear(); cloud.deletePrivateImages.mockClear(); learn.mockClear();
  await t.prisma.$executeRawUnsafe(`TRUNCATE "User", "RateLimit" CASCADE`);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { errSpy.mockRestore(); });

interface Fx { userId: string; itemId: string; imageId: string; outfitId: string }
let n = 0;
async function newUser(): Promise<Fx> {
  const u = await t.prisma.user.create({ data: { email: `u${++n}-${Math.random().toString(36).slice(2)}@q.com`, profile: { create: { aiPhotoConsent: false } } } });
  const item = await t.prisma.wardrobeItem.create({ data: { userId: u.id, name: "Camisa", category: "SHIRT", imagePublicId: `ai-wardrobe/${u.id}/wardrobe/w1`, imageUrl: "https://res.cloudinary.com/demo/image/upload/v1/x", thumbUrl: "https://res.cloudinary.com/demo/image/upload/v1/x" } });
  const outfit = await t.prisma.outfit.create({ data: { userId: u.id, name: "Look", description: "d", items: { create: [{ itemId: item.id }] } } });
  const image = await t.prisma.generatedImage.create({ data: { userId: u.id, outfitId: outfit.id, scenario: "studio", pose: "standing", status: "COMPLETED", publicId: `ai-wardrobe/${u.id}/tryon/g1` } });
  return { userId: u.id, itemId: item.id, imageId: image.id, outfitId: outfit.id };
}
const jsonReq = (method: string, url: string, body?: unknown) =>
  new Request(`${BASE}${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

interface Op {
  name: string; scope: string; limit: number;
  /** Ejecuta la operación sobre los recursos de `fx` (o `id` ajeno). `body` sustituye el cuerpo válido. */
  call: (fx: Fx, over?: { id?: string; body?: unknown }) => Promise<Response>;
  /** Estado de dominio que NO debe cambiar tras un 429. */
  state: (fx: Fx) => Promise<unknown>;
  /** Efectos externos o derivados que no deben ocurrir tras un 429. */
  noEffects: () => void;
  invalidBody: unknown | null;
}
const OPS: Op[] = [
  {
    name: "DELETE /api/wardrobe/[id]", scope: "wardrobe:delete", limit: 120, invalidBody: null,
    call: async (fx, o) => { const { DELETE } = await import("@/app/api/wardrobe/[id]/route"); const id = o?.id ?? fx.itemId; return DELETE(jsonReq("DELETE", `/api/wardrobe/${id}`), ctx(id)); },
    state: (fx) => t.prisma.wardrobeItem.findMany({ where: { userId: fx.userId } }),
    noEffects: () => expect(cloud.deleteImage).not.toHaveBeenCalled(),
  },
  {
    name: "DELETE /api/try-on/[id]", scope: "tryon:delete", limit: 60, invalidBody: null,
    call: async (fx, o) => { const { DELETE } = await import("@/app/api/try-on/[id]/route"); const id = o?.id ?? fx.imageId; return DELETE(jsonReq("DELETE", `/api/try-on/${id}`), ctx(id)); },
    state: (fx) => t.prisma.generatedImage.findMany({ where: { userId: fx.userId } }),
    noEffects: () => expect(cloud.deletePrivateImages).not.toHaveBeenCalled(),
  },
  {
    name: "PATCH /api/wardrobe/[id]", scope: "wardrobe:update", limit: 300, invalidBody: { isFavorite: "sí" },
    call: async (fx, o) => { const { PATCH } = await import("@/app/api/wardrobe/[id]/route"); const id = o?.id ?? fx.itemId; return PATCH(jsonReq("PATCH", `/api/wardrobe/${id}`, o?.body ?? { isFavorite: true }), ctx(id)); },
    state: (fx) => t.prisma.wardrobeItem.findMany({ where: { userId: fx.userId } }),
    noEffects: () => undefined,
  },
  {
    name: "PATCH /api/try-on/[id]", scope: "tryon:favorite", limit: 300, invalidBody: { isFavorite: "sí" },
    call: async (fx, o) => { const { PATCH } = await import("@/app/api/try-on/[id]/route"); const id = o?.id ?? fx.imageId; return PATCH(jsonReq("PATCH", `/api/try-on/${id}`, o?.body ?? { isFavorite: true }), ctx(id)); },
    state: (fx) => t.prisma.generatedImage.findMany({ where: { userId: fx.userId } }),
    noEffects: () => undefined,
  },
  {
    name: "PATCH /api/outfits/[id]", scope: "outfit:favorite", limit: 300, invalidBody: { isFavorite: "sí" },
    call: async (fx, o) => { const { PATCH } = await import("@/app/api/outfits/[id]/route"); const id = o?.id ?? fx.outfitId; return PATCH(jsonReq("PATCH", `/api/outfits/${id}`, o?.body ?? { isFavorite: true }), ctx(id)); },
    state: async (fx) => ({ outfits: await t.prisma.outfit.findMany({ where: { userId: fx.userId } }), feedback: await t.prisma.outfitFeedback.count({ where: { userId: fx.userId } }), prefs: await t.prisma.userPreference.count({ where: { userId: fx.userId } }) }),
    noEffects: () => expect(learn).not.toHaveBeenCalled(),
  },
  {
    name: "POST /api/consent", scope: "consent:set", limit: 20, invalidBody: { granted: "sí" },
    call: async (fx, o) => { const { POST } = await import("@/app/api/consent/route"); void fx; return POST(jsonReq("POST", "/api/consent", o?.body ?? { granted: true })); },
    state: (fx) => t.prisma.userProfile.findMany({ where: { userId: fx.userId } }),
    noEffects: () => undefined,
  },
];
const seedCount = (key: string, count: number) => t.prisma.$executeRawUnsafe(`INSERT INTO "RateLimit" ("key", "count", "windowStart") VALUES ('${key}', ${count}, NOW()) ON CONFLICT ("key") DO UPDATE SET "count" = ${count}, "windowStart" = NOW()`);
const countOf = async (key: string) => (await t.prisma.rateLimit.findUnique({ where: { key } }))?.count ?? null;
const rows = async () => (await t.prisma.rateLimit.findMany({ select: { key: true } })).map((r) => r.key);
const rateLimited = async (res: Response) => { expect(res.status).toBe(429); expect(((await res.json()) as { error: { code: string } }).error.code).toBe("RATE_LIMITED"); };

describe.each(OPS)("$name", (op) => {
  it("operación permitida: funciona, y cuenta con la clave `scope:userId` y el límite y la ventana autorizados", async () => {
    const fx = await newUser(); session.userId = fx.userId;
    const res = await op.call(fx);
    expect(res.status).toBe(200);
    expect(lim.calls).toEqual([{ key: `${op.scope}:${fx.userId}`, limit: op.limit, windowSec: 3600 }]);
    expect(await countOf(`${op.scope}:${fx.userId}`)).toBe(1);
    expect(await rows()).toEqual([`${op.scope}:${fx.userId}`]); // una sola fila, sin datos personales
  });

  it("el intento número `limit` aún pasa y el siguiente da 429 RATE_LIMITED sin efectos de dominio ni externos", async () => {
    const fx = await newUser(); session.userId = fx.userId;
    const key = `${op.scope}:${fx.userId}`;
    await seedCount(key, op.limit - 1);
    expect((await op.call(fx)).status).toBe(200);          // intento `limit`
    expect(await countOf(key)).toBe(op.limit);
    // Se reconstruye el estado para comprobar el 429 sobre recursos existentes.
    await t.prisma.$executeRawUnsafe(`TRUNCATE "User" CASCADE`);
    const fx2 = await newUser(); session.userId = fx2.userId;
    const key2 = `${op.scope}:${fx2.userId}`;
    await seedCount(key2, op.limit);
    const before = await op.state(fx2);
    cloud.deleteImage.mockClear(); cloud.deletePrivateImages.mockClear(); learn.mockClear();
    await rateLimited(await op.call(fx2));                  // intento `limit + 1`
    expect(await op.state(fx2)).toEqual(before);            // la base de datos de dominio, intacta
    op.noEffects();                                         // Cloudinary / aprendizaje / feedback, sin ejecutar
    expect(cloud.deleteImage).not.toHaveBeenCalled(); expect(cloud.deletePrivateImages).not.toHaveBeenCalled(); expect(learn).not.toHaveBeenCalled();
  });

  it("dos usuarios no comparten contador: con A en el límite, B sigue pudiendo operar", async () => {
    const a = await newUser(); const b = await newUser();
    await seedCount(`${op.scope}:${a.userId}`, op.limit);
    session.userId = a.userId; await rateLimited(await op.call(a));
    session.userId = b.userId; expect((await op.call(b)).status).toBe(200);
    expect(await countOf(`${op.scope}:${b.userId}`)).toBe(1);
    expect(await countOf(`${op.scope}:${a.userId}`)).toBe(op.limit + 1);
  });

  it("sin sesión: 401 y no se consume cuota ni se llama al limitador", async () => {
    const fx = await newUser(); session.userId = "";
    const res = await op.call(fx);
    expect(res.status).toBe(401);
    expect(lim.calls).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  it("recurso ajeno: 404 si no se ha superado el límite (consume cuota), sin efectos sobre el otro usuario", async () => {
    const a = await newUser(); const b = await newUser(); session.userId = a.userId;
    const foreign = op.name.includes("wardrobe") ? b.itemId : op.name.includes("try-on") ? b.imageId : b.outfitId;
    if (op.scope === "consent:set") return; // el consentimiento no tiene recurso por id
    const before = await op.state(b);
    expect((await op.call(a, { id: foreign })).status).toBe(404);
    expect(await countOf(`${op.scope}:${a.userId}`)).toBe(1);
    expect(await op.state(b)).toEqual(before);
    op.noEffects();
  });

  it("falla cerrado: un error del limitador no ejecuta el dominio ni Cloudinary ni el aprendizaje", async () => {
    const fx = await newUser(); session.userId = fx.userId;
    const before = await op.state(fx);
    lim.fail = true;
    const res = await op.call(fx);
    expect(res.status).toBe(500);
    expect(await op.state(fx)).toEqual(before);
    op.noEffects();
    expect(cloud.deleteImage).not.toHaveBeenCalled(); expect(cloud.deletePrivateImages).not.toHaveBeenCalled(); expect(learn).not.toHaveBeenCalled();
  });

  if (op.invalidBody !== null) {
    it("cuerpo inválido: 422 como antes, y consume cuota (el límite va antes de validar)", async () => {
      const fx = await newUser(); session.userId = fx.userId;
      const before = await op.state(fx);
      const res = await op.call(fx, { body: op.invalidBody });
      expect(res.status).toBe(422); // código de validación que ya devolvían estas rutas
      expect(await countOf(`${op.scope}:${fx.userId}`)).toBe(1);
      expect(await op.state(fx)).toEqual(before);
    });
    it("con el límite superado, un cuerpo inválido da 429 (no se llega a validar)", async () => {
      const fx = await newUser(); session.userId = fx.userId;
      await seedCount(`${op.scope}:${fx.userId}`, op.limit);
      await rateLimited(await op.call(fx, { body: op.invalidBody }));
    });
  }

  it("la clave termina en `:userId`: la eliminación de cuenta la limpia con su patrón `LIKE '%:userId'`", async () => {
    const fx = await newUser(); session.userId = fx.userId;
    await op.call(fx);
    const matched = await t.prisma.$queryRawUnsafe<{ key: string }[]>(`SELECT "key" FROM "RateLimit" WHERE "key" LIKE '%:${fx.userId}'`);
    expect(matched.map((r) => r.key)).toEqual([`${op.scope}:${fx.userId}`]);
  });
});

describe("efectos concretos tras un 429", () => {
  it("wardrobe DELETE: la prenda y su foto siguen y deleteImage no se llama; bajo el límite sí se borra la foto", async () => {
    const fx = await newUser(); session.userId = fx.userId;
    await seedCount(`wardrobe:delete:${fx.userId}`, 120);
    await rateLimited(await OPS[0]!.call(fx));
    expect(await t.prisma.wardrobeItem.count({ where: { id: fx.itemId } })).toBe(1);
    expect(cloud.deleteImage).not.toHaveBeenCalled();
    await seedCount(`wardrobe:delete:${fx.userId}`, 1);
    expect((await OPS[0]!.call(fx)).status).toBe(200);
    expect(cloud.deleteImage).toHaveBeenCalledTimes(1);
    expect(await t.prisma.wardrobeItem.count({ where: { id: fx.itemId } })).toBe(0);
  });
  it("try-on DELETE: la imagen sigue y deletePrivateImages no se llama; bajo el límite sí se borra", async () => {
    const fx = await newUser(); session.userId = fx.userId;
    await seedCount(`tryon:delete:${fx.userId}`, 60);
    await rateLimited(await OPS[1]!.call(fx));
    expect(await t.prisma.generatedImage.count({ where: { id: fx.imageId } })).toBe(1);
    expect(cloud.deletePrivateImages).not.toHaveBeenCalled();
    await seedCount(`tryon:delete:${fx.userId}`, 1);
    expect((await OPS[1]!.call(fx)).status).toBe(200);
    expect(cloud.deletePrivateImages).toHaveBeenCalledTimes(1);
    expect(await t.prisma.generatedImage.count({ where: { id: fx.imageId } })).toBe(0);
  });
  it("PATCH de favoritos: tras un 429 el favorito no cambia; bajo el límite sí cambia", async () => {
    const fx = await newUser(); session.userId = fx.userId;
    await seedCount(`wardrobe:update:${fx.userId}`, 300); await seedCount(`tryon:favorite:${fx.userId}`, 300); await seedCount(`outfit:favorite:${fx.userId}`, 300);
    for (const i of [2, 3, 4]) await rateLimited(await OPS[i]!.call(fx));
    expect((await t.prisma.wardrobeItem.findUniqueOrThrow({ where: { id: fx.itemId } })).isFavorite).toBe(false);
    expect((await t.prisma.generatedImage.findUniqueOrThrow({ where: { id: fx.imageId } })).isFavorite).toBe(false);
    expect((await t.prisma.outfit.findUniqueOrThrow({ where: { id: fx.outfitId } })).isFavorite).toBe(false);
    await seedCount(`wardrobe:update:${fx.userId}`, 1); await seedCount(`tryon:favorite:${fx.userId}`, 1); await seedCount(`outfit:favorite:${fx.userId}`, 1);
    for (const i of [2, 3, 4]) expect((await OPS[i]!.call(fx)).status).toBe(200);
    expect((await t.prisma.wardrobeItem.findUniqueOrThrow({ where: { id: fx.itemId } })).isFavorite).toBe(true);
    expect((await t.prisma.generatedImage.findUniqueOrThrow({ where: { id: fx.imageId } })).isFavorite).toBe(true);
    expect((await t.prisma.outfit.findUniqueOrThrow({ where: { id: fx.outfitId } })).isFavorite).toBe(true);
    expect(await t.prisma.outfitFeedback.count({ where: { outfitId: fx.outfitId, type: "SAVED" } })).toBe(1); // bajo el límite sí se aprende
    expect(learn).toHaveBeenCalledTimes(1);
  });
  it("consent POST: tras un 429 el consentimiento no cambia; bajo el límite sí", async () => {
    const fx = await newUser(); session.userId = fx.userId;
    await seedCount(`consent:set:${fx.userId}`, 20);
    await rateLimited(await OPS[5]!.call(fx));
    expect((await t.prisma.userProfile.findUniqueOrThrow({ where: { userId: fx.userId } })).aiPhotoConsent).toBe(false);
    await seedCount(`consent:set:${fx.userId}`, 1);
    expect((await OPS[5]!.call(fx)).status).toBe(200);
    expect((await t.prisma.userProfile.findUniqueOrThrow({ where: { userId: fx.userId } })).aiPhotoConsent).toBe(true);
  });
});

describe("alcance", () => {
  it("auth/logout queda fuera de esta fase: su ruta no usa el limitador", () => {
    const text = readFileSync("src/app/api/auth/logout/route.ts", "utf8");
    expect(text).not.toMatch(/rate-?limit/i);
  });
});
