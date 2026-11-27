import { z } from "zod";
import "./messages"; // mensajes de validación en español (efecto secundario; ver messages.ts)
import { CATEGORIES, COLORS } from "@/features/wardrobe/constants";

const STORABLE = CATEGORIES.filter((c) => c !== "OTHER") as [Exclude<(typeof CATEGORIES)[number], "OTHER">, ...Exclude<(typeof CATEGORIES)[number], "OTHER">[]];

export const gapsSchema = z.object({
  gaps: z.array(z.object({
    label: z.string().trim().min(2).max(80),
    category: z.enum(STORABLE),
    color: z.enum(COLORS).nullable(),
    reason: z.string().trim().min(5).max(400),
    combinesWith: z.array(z.string().max(12)).max(6),
    searchTerms: z.array(z.string().trim().min(2).max(40)).max(3),
  })).min(1).max(6),
});
export type GapsOutput = z.infer<typeof gapsSchema>;

export const rankingSchema = z.object({
  gaps: z.array(z.object({
    gap: z.string().max(12),
    ranking: z.array(z.object({
      productId: z.string().max(12),
      score: z.number().min(0).max(100),
      reason: z.string().trim().min(5).max(300),
      combinesWith: z.array(z.string().max(12)).max(5),
    })).max(8),
  })).max(6),
});
export type RankingOutput = z.infer<typeof rankingSchema>;

export const recommendBodySchema = z.object({ force: z.boolean().optional() });
