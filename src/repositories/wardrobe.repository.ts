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
  summary: (userId: string) =>
    prisma.wardrobeItem.groupBy({ by: ["status"], where: { userId }, _count: { _all: true } }),
};
