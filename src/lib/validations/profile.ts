import { z } from "zod";
import "./messages"; // mensajes de validación en español (efecto secundario; ver messages.ts)

/**
 * Lista opcional SIN valor por defecto: en un PUT parcial, una lista omitida queda `undefined` y Prisma no la toca;
 * `[]` explícito la vacía. (Con `.default([])`, omitirla la borraba.) Al crear el perfil, la columna ya tiene
 * DEFAULT ARRAY[] en la base de datos.
 */
const tags = (max = 20) => z.array(z.string().trim().min(1).max(40)).max(max).optional();

export const profileSchema = z.object({
  name: z.string().trim().max(80).optional(),
  age: z.number().int().min(13).max(120).nullable().optional(),
  heightCm: z.number().int().min(100).max(250).nullable().optional(),
  presentation: z.string().trim().max(60).nullable().optional(),
  usualStyles: tags(12),
  exploreStyles: tags(12),
  favoriteColors: tags(),
  avoidedColors: tags(),
  favoriteBrands: tags(),
  budgetMin: z.number().int().min(0).max(100000).nullable().optional(),
  budgetMax: z.number().int().min(0).max(100000).nullable().optional(),
  sizes: z
    .object({
      top: z.string().max(10).optional(),
      bottom: z.string().max(10).optional(),
      shoes: z.string().max(10).optional(),
    })
    .optional(),
  fitPreference: z.string().max(20).nullable().optional(),
  homeCity: z.string().trim().max(120).nullable().optional(),
  homeLat: z.number().min(-90).max(90).nullable().optional(),
  homeLon: z.number().min(-180).max(180).nullable().optional(),
  favoriteGarments: tags(20),
  onboardingDone: z.boolean().optional(),
}).refine((v) => v.budgetMin == null || v.budgetMax == null || v.budgetMin <= v.budgetMax, {
  message: "El presupuesto mínimo no puede superar el máximo",
  path: ["budgetMin"],
});

export type ProfileInput = z.infer<typeof profileSchema>;
