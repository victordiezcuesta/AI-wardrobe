import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { startTestDb, type TestDb } from "../helpers/db";
import { prismaProxy, setTestEnv } from "../helpers/mock-prisma";

const holder = vi.hoisted(() => ({ prisma: null as PrismaClient | null }));
vi.mock("@/lib/prisma", () => ({ prisma: prismaProxy(holder) }));

let t: TestDb;
let infoSpy: ReturnType<typeof vi.spyOn>;
beforeAll(async () => { setTestEnv(); t = await startTestDb(); holder.prisma = t.prisma; }, 60_000);
afterAll(async () => { await t?.stop(); });
beforeEach(() => { infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined); });

/** El correo (sin SMTP) se imprime en consola: de ahí se extrae el token en claro, como haría el usuario desde su email. */
function lastToken(): string {
  const calls = infoSpy.mock.calls.map((c: unknown[]) => String(c[0]));
  const m = calls.reverse().map((c: string) => /token=([a-f0-9]{64})/.exec(c)).find(Boolean);
  if (!m) throw new Error("No se envió ningún enlace con token");
  return m[1]!;
}

describe("autenticación", () => {
  const pass = "Abcdefghi1";
  it("registra, no deja iniciar sesión sin verificar y sí después", async () => {
    const { authService } = await import("@/services/auth.service");
    await authService.register({ email: "ana@test.com", password: pass, name: "Ana" });

    const user = await t.prisma.user.findUniqueOrThrow({ where: { email: "ana@test.com" }, include: { profile: true } });
    expect(user.passwordHash).toMatch(/^\$2[aby]\$12\$/); // bcrypt coste 12
    expect(user.passwordHash).not.toContain(pass);
    expect(user.profile).not.toBeNull();

    expect(await authService.verifyCredentials("ana@test.com", pass)).toBeNull(); // email sin verificar
    const raw = lastToken();
    const stored = await t.prisma.verificationToken.findFirstOrThrow({ where: { identifier: "ana@test.com" } });
    expect(stored.token).not.toBe(raw); // en la base de datos solo está el hash
    expect(stored.token).toHaveLength(64);

    await authService.verifyEmail(raw);
    expect(await authService.verifyCredentials("ana@test.com", pass)).toMatchObject({ email: "ana@test.com" });
    expect(await authService.verifyCredentials("ana@test.com", "otra-Contraseña1")).toBeNull();
    expect(await authService.verifyCredentials("nadie@test.com", pass)).toBeNull();
  });

  it("el enlace de verificación es de un solo uso", async () => {
    const { authService } = await import("@/services/auth.service");
    await authService.register({ email: "uno@test.com", password: pass });
    const raw = lastToken();
    await authService.verifyEmail(raw);
    await expect(authService.verifyEmail(raw)).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  });

  it("registrar un email existente no revela nada ni duplica", async () => {
    const { authService } = await import("@/services/auth.service");
    const before = await t.prisma.verificationToken.count();
    await expect(authService.register({ email: "ana@test.com", password: pass })).resolves.toBeUndefined();
    expect(await t.prisma.user.count({ where: { email: "ana@test.com" } })).toBe(1);
    expect(await t.prisma.verificationToken.count()).toBe(before);
  });

  it("recuperación de contraseña: caduca, cambia la clave y no se reutiliza", async () => {
    const { authService } = await import("@/services/auth.service");
    const tokensBefore = await t.prisma.verificationToken.count();
    await authService.requestReset("desconocido@test.com"); // no existe: sin error ni token
    expect(await t.prisma.verificationToken.count()).toBe(tokensBefore);

    await authService.requestReset("ana@test.com");
    const raw = lastToken();
    await authService.resetPassword(raw, "NuevaClave12345");
    expect(await authService.verifyCredentials("ana@test.com", "NuevaClave12345")).not.toBeNull();
    expect(await authService.verifyCredentials("ana@test.com", pass)).toBeNull();
    await expect(authService.resetPassword(raw, "OtraClave123456")).rejects.toMatchObject({ code: "INVALID_TOKEN" });

    await authService.requestReset("ana@test.com");
    const expired = lastToken();
    await t.prisma.verificationToken.updateMany({ where: { kind: "RESET_PASSWORD" }, data: { expires: new Date(Date.now() - 1000) } });
    await expect(authService.resetPassword(expired, "ClaveCaducada123")).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  });
});

describe("aislamiento entre usuarios (autorización a nivel de backend)", () => {
  let a: string, b: string, itemA: string, outfitA: string;
  beforeAll(async () => {
    a = (await t.prisma.user.create({ data: { email: "iso-a@test.com" } })).id;
    b = (await t.prisma.user.create({ data: { email: "iso-b@test.com" } })).id;
    const item = await t.prisma.wardrobeItem.create({ data: { userId: a, name: "Camisa de A", category: "SHIRT", imagePublicId: "pid-a" } });
    itemA = item.id;
    const o = await t.prisma.outfit.create({ data: { userId: a, name: "Look A", description: "d", items: { create: [{ itemId: itemA }] } } });
    outfitA = o.id;
  });

  it("un usuario no puede leer, editar ni borrar prendas ajenas", async () => {
    const { wardrobeRepository } = await import("@/repositories/wardrobe.repository");
    const { wardrobeService } = await import("@/services/wardrobe.service");
    expect(await wardrobeRepository.get(b, itemA)).toBeNull();
    expect(await wardrobeRepository.update(b, itemA, { name: "robada" })).toBeNull();
    expect(await wardrobeRepository.delete(b, itemA)).toBe(false);
    expect((await wardrobeRepository.list(b, {})).items).toHaveLength(0);
    await expect(wardrobeService.get(b, itemA)).rejects.toMatchObject({ status: 404 });
    await expect(wardrobeService.update(b, itemA, { name: "x" })).rejects.toMatchObject({ status: 404 });
    await expect(wardrobeService.remove(b, itemA)).rejects.toMatchObject({ status: 404 });
    expect((await t.prisma.wardrobeItem.findUniqueOrThrow({ where: { id: itemA } })).name).toBe("Camisa de A"); // intacta
  });

  it("el dueño sí puede, y los filtros no cruzan datos", async () => {
    const { wardrobeRepository } = await import("@/repositories/wardrobe.repository");
    expect((await wardrobeRepository.list(a, { q: "camisa" })).items).toHaveLength(1);
    expect((await wardrobeRepository.update(a, itemA, { isFavorite: true }))?.isFavorite).toBe(true);
  });

  it("no se pueden ver ni valorar conjuntos ajenos", async () => {
    const { outfitService } = await import("@/services/outfit.service");
    await expect(outfitService.get(b, outfitA)).rejects.toMatchObject({ status: 404 });
    await expect(outfitService.feedback(b, outfitA, "LIKE")).rejects.toMatchObject({ status: 404 });
    await expect(outfitService.setFavorite(b, outfitA, true)).rejects.toMatchObject({ status: 404 });
    expect(await t.prisma.outfitFeedback.count({ where: { outfitId: outfitA } })).toBe(0);
  });

  it("una foto personal ajena no figura como propia", async () => {
    const { photoService } = await import("@/services/photo.service");
    await t.prisma.userProfile.create({ data: { userId: a, photoPublicIds: ["ai-wardrobe/a/personal/p1"] } });
    expect(await photoService.owns(a, "ai-wardrobe/a/personal/p1")).toBe(true);
    expect(await photoService.owns(b, "ai-wardrobe/a/personal/p1")).toBe(false);
  });
});

describe("límite de uso y cuotas de IA", () => {
  it("rate limit: bloquea al pasar el máximo y se reinicia al acabar la ventana", async () => {
    const { rateLimit } = await import("@/lib/rate-limit");
    await rateLimit("t:key", 2, 60);
    await rateLimit("t:key", 2, 60);
    await expect(rateLimit("t:key", 2, 60)).rejects.toMatchObject({ status: 429, code: "RATE_LIMITED" });
    await rateLimit("t:otra", 2, 60); // otra clave no se ve afectada
    await t.prisma.$executeRawUnsafe(`UPDATE "RateLimit" SET "windowStart" = NOW() - INTERVAL '2 minutes' WHERE "key" = 't:key'`);
    await expect(rateLimit("t:key", 2, 60)).resolves.toBeUndefined();
  });

  it("cuota diaria de IA: corta al agotarla y la del probador es independiente", async () => {
    const { aiUsageService } = await import("@/services/ai-usage.service");
    const u = (await t.prisma.user.create({ data: { email: "cuota@test.com" } })).id;
    await t.prisma.aiUsageLog.createMany({ data: Array.from({ length: 60 }, () => ({ userId: u, task: "ITEM_ANALYSIS" as const, provider: "openrouter", model: "m" })) });
    await expect(aiUsageService.assertQuota(u)).rejects.toMatchObject({ status: 429 });
    await expect(aiUsageService.assertQuota(u, "TRY_ON")).resolves.toBeUndefined(); // 0 de 10 usados
    await t.prisma.aiUsageLog.createMany({ data: Array.from({ length: 10 }, () => ({ userId: u, task: "TRY_ON" as const, provider: "pollinations", model: "m" })) });
    await expect(aiUsageService.assertQuota(u, "TRY_ON")).rejects.toMatchObject({ status: 429 });
  });
});
