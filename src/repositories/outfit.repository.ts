import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";

const include = {
  items: {
    include: { item: { select: { id: true, name: true, category: true, thumbUrl: true, primaryColor: true, status: true, style: true, formality: true } } },
  },
} satisfies Prisma.OutfitInclude;

export type OutfitWithItems = Prisma.OutfitGetPayload<{ include: typeof include }>;

export const outfitRepository = {
  create: (data: Prisma.OutfitCreateInput) => prisma.outfit.create({ data, include }),
  get: (userId: string, id: string) => prisma.outfit.findFirst({ where: { id, userId }, include }),
  async list(userId: string, scope: "recent" | "favorites", cursor?: string) {
    const rows = await prisma.outfit.findMany({
      where: { userId, discarded: false, ...(scope === "favorites" && { isFavorite: true }) },
      include, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 21,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    });
    const hasMore = rows.length > 20;
    const outfits = hasMore ? rows.slice(0, 20) : rows;
    return { outfits, nextCursor: hasMore ? (outfits[outfits.length - 1]?.id ?? null) : null };
  },
  recentSignatures: (userId: string, take = 12) =>
    prisma.outfit.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take, select: { name: true, discarded: true, items: { select: { itemId: true } } } }),
  async setFavorite(userId: string, id: string, isFavorite: boolean) {
    const r = await prisma.outfit.updateMany({ where: { id, userId }, data: { isFavorite } });
    return r.count > 0;
  },
  async update(userId: string, id: string, data: Prisma.OutfitUpdateManyMutationInput) {
    const r = await prisma.outfit.updateMany({ where: { id, userId }, data });
    return r.count > 0;
  },
};
