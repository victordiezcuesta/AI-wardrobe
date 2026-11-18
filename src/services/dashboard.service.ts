import { env } from "@/lib/env";
import { logError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import type { WeatherSummary } from "@/lib/weather/open-meteo";
import { weatherService } from "./weather.service";

/** Fecha "YYYY-MM-DD" en la zona horaria de la app (no en UTC: cerca de medianoche difieren). */
export const todayInTz = (tz = env().APP_TIMEZONE, now = new Date()) => now.toLocaleDateString("en-CA", { timeZone: tz });

export const dashboardService = {
  async get(userId: string) {
    const today = todayInTz();
    const [user, profile, statusCounts, categoryCounts, needsReview, recent, gapsBatch] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { name: true } }),
      prisma.userProfile.findUnique({ where: { userId }, select: { homeCity: true, homeLat: true, homeLon: true } }),
      prisma.wardrobeItem.groupBy({ by: ["status"], where: { userId }, _count: { _all: true } }),
      prisma.wardrobeItem.groupBy({ by: ["category"], where: { userId }, _count: { _all: true }, orderBy: { _count: { category: "desc" } }, take: 4 }),
      prisma.wardrobeItem.count({ where: { userId, needsReview: true } }),
      prisma.outfit.findMany({
        where: { userId, discarded: false }, orderBy: { createdAt: "desc" }, take: 12,
        include: { items: { include: { item: { select: { id: true, name: true, thumbUrl: true, primaryColor: true } } } } },
      }),
      prisma.shoppingRecommendation.findFirst({ where: { userId }, orderBy: { createdAt: "desc" }, select: { batchId: true } }),
    ]);

    let weather: WeatherSummary | null = null;
    if (profile?.homeLat != null && profile.homeLon != null) {
      try { weather = await weatherService.getForecast(profile.homeLat, profile.homeLon, today); }
      catch (e) { logError("dashboard.weather", e); } // el clima no es imprescindible: el resto del inicio sigue funcionando
    }

    const gaps = gapsBatch
      ? await prisma.shoppingRecommendation.findMany({ where: { userId, batchId: gapsBatch.batchId }, select: { gapLabel: true, _count: { select: { products: true } } }, take: 4, orderBy: { createdAt: "asc" } })
      : [];

    const byStatus = Object.fromEntries(statusCounts.map((s) => [s.status, s._count._all])) as Record<string, number>;
    // "Recomendación del día": un conjunto ya generado para la fecha de hoy; no se llama a la IA desde el inicio.
    const todays = recent.find((o) => o.forDate && todayInTz(env().APP_TIMEZONE, o.forDate) === today) ?? null;

    return {
      name: user?.name ?? null,
      home: profile?.homeCity ? { name: profile.homeCity } : null,
      weather,
      wardrobe: {
        total: Object.values(byStatus).reduce((a, b) => a + b, 0),
        available: byStatus.AVAILABLE ?? 0, dirty: byStatus.DIRTY ?? 0, unavailable: byStatus.UNAVAILABLE ?? 0, needsReview,
        topCategories: categoryCounts.map((c) => ({ category: c.category, count: c._count._all })),
      },
      today: todays, recent: recent.filter((o) => o.id !== todays?.id).slice(0, 3),
      gaps: gaps.map((g) => ({ label: g.gapLabel, products: g._count.products })),
    };
  },
};
