import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";

export const weatherCacheRepository = {
  async get(cacheKey: string) {
    const row = await prisma.weatherCache.findUnique({ where: { cacheKey } });
    return row && row.expiresAt > new Date() ? row.payload : null;
  },
  async set(cacheKey: string, latitude: number, longitude: number, forDate: string, payload: Prisma.InputJsonValue, ttlMs: number) {
    const expiresAt = new Date(Date.now() + ttlMs);
    await prisma.weatherCache.upsert({
      where: { cacheKey },
      create: { cacheKey, latitude, longitude, forDate, payload, expiresAt },
      update: { payload, expiresAt, fetchedAt: new Date() },
    });
  },
  purgeExpired: () => prisma.weatherCache.deleteMany({ where: { expiresAt: { lt: new Date() } } }),
};
