import { prisma } from "@/lib/prisma";

export const preferenceRepository = {
  forKeys: (userId: string, keys: { dimension: string; key: string }[]) =>
    prisma.userPreference.findMany({ where: { userId, OR: keys.map((k) => ({ dimension: k.dimension, key: k.key })) } }),
  upsertMany: (userId: string, rows: { dimension: string; key: string; score: number }[]) =>
    prisma.$transaction(rows.map((r) => prisma.userPreference.upsert({
      where: { userId_dimension_key: { userId, dimension: r.dimension, key: r.key } },
      create: { userId, ...r }, update: { score: r.score },
    }))),
  top: (userId: string) => prisma.userPreference.findMany({ where: { userId, dimension: { not: "item" } }, orderBy: { score: "desc" } }),
  itemScores: (userId: string) => prisma.userPreference.findMany({ where: { userId, dimension: "item" } }),
};
