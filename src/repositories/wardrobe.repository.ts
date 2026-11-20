import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type { ListQuery } from "@/lib/validations/wardrobe";

const PAGE = 60;

// Toda consulta lleva userId en el where: un usuario nunca puede tocar prendas ajenas.
export const wardrobeRepository = {
  async list(userId: string, f: ListQuery) {
    const where: Prisma.WardrobeItemWhereInput = {
      userId,
      ...(f.q && { name: { contains: f.q, mode: "insensitive" } }),
      ...(f.category && { category: f.category }),
      ...(f.color && { primaryColor: f.color }),
      ...(f.season && { seasons: { has: f.season } }),
      ...(f.status && { status: f.status }),
      ...(f.favorite && { isFavorite: true }),
      ...(f.needsReview && { needsReview: true }),
    };
    const rows = await prisma.wardrobeItem.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: PAGE + 1,
      ...(f.cursor && { cursor: { id: f.cursor }, skip: 1 }),
    });
    const hasMore = rows.length > PAGE;
    const items = hasMore ? rows.slice(0, PAGE) : rows;
    return { items, nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null };
  },
  get: (userId: string, id: string) => prisma.wardrobeItem.findFirst({ where: { id, userId } }),
  create: (userId: string, data: Omit<Prisma.WardrobeItemUncheckedCreateInput, "userId">) =>
    prisma.wardrobeItem.create({ data: { ...data, userId } }),
  async update(userId: string, id: string, data: Prisma.WardrobeItemUpdateInput) {
    const res = await prisma.wardrobeItem.updateMany({ where: { id, userId }, data });
    return res.count === 0 ? null : prisma.wardrobeItem.findFirst({ where: { id, userId } });
  },
  async delete(userId: string, id: string) {
    const res = await prisma.wardrobeItem.deleteMany({ where: { id, userId } });
    return res.count > 0;
  },
  listAvailable: (userId: string) => prisma.wardrobeItem.findMany({ where: { userId, status: "AVAILABLE" }, orderBy: { createdAt: "desc" }, take: 400 }),
  markWorn: (userId: string, itemIds: string[]) =>
    prisma.wardrobeItem.updateMany({ where: { userId, id: { in: itemIds } }, data: { wearCount: { increment: 1 }, lastWornAt: new Date() } }),
  countByImage: (userId: string, publicId: string) => prisma.wardrobeItem.count({ where: { userId, imagePublicId: publicId } }),
  findByImage: (userId: string, publicId: string) =>
    prisma.wardrobeItem.findFirst({ where: { userId, imagePublicId: publicId }, orderBy: { createdAt: "desc" } }),
  /**
   * Comprobación de seguridad ANTES de borrar una imagen: ¿la usa alguna prenda, de cualquier usuario? Única consulta
   * sin userId (una imagen nunca debe borrarse si otra fila la referencia); solo devuelve un booleano, ningún dato.
   */
  isImageReferenced: async (publicId: string) => (await prisma.wardrobeItem.count({ where: { imagePublicId: publicId } })) > 0,
  /**
   * Quita una prenda que comparte foto SOLO si la foto sigue usada por otra; si es la última, no borra nada y devuelve
   * "last" para que el llamador borre primero la foto (y conserve la prenda si eso falla). Bloquea con FOR UPDATE, en
   * orden de id (sin interbloqueos), todas las prendas del usuario con esa foto: dos borrados simultáneos se
   * serializan y el segundo ve el resultado del primero, así que nunca deciden ambos «aún hay otra».
   * "missing": la prenda ya no existe (otro borrado se adelantó) o ya no usa esa foto.
   */
  removeIfImageShared: (userId: string, id: string, publicId: string) =>
    prisma.$transaction(async (tx): Promise<"removed" | "last" | "missing"> => {
      const refs = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "WardrobeItem"
        WHERE "userId" = ${userId} AND "imagePublicId" = ${publicId} ORDER BY "id" FOR UPDATE`;
      if (!refs.some((r) => r.id === id)) return "missing";
      if (refs.length === 1) return "last";
      await tx.wardrobeItem.deleteMany({ where: { id, userId } });
      return "removed";
    }),
  summary: (userId: string) =>
    prisma.wardrobeItem.groupBy({ by: ["status"], where: { userId }, _count: { _all: true } }),
};
