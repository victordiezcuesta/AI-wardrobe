import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import type { PrismaClient } from "@/generated/prisma/client";
import { startTestDb, type TestDb } from "../helpers/db";
import { prismaProxy, setTestEnv } from "../helpers/mock-prisma";

const holder = vi.hoisted(() => ({ prisma: null as PrismaClient | null }));
const cloud = vi.hoisted(() => ({ deleted: [] as string[], fail: false }));
const sess = vi.hoisted(() => ({ claims: null as { sub: string; sid: string } | null }));
// auth() simulado con la misma regla que el callback jwt real: el JWT solo vale si su sesión sigue viva en la base de datos.
vi.mock("@/lib/auth/index", async () => {
  const { sessionService } = await import("@/services/session.service");
  return { auth: async () => (sess.claims && (await sessionService.validate(sess.claims)) ? { user: { id: sess.claims.sub } } : null) };
});
vi.mock("@/lib/prisma", () => ({ prisma: prismaProxy(holder) }));
vi.mock("@/lib/cloudinary", () => ({
  deleteAllUserAssets: vi.fn(async (userId: string) => { if (cloud.fail) throw new Error("Cloudinary caído"); cloud.deleted.push(userId); }),
}));

let t: TestDb;
beforeAll(async () => { setTestEnv(); t = await startTestDb(); holder.prisma = t.prisma; }, 60_000);
afterAll(async () => { await t?.stop(); });

/** Ejecución de reconciliación a la que apuntan los MediaAsset de prueba (no pertenece a ningún usuario). */
let reconcileRunId: string | undefined;
async function reconcileRun() {
  reconcileRunId ??= (await t.prisma.mediaReconcileRun.create({ data: { fencingToken: 1, graceHours: 24 } })).id;
  return reconcileRunId;
}
const NOW = new Date("2026-11-20T00:00:00Z");
/** Candidatos de la reconciliación de medios: sin FK a User, solo `ownerUserId` (deben borrarse con la cuenta). */
async function mediaAssets(userId: string) {
  const runId = await reconcileRun();
  const base = { assetId: `asset-${userId}`, resourceCreatedAt: NOW, firstCandidateAt: NOW, lastCandidateAt: NOW, firstCandidateRunId: runId, lastCandidateRunId: runId, ownerUserId: userId };
  await t.prisma.mediaAsset.createMany({ data: [
    { ...base, publicId: `ai-wardrobe/${userId}/wardrobe/w1`, kind: "WARDROBE", delivery: "UPLOAD" },
    { ...base, publicId: `ai-wardrobe/${userId}/personal/p1`, kind: "PERSONAL", delivery: "AUTHENTICATED", ownerMissing: true },
  ] });
}
/** Tras un error de base de datos recibido por la conexión de Prisma, PGLiteSocketServer la cierra: se abre otra. */
const heal = async () => { await t.prisma.$queryRawUnsafe("SELECT 1").catch(() => undefined); await t.prisma.$queryRawUnsafe("SELECT 1"); };

async function seed(email: string, password: string) {
  const u = await t.prisma.user.create({ data: { email, name: "N", passwordHash: await bcrypt.hash(password, 4), profile: { create: { usualStyles: ["casual"], photoPublicIds: ["p1"], aiPhotoConsent: true } } } });
  const item = await t.prisma.wardrobeItem.create({ data: { userId: u.id, name: "Camisa", category: "SHIRT" } });
  const o = await t.prisma.outfit.create({ data: { userId: u.id, name: "Look", description: "d", items: { create: [{ itemId: item.id }] } } });
  await t.prisma.outfitFeedback.create({ data: { userId: u.id, outfitId: o.id, type: "LIKE" } });
  await t.prisma.outfitHistory.create({ data: { userId: u.id, outfitId: o.id } });
  await t.prisma.userPreference.create({ data: { userId: u.id, dimension: "color", key: "negro", score: 2 } });
  await t.prisma.favoriteItem.create({ data: { userId: u.id, kind: "item", refId: item.id } });
  await t.prisma.generatedImage.create({ data: { userId: u.id, outfitId: o.id, scenario: "studio", pose: "standing", status: "COMPLETED", publicId: "g1" } });
  await t.prisma.shoppingRecommendation.create({ data: { userId: u.id, batchId: "b1", gapLabel: "Camisa", gapReason: "r", searchQuery: "q", products: { create: [{ provider: "awin", externalId: "1", name: "P", store: "Mango", url: "https://x.example.com" }] } } });
  await t.prisma.aiUsageLog.create({ data: { userId: u.id, task: "ITEM_ANALYSIS", provider: "openrouter", model: "m" } });
  await t.prisma.verificationToken.create({ data: { identifier: email, token: `tok-${email}`, expires: new Date(Date.now() + 1e6) } });
  await t.prisma.$executeRawUnsafe(`INSERT INTO "RateLimit"("key","count") VALUES ('stylist:${u.id}', 3), ('login:${email}', 1)`);
  await mediaAssets(u.id);
  return u.id;
}
const counts = (id: string) => Promise.all([
  t.prisma.user.count({ where: { id } }), t.prisma.userProfile.count({ where: { userId: id } }), t.prisma.wardrobeItem.count({ where: { userId: id } }),
  t.prisma.outfit.count({ where: { userId: id } }), t.prisma.outfitItem.count({ where: { outfit: { userId: id } } }), t.prisma.outfitFeedback.count({ where: { userId: id } }),
  t.prisma.outfitHistory.count({ where: { userId: id } }), t.prisma.userPreference.count({ where: { userId: id } }), t.prisma.favoriteItem.count({ where: { userId: id } }),
  t.prisma.generatedImage.count({ where: { userId: id } }), t.prisma.shoppingRecommendation.count({ where: { userId: id } }), t.prisma.shoppingProduct.count({ where: { recommendation: { userId: id } } }),
  t.prisma.aiUsageLog.count({ where: { userId: id } }), t.prisma.mediaAsset.count({ where: { ownerUserId: id } }),
]);

describe("cuenta: exportación y eliminación", () => {
  let a: string, b: string;
  beforeAll(async () => { a = await seed("a@acct.com", "ClaveA-12345"); b = await seed("b@acct.com", "ClaveB-12345"); });

  it("la exportación incluye los datos del usuario y nunca secretos", async () => {
    const { accountService } = await import("@/services/account.service");
    const data = await accountService.export(a);
    const json = JSON.stringify(data);
    expect(data.items).toHaveLength(1);
    expect(data.outfits[0]!.feedback).toHaveLength(1);
    expect(data.shopping[0]!.products).toHaveLength(1);
    expect(json).not.toContain("passwordHash");
    expect(json).not.toContain("$2"); // ningún hash bcrypt
    expect(json).not.toContain("b@acct.com"); // ni datos de otro usuario
  });

  it("con contraseña incorrecta no se borra nada", async () => {
    const { accountService } = await import("@/services/account.service");
    await expect(accountService.delete(a, "incorrecta")).rejects.toMatchObject({ status: 403, code: "BAD_PASSWORD" });
    expect(cloud.deleted).toHaveLength(0);
    expect((await counts(a)).every((n) => n > 0)).toBe(true);
  });

  it("si Cloudinary falla no se elimina la cuenta (no quedan fotos sin dueño) y se puede reintentar", async () => {
    const { accountService } = await import("@/services/account.service");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    cloud.fail = true;
    await expect(accountService.delete(a, "ClaveA-12345")).rejects.toMatchObject({ status: 502, code: "ASSET_DELETE_FAILED" });
    expect((await counts(a)).every((n) => n > 0)).toBe(true);
    cloud.fail = false;
  });

  it("elimina definitivamente la cuenta y TODOS sus datos, sin tocar los de otros", async () => {
    const { accountService } = await import("@/services/account.service");
    const otherBefore = await counts(b);
    const runsBefore = await t.prisma.mediaReconcileRun.findMany({ orderBy: { id: "asc" } });
    const lockBefore = await t.prisma.mediaReconcileLock.findMany();
    expect(await t.prisma.mediaAsset.count({ where: { ownerUserId: a } })).toBe(2);
    await accountService.delete(a, "ClaveA-12345");

    expect(cloud.deleted).toEqual([a]); // se pidió borrar las imágenes de este usuario
    expect(await counts(a)).toEqual(Array(14).fill(0)); // 13 tablas dependientes + MediaAsset (sin FK), todas a cero
    // La reconciliación no es del usuario: sus ejecuciones y el lock quedan exactamente igual.
    expect(await t.prisma.mediaReconcileRun.findMany({ orderBy: { id: "asc" } })).toEqual(runsBefore);
    expect(await t.prisma.mediaReconcileLock.findMany()).toEqual(lockBefore);
    expect(await t.prisma.verificationToken.count({ where: { identifier: "a@acct.com" } })).toBe(0);
    const rl = await t.prisma.$queryRawUnsafe<{ key: string }[]>(`SELECT "key" FROM "RateLimit" WHERE "key" LIKE '%${a}'`);
    expect(rl).toHaveLength(0);
    expect(await counts(b)).toEqual(otherBefore); // el otro usuario, intacto
    expect(await t.prisma.verificationToken.count({ where: { identifier: "b@acct.com" } })).toBe(1);
    expect(await t.prisma.mediaAsset.count({ where: { ownerUserId: b } })).toBe(2); // los MediaAsset de otro, intactos
  });

  it("si la transacción falla al borrar la cuenta, no hay eliminación parcial: MediaAsset y el resto siguen intactos", async () => {
    const { accountService } = await import("@/services/account.service");
    const c = await seed("c@acct.com", "ClaveC-12345");
    const before = await counts(c);
    // Fallo REAL de PostgreSQL en el último paso de la transacción (borrar el usuario), después de MediaAsset.
    await t.prisma.$executeRawUnsafe(`CREATE FUNCTION test_block_user_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD."id" = '${c}' THEN RAISE EXCEPTION 'borrado bloqueado por la prueba'; END IF; RETURN OLD; END $$`);
    await t.prisma.$executeRawUnsafe(`CREATE TRIGGER test_block_user_delete BEFORE DELETE ON "User" FOR EACH ROW EXECUTE FUNCTION test_block_user_delete()`);
    try {
      await expect(accountService.delete(c, "ClaveC-12345")).rejects.toThrow(/borrado bloqueado por la prueba/);
      await heal();
      expect(await counts(c)).toEqual(before); // nada borrado, MediaAsset incluido
      expect(await t.prisma.mediaAsset.count({ where: { ownerUserId: c } })).toBe(2);
      expect(await t.prisma.verificationToken.count({ where: { identifier: "c@acct.com" } })).toBe(1);
      const rl = await t.prisma.$queryRawUnsafe<{ key: string }[]>(`SELECT "key" FROM "RateLimit" WHERE "key" LIKE '%${c}'`);
      expect(rl).toHaveLength(1);
    } finally {
      await heal();
      await t.prisma.$executeRawUnsafe(`DROP TRIGGER test_block_user_delete ON "User"`);
      await t.prisma.$executeRawUnsafe(`DROP FUNCTION test_block_user_delete()`);
    }
    // Sin el bloqueo, el reintento completa la eliminación (MediaAsset incluido).
    await accountService.delete(c, "ClaveC-12345");
    expect(await counts(c)).toEqual(Array(14).fill(0));
  });
});

describe("dashboard", () => {
  it("resume el armario con datos reales y encuentra el conjunto de hoy sin llamar a la IA", async () => {
    const { dashboardService, todayInTz } = await import("@/services/dashboard.service");
    const u = (await t.prisma.user.create({ data: { email: "dash@acct.com", name: "Lucía Pérez", profile: { create: {} } } })).id;
    await t.prisma.wardrobeItem.createMany({ data: [
      { userId: u, name: "a", category: "SHIRT" }, { userId: u, name: "b", category: "SHIRT", status: "DIRTY" },
      { userId: u, name: "c", category: "JEANS", needsReview: true },
    ] });
    await t.prisma.outfit.create({ data: { userId: u, name: "De hoy", description: "d", forDate: new Date() } });
    await t.prisma.outfit.create({ data: { userId: u, name: "De ayer", description: "d", forDate: new Date(Date.now() - 2 * 86_400_000) } });
    const d = await dashboardService.get(u);
    expect(d.name).toBe("Lucía Pérez");
    expect(d.wardrobe).toMatchObject({ total: 3, available: 2, dirty: 1, needsReview: 1 });
    expect(d.wardrobe.topCategories[0]).toEqual({ category: "SHIRT", count: 2 });
    expect(d.today?.name).toBe("De hoy");
    expect(d.recent.map((o) => o.name)).toEqual(["De ayer"]);
    expect(d.weather).toBeNull(); // sin ciudad configurada no se consulta el clima
    expect(todayInTz("Europe/Madrid", new Date("2026-11-17T23:30:00Z"))).toBe("2026-11-18"); // medianoche en Madrid ≠ UTC
  });
});

describe("sesiones de cuentas eliminadas", () => {
  it("un JWT anterior a la eliminación deja de dar acceso (401)", async () => {
    const { requireUserId } = await import("@/lib/auth/session");
    const { accountService } = await import("@/services/account.service");
    const { sessionService } = await import("@/services/session.service");
    const id = await seed("zombie@acct.com", "ClaveZ-12345");
    sess.claims = { sub: id, sid: await sessionService.start(id) };
    await expect(requireUserId()).resolves.toBe(id);
    await accountService.delete(id, "ClaveZ-12345");
    await expect(requireUserId()).rejects.toMatchObject({ status: 401 }); // el token sigue firmado, pero la cuenta (y su sesión, en cascada) ya no existe
    expect(await t.prisma.session.count({ where: { userId: id } })).toBe(0);
    sess.claims = null;
    await expect(requireUserId()).rejects.toMatchObject({ status: 401 }); // sin sesión
  });
});
