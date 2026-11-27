import { z } from "zod";
import "./messages"; // mensajes de validación en español (efecto secundario; ver messages.ts)
import { CATEGORIES, COLORS, SEASONS, STATUSES } from "@/features/wardrobe/constants";

const tags = z.array(z.string().trim().min(1).max(40)).max(12);

/** Lo que devuelve el modelo multimodal por cada prenda detectada. */
export const detectedItemSchema = z.object({
  name: z.string().trim().min(1).max(80),
  category: z.enum(CATEGORIES),
  subcategory: z.string().trim().max(60).nullable(),
  primaryColor: z.enum(COLORS).nullable(),
  secondaryColors: z.array(z.enum(COLORS)).max(4),
  pattern: z.string().trim().max(40).nullable(),
  material: z.string().trim().max(60).nullable(),
  style: tags,
  seasons: z.array(z.enum(SEASONS)).max(5),
  formality: z.number().int().min(1).max(5).nullable(),
  occasions: tags,
  visualTraits: tags,
  description: z.string().trim().max(400).nullable(),
  confidence: z.number().min(0).max(1),
  uncertainFields: z.array(z.string().max(40)).max(12),
  box: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).nullable(),
});
export type DetectedItem = z.infer<typeof detectedItemSchema>;

export const analysisSchema = z.object({ items: z.array(detectedItemSchema).max(12) });

const editable = z.object({
  name: z.string().trim().min(1).max(80),
  category: z.enum(CATEGORIES),
  subcategory: z.string().trim().max(60).nullable(),
  description: z.string().trim().max(400).nullable(),
  primaryColor: z.enum(COLORS).nullable(),
  secondaryColors: z.array(z.enum(COLORS)).max(4),
  pattern: z.string().trim().max(40).nullable(),
  material: z.string().trim().max(60).nullable(),
  style: tags,
  seasons: z.array(z.enum(SEASONS)).max(5),
  formality: z.number().int().min(1).max(5).nullable(),
  occasions: tags,
  isFavorite: z.boolean(),
  status: z.enum(STATUSES),
  needsReview: z.boolean(),
});

export const createItemSchema = editable.partial().required({ name: true, category: true });
export const updateItemSchema = editable.partial().refine((v) => Object.keys(v).length > 0, { message: "Sin cambios" });

export const listQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  category: z.enum(CATEGORIES).optional(),
  color: z.enum(COLORS).optional(),
  season: z.enum(SEASONS).optional(),
  status: z.enum(STATUSES).optional(),
  favorite: z.enum(["true"]).optional(),
  needsReview: z.enum(["true"]).optional(),
  cursor: z.string().max(40).optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;
