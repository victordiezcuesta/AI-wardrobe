import { z } from "zod";

export const stylistRequestSchema = z.object({
  location: z.object({
    name: z.string().trim().min(1).max(120),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  }),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  occasion: z.string().trim().min(2).max(200),
  activity: z.string().trim().max(200).optional(),
  formality: z.number().int().min(1).max(5).optional(),
  style: z.string().trim().max(60).optional(),
  notes: z.string().trim().max(500).optional(),
});
export type StylistRequest = z.infer<typeof stylistRequestSchema>;

/** Salida del modelo. Los ids son alias cortos (i1, i2…) que el servidor traduce y valida. */
export const aiOutfitsSchema = z.object({
  outfits: z.array(z.object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(500),
    occasion: z.string().trim().max(120),
    reasoning: z.string().trim().max(700),
    colorExplanation: z.string().trim().max(400),
    weatherFit: z.string().trim().max(400),
    styleFit: z.string().trim().max(400),
    // Longitudes holgadas a propósito: un id mal formado debe descartar SOLO ese conjunto (lo decide validateOutfits), no toda la respuesta.
    itemIds: z.array(z.string().max(60)).min(1).max(12),
    alternatives: z.array(z.object({ itemId: z.string().max(60), replacesItemId: z.string().max(60), reason: z.string().trim().max(200) })).max(10),
  })).min(1).max(5),
});
export type AiOutfits = z.infer<typeof aiOutfitsSchema>;

export const feedbackSchema = z.object({
  type: z.enum(["LIKE", "DISLIKE", "WORN", "DISCARDED"]),
  rating: z.number().int().min(1).max(5).optional(),
});
export const outfitPatchSchema = z.object({ isFavorite: z.boolean() });
export const outfitListSchema = z.object({
  scope: z.enum(["recent", "favorites"]).default("recent"),
  cursor: z.string().max(40).optional(),
});
