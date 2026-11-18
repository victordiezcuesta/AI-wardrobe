import { notFound } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { outfitRepository, type OutfitWithItems } from "@/repositories/outfit.repository";
import { wardrobeRepository } from "@/repositories/wardrobe.repository";
import { preferenceService, type FeedbackKind } from "./preference.service";

export interface LiteItem { id: string; name: string; category: string; thumbUrl: string | null; primaryColor: string | null }

export const outfitService = {
  /** Resuelve los ids de alternativas a prendas (siempre filtrando por usuario). */
  async alternativeItems(userId: string, outfits: OutfitWithItems[]): Promise<Record<string, LiteItem>> {
    const ids = [...new Set(outfits.flatMap((o) => o.items.flatMap((i) => i.alternatives)))];
    if (ids.length === 0) return {};
    const rows = await prisma.wardrobeItem.findMany({ where: { userId, id: { in: ids } }, select: { id: true, name: true, category: true, thumbUrl: true, primaryColor: true } });
    return Object.fromEntries(rows.map((r) => [r.id, r]));
  },

  list: (userId: string, scope: "recent" | "favorites", cursor?: string) => outfitRepository.list(userId, scope, cursor),

  async get(userId: string, id: string) {
    const o = await outfitRepository.get(userId, id);
    if (!o) throw notFound("Conjunto");
    return o;
  },

  async setFavorite(userId: string, id: string, isFavorite: boolean) {
    const outfit = await this.get(userId, id);
    await outfitRepository.setFavorite(userId, id, isFavorite);
    if (isFavorite && !outfit.isFavorite) {
      await prisma.outfitFeedback.create({ data: { userId, outfitId: id, type: "SAVED" } });
      await preferenceService.learn(userId, outfit, "SAVED");
    }
    return this.get(userId, id);
  },

  /** Registra la reacción del usuario y la convierte en aprendizaje de preferencias. */
  async feedback(userId: string, id: string, type: Exclude<FeedbackKind, "SAVED">, rating?: number) {
    const outfit = await this.get(userId, id);
    await prisma.outfitFeedback.create({ data: { userId, outfitId: id, type, rating } });
    await outfitRepository.update(userId, id, { ...(rating && { rating }), ...(type === "DISCARDED" && { discarded: true }) });
    if (type === "WORN") {
      await prisma.outfitHistory.create({ data: { userId, outfitId: id } });
      await wardrobeRepository.markWorn(userId, outfit.items.map((i) => i.itemId));
    }
    await preferenceService.learn(userId, outfit, type, rating);
    return this.get(userId, id);
  },
};
