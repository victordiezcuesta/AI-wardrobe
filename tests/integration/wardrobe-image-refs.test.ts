import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { startTestDb, type TestDb } from "../helpers/db";
import { prismaProxy, setTestEnv } from "../helpers/mock-prisma";

/**
 * Fase 19.1 — Route Handlers REALES de alta y edición de prendas contra PostgreSQL (PGlite): un cliente no puede asociar
 * un public_id ni una URL de imagen existentes; las referencias creadas por el servicio interno se conservan.
 */
const holder = vi.hoisted(() => ({ prisma: null as PrismaClient | null }));
const session = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/lib/prisma", () => ({ prisma: prismaProxy(holder) }));
vi.mock("@/lib/auth/session", () => ({ requireUserId: async () => session.userId }));

let t: TestDb;
beforeAll(async () => { setTestEnv(); t = await startTestDb(); holder.prisma = t.prisma; }, 60_000);
afterAll(async () => { await t?.stop(); });
beforeEach(async () => { await t.prisma.$executeRawUnsafe(`TRUNCATE "User", "RateLimit" CASCADE`); });

const BASE = "http://localhost:3000";
async function newUser() {
  const u = await t.prisma.user.create({ data: { email: `w${Math.random().toString(36).slice(2)}@q.com` } });
  session.userId = u.id;
  return u;
}
const victim = (id: string) => `ai-wardrobe/${id}/wardrobe/foto-ajena`;
const injected = (owner: string) => ({
  imagePublicId: victim(owner),
  imageUrl: `https://res.cloudinary.com/demo/image/upload/v1/${victim(owner)}`,
  thumbUrl: `https://res.cloudinary.com/demo/image/upload/c_fill,w_480/v1/${victim(owner)}`,
});
const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("POST /api/wardrobe (alta manual)", () => {
  it("los campos de imagen enviados por el cliente se ignoran: la prenda se crea sin imagen", async () => {
    const other = await newUser();
    const u = await newUser();
    const { POST } = await import("@/app/api/wardrobe/route");
    const res = await POST(new Request(`${BASE}/api/wardrobe`, json({ name: "Camisa", category: "SHIRT", ...injected(other.id), userId: other.id })));
    expect(res.status).toBe(201);
    const { item } = await res.json() as { item: { id: string } };
    const row = await t.prisma.wardrobeItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(row).toMatchObject({ userId: u.id, imagePublicId: null, imageUrl: null, thumbUrl: null });
  });
});

describe("PATCH /api/wardrobe/[id] (edición)", () => {
  const patch = async (id: string, body: unknown) => {
    const { PATCH } = await import("@/app/api/wardrobe/[id]/route");
    return PATCH(new Request(`${BASE}/api/wardrobe/${id}`, { ...json(body), method: "PATCH" }), { params: Promise.resolve({ id }) });
  };

  it("la referencia creada por el servicio interno se conserva aunque el cliente intente sustituirla", async () => {
    const other = await newUser();
    const u = await newUser();
    const { wardrobeRepository } = await import("@/repositories/wardrobe.repository");
    const own = `ai-wardrobe/${u.id}/wardrobe/propia`;
    // Mismo camino que createFromUpload → persistOrDiscard: el repositorio con el resultado de la subida propia.
    const created = await wardrobeRepository.create(u.id, {
      name: "Subida", category: "OTHER", imagePublicId: own,
      imageUrl: `https://res.cloudinary.com/demo/image/upload/v1/${own}`, thumbUrl: `https://res.cloudinary.com/demo/image/upload/c_fill/v1/${own}`,
    });
    const res = await patch(created.id, { name: "Renombrada", ...injected(other.id) });
    expect(res.status).toBe(200);
    const row = await t.prisma.wardrobeItem.findUniqueOrThrow({ where: { id: created.id } });
    expect(row).toMatchObject({ name: "Renombrada", imagePublicId: own, imageUrl: created.imageUrl, thumbUrl: created.thumbUrl });
  });

  it("una edición con SOLO campos de imagen se rechaza (422, validación) y no cambia nada", async () => {
    const other = await newUser();
    const u = await newUser();
    const row = await t.prisma.wardrobeItem.create({ data: { userId: u.id, name: "Sin foto", category: "OTHER" } });
    const res = await patch(row.id, injected(other.id));
    expect(res.status).toBe(422);
    expect(await t.prisma.wardrobeItem.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
  });
});
