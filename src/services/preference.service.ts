import { preferenceRepository } from "@/repositories/preference.repository";
import type { OutfitWithItems } from "@/repositories/outfit.repository";

export type FeedbackKind = "LIKE" | "DISLIKE" | "WORN" | "DISCARDED" | "SAVED";

const DELTA: Record<FeedbackKind, number> = { LIKE: 1, DISLIKE: -1, WORN: 1.5, DISCARDED: -1.5, SAVED: 1 };
const CLAMP = 8;
const clamp = (n: number) => Math.max(-CLAMP, Math.min(CLAMP, n));

export const formalityBand = (f: number | null) => (f == null ? null : f <= 2 ? "informal" : f === 3 ? "media" : "formal");

/** Dimensiones afectadas por un conjunto: color, estilo, categoría, formalidad y prenda concreta. */
export function outfitKeys(outfit: OutfitWithItems): { dimension: string; key: string }[] {
  const keys = new Map<string, { dimension: string; key: string }>();
  const add = (dimension: string, key: string | null | undefined) => { if (key) keys.set(`${dimension}:${key}`, { dimension, key }); };
  const formalities: number[] = [];
  for (const { item } of outfit.items) {
    add("color", item.primaryColor); add("category", item.category); add("item", item.id);
    item.style.forEach((s) => add("style", s.toLowerCase()));
    if (item.formality != null) formalities.push(item.formality);
  }
  if (formalities.length) add("formality", formalityBand(Math.round(formalities.reduce((a, b) => a + b, 0) / formalities.length)));
  return [...keys.values()];
}

export const preferenceService = {
  async learn(userId: string, outfit: OutfitWithItems, kind: FeedbackKind, rating?: number) {
    const keys = outfitKeys(outfit);
    if (keys.length === 0) return;
    const delta = DELTA[kind] + (rating ? (rating - 3) * 0.5 : 0);
    const existing = await preferenceRepository.forKeys(userId, keys);
    const current = new Map(existing.map((e) => [`${e.dimension}:${e.key}`, e.score]));
    await preferenceRepository.upsertMany(userId, keys.map((k) => ({
      ...k,
      // El peso de una prenda concreta es menor: evita repetirla sin vetar para siempre un color o estilo.
      score: clamp((current.get(`${k.dimension}:${k.key}`) ?? 0) + (k.dimension === "item" ? delta * 0.5 : delta)),
    })));
  },

  /** Resumen legible para el prompt: lo que el usuario suele aceptar y lo que suele descartar. */
  async summary(userId: string) {
    const rows = await preferenceRepository.top(userId);
    const fmt = (r: { dimension: string; key: string }) => `${r.dimension}=${r.key}`;
    return {
      likes: rows.filter((r) => r.score >= 1).slice(0, 8).map(fmt),
      dislikes: rows.filter((r) => r.score <= -1).reverse().slice(0, 8).map(fmt),
    };
  },

  async itemScores(userId: string) {
    return new Map((await preferenceRepository.itemScores(userId)).map((r) => [r.key, r.score]));
  },
};
