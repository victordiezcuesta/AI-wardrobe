import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { startTestDb, type TestDb } from "../helpers/db";
import { prismaProxy, setTestEnv } from "../helpers/mock-prisma";

const holder = vi.hoisted(() => ({ prisma: null as PrismaClient | null }));
const bg = vi.hoisted(() => ({ jobs: [] as (() => Promise<void>)[] }));
const PNG = vi.hoisted(() => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6]));
const provider = vi.hoisted(() => ({ edit: vi.fn(), uploaded: [] as string[], deleted: [] as string[][] }));

vi.mock("@/lib/prisma", () => ({ prisma: prismaProxy(holder) }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => Promise<void>) => { bg.jobs.push(fn); } }));
vi.mock("@/lib/pollinations/client", () => ({ editImage: provider.edit }));
vi.mock("@/lib/cloudinary", () => ({
  signedUrl: (id: string, o: { attachment?: boolean } = {}) => `https://api.cloudinary.com/signed/${id}${o.attachment ? "?dl=1" : ""}`,
  uploadPrivate: vi.fn(async (_b: Buffer, folder: string) => { const publicId = `${folder}/result-${provider.uploaded.length + 1}`; provider.uploaded.push(publicId); return { publicId, width: 1, height: 1 }; }),
  deletePrivateImages: vi.fn(async (ids: string[]) => { provider.deleted.push(ids); }),
}));

let t: TestDb;
beforeAll(async () => {
  setTestEnv();
  t = await startTestDb(); holder.prisma = t.prisma;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(PNG), { status: 200 })));
}, 60_000);
afterAll(async () => { await t?.stop(); vi.unstubAllGlobals(); });
beforeEach(() => { bg.jobs.length = 0; provider.edit.mockReset(); provider.edit.mockResolvedValue(PNG); });
const runBackground = async () => { while (bg.jobs.length) await bg.jobs.shift()!(); };

describe("probador virtual", () => {
  let u: string, stranger: string, outfitId: string;
  const photo = "ai-wardrobe/u/personal/foto1";
  const input = () => ({ outfitId, photoPublicId: photo, scenario: "studio" as const, pose: "standing" as const });

  beforeAll(async () => {
    u = (await t.prisma.user.create({ data: { email: "tryon@test.com", profile: { create: { photoPublicIds: [photo] } } } })).id;
    stranger = (await t.prisma.user.create({ data: { email: "intruso@test.com", profile: { create: { aiPhotoConsent: true, photoPublicIds: [] } } } })).id;
    const top = await t.prisma.wardrobeItem.create({ data: { userId: u, name: "Camiseta", category: "TSHIRT", imageUrl: "https://res.cloudinary.com/demo/image/upload/a.jpg", imagePublicId: "a" } });
    const bottom = await t.prisma.wardrobeItem.create({ data: { userId: u, name: "Vaqueros", category: "JEANS", imageUrl: "https://res.cloudinary.com/demo/image/upload/b.jpg", imagePublicId: "b" } });
    const noPhoto = await t.prisma.wardrobeItem.create({ data: { userId: u, name: "Bolso sin foto", category: "BAG" } });
    outfitId = (await t.prisma.outfit.create({ data: { userId: u, name: "Look", description: "d", items: { create: [{ itemId: top.id }, { itemId: bottom.id }, { itemId: noPhoto.id }] } } })).id;
  });

  it("sin consentimiento no se genera nada ni se llama al proveedor", async () => {
    const { tryOnService } = await import("@/services/tryon.service");
    await expect(tryOnService.create(u, input())).rejects.toMatchObject({ status: 403, code: "CONSENT_REQUIRED" });
    expect(await t.prisma.generatedImage.count({ where: { userId: u } })).toBe(0);
    expect(provider.edit).not.toHaveBeenCalled();
  });

  it("con consentimiento: responde al instante (PENDING) y genera en segundo plano", async () => {
    const { consentService } = await import("@/services/consent.service");
    const { tryOnService } = await import("@/services/tryon.service");
    await consentService.set(u, true);
    const dto = await tryOnService.create(u, input());
    expect(dto.status).toBe("PENDING");
    expect(dto.imageUrl).toBeNull();
    expect(provider.edit).not.toHaveBeenCalled(); // todavía no: va después de responder

    await runBackground();
    const done = await tryOnService.get(u, dto.id);
    expect(done.status).toBe("COMPLETED");
    expect(done.imageUrl).toMatch(/^https:\/\/api\.cloudinary\.com\/signed\//);
    expect(done.downloadUrl).toContain("dl=1");

    // El proveedor recibió: imagen 1 = persona, luego solo las prendas con foto; el prompt describe la sin foto.
    const call = provider.edit.mock.calls[0]![0] as { prompt: string; images: { name: string }[] };
    expect(call.images.map((i) => i.name)).toEqual(["person.jpg", "garment-1.jpg", "garment-2.jpg"]);
    expect(call.prompt).toContain("Image 1 is the identity reference");
    expect(call.prompt).toContain("Bolso sin foto");
    expect(provider.uploaded).toHaveLength(1);
    expect(await t.prisma.aiUsageLog.count({ where: { userId: u, task: "TRY_ON", success: true } })).toBe(1);
  });

  it("rechaza fotos y conjuntos ajenos", async () => {
    const { tryOnService } = await import("@/services/tryon.service");
    const { consentService } = await import("@/services/consent.service");
    await expect(tryOnService.create(stranger, input())).rejects.toMatchObject({ status: 404 }); // la foto no es suya
    await t.prisma.userProfile.update({ where: { userId: stranger }, data: { photoPublicIds: ["ai-wardrobe/s/personal/suya"] } });
    await expect(tryOnService.create(stranger, { ...input(), photoPublicId: "ai-wardrobe/s/personal/suya" })).rejects.toMatchObject({ status: 404 }); // el conjunto no es suyo
    expect((await consentService.status(stranger)).granted).toBe(true);
  });

  it("si el proveedor falla: FAILED con mensaje claro, reintento y límite de intentos", async () => {
    const { tryOnService } = await import("@/services/tryon.service");
    const { AppError } = await import("@/lib/errors");
    provider.edit.mockRejectedValue(new AppError("El probador virtual no está disponible en este momento. Inténtalo más tarde.", 503, "TRYON_NO_CREDITS"));
    const dto = await tryOnService.create(u, input());
    await runBackground();
    let cur = await tryOnService.get(u, dto.id);
    expect(cur).toMatchObject({ status: "FAILED", attempts: 1, errorMessage: "El probador virtual no está disponible en este momento. Inténtalo más tarde." });
    expect(cur.imageUrl).toBeNull();

    await tryOnService.retry(u, dto.id); await runBackground();
    cur = await tryOnService.get(u, dto.id);
    expect(cur.attempts).toBe(2);
    await tryOnService.retry(u, dto.id); await runBackground();
    await expect(tryOnService.retry(u, dto.id)).rejects.toMatchObject({ code: "MAX_ATTEMPTS" });

    provider.edit.mockResolvedValue(PNG);
    const ok = await tryOnService.create(u, input()); await runBackground();
    await expect(tryOnService.retry(u, ok.id)).rejects.toMatchObject({ code: "NOT_RETRYABLE" }); // solo las fallidas
  });

  it("un error inesperado no filtra detalles internos al usuario", async () => {
    const { tryOnService } = await import("@/services/tryon.service");
    provider.edit.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432 secreto-interno"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const dto = await tryOnService.create(u, input()); await runBackground();
    const cur = await tryOnService.get(u, dto.id);
    expect(cur.status).toBe("FAILED");
    expect(cur.errorMessage).not.toContain("ECONNREFUSED");
    expect(cur.errorMessage).not.toContain("secreto");
  });

  it("trabajos atascados se marcan como fallidos al consultarlos", async () => {
    const { tryOnService } = await import("@/services/tryon.service");
    const job = await t.prisma.generatedImage.create({ data: { userId: u, outfitId, sourcePhotoId: photo, scenario: "studio", pose: "standing", status: "PROCESSING" } });
    await t.prisma.$executeRawUnsafe(`UPDATE "GeneratedImage" SET "updatedAt" = NOW() - INTERVAL '10 minutes' WHERE id = '${job.id}'`);
    expect((await tryOnService.get(u, job.id)).status).toBe("FAILED");
  });

  it("limita los trabajos simultáneos y el favorito/borrado respetan al propietario", async () => {
    const { tryOnService } = await import("@/services/tryon.service");
    await t.prisma.generatedImage.deleteMany({ where: { userId: u, status: { in: ["PENDING", "PROCESSING"] } } });
    await tryOnService.create(u, input()); await tryOnService.create(u, input());
    await expect(tryOnService.create(u, input())).rejects.toMatchObject({ code: "TOO_MANY_ACTIVE" });
    await runBackground();

    const done = await t.prisma.generatedImage.findFirstOrThrow({ where: { userId: u, status: "COMPLETED" } });
    await expect(tryOnService.setFavorite(stranger, done.id, true)).rejects.toMatchObject({ status: 404 });
    await expect(tryOnService.remove(stranger, done.id)).rejects.toMatchObject({ status: 404 });
    expect((await tryOnService.setFavorite(u, done.id, true)).isFavorite).toBe(true);

    await tryOnService.remove(u, done.id);
    expect(provider.deleted.flat()).toContain(done.publicId);
    expect(await t.prisma.generatedImage.findUnique({ where: { id: done.id } })).toBeNull();
  });

  it("retirar el consentimiento bloquea nuevas generaciones y los trabajos pendientes", async () => {
    const { tryOnService } = await import("@/services/tryon.service");
    const { consentService } = await import("@/services/consent.service");
    await t.prisma.generatedImage.deleteMany({ where: { userId: u, status: { in: ["PENDING", "PROCESSING"] } } });
    const dto = await tryOnService.create(u, input());
    await consentService.set(u, false); // el usuario cambia de opinión antes de que arranque el trabajo
    await runBackground();
    expect(provider.edit).not.toHaveBeenCalled();
    expect((await tryOnService.get(u, dto.id)).status).toBe("FAILED");
    await expect(tryOnService.create(u, input())).rejects.toMatchObject({ code: "CONSENT_REQUIRED" });
  });
});
