import { z } from "zod";
import { POSE_KEYS, SCENARIO_KEYS } from "@/features/virtual-try-on/constants";

export const createTryOnSchema = z.object({
  outfitId: z.string().min(1).max(40),
  photoPublicId: z.string().min(1).max(200),
  scenario: z.enum(SCENARIO_KEYS),
  pose: z.enum(POSE_KEYS),
});
export const tryOnListSchema = z.object({ cursor: z.string().max(40).optional(), favorites: z.enum(["true"]).optional() });
export const tryOnPatchSchema = z.object({ isFavorite: z.boolean() });
