import { z } from "zod";

const baseSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DIRECT_URL: z.string().optional(),
  AUTH_SECRET: z.string().min(16),
  AUTH_URL: z.string().url().optional(),
  CLOUDINARY_CLOUD_NAME: z.string().min(1),
  CLOUDINARY_API_KEY: z.string().min(1),
  CLOUDINARY_API_SECRET: z.string().min(1),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().optional(),
  OPENROUTER_MODEL_VISION: z.string().optional(),
  OPENROUTER_MODEL_STYLIST: z.string().optional(),
  OPENROUTER_MODEL_CHEAP: z.string().optional(),
  POLLINATIONS_API_KEY: z.string().optional(),
  POLLINATIONS_MODEL: z.string().default("google/gemini-2.5-flash-image"),
  POLLINATIONS_BASE_URL: z.string().url().default("https://gen.pollinations.ai"),
  POLLINATIONS_MAX_REFERENCES: z.coerce.number().int().min(1).max(8).default(5),
  POLLINATIONS_IMAGE_SIZE: z.string().regex(/^\d{3,4}x\d{3,4}$/).optional(),
  AWIN_PUBLISHER_ID: z.string().optional(),
  AWIN_DATAFEED_KEY: z.string().optional(),
  CATALOG_STORES: z.string().default("Mango,H&M,Uniqlo,Springfield,Cortefiel,El Corte Ingles,Zara,Pull&Bear,Bershka,Stradivarius,Massimo Dutti,Oysho,Lefties"),
  CATALOG_REGION: z.string().default("ES"),
  CATALOG_MAX_ROWS_PER_FEED: z.coerce.number().int().min(100).default(60000),
  CATALOG_FEEDS_JSON: z.string().optional(),
  CRON_SECRET: z.string().min(16).optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  EMAIL_FROM: z.string().default("AI Wardrobe <no-reply@localhost>"),
  APP_TIMEZONE: z.string().default("Europe/Madrid"),
  AI_DAILY_LIMIT_PER_USER: z.coerce.number().default(60),
  TRYON_DAILY_LIMIT_PER_USER: z.coerce.number().default(10),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
});

/** Nombres de todas las variables que lee la aplicación (los usa el test que vigila .env.example). */
export const ENV_KEYS = Object.keys(baseSchema.shape);

/**
 * Modelos de OpenRouter: cada tarea usa su variable específica; si falta, OPENROUTER_MODEL; si falta, un valor por defecto
 * orientativo (comprueba que sigue existiendo en el catálogo de OpenRouter). Análisis de prendas y estilista usan un modelo
 * multimodal; el ranking de productos, uno más barato.
 */
const DEFAULT_MODEL = "google/gemini-2.5-flash";
const DEFAULT_CHEAP_MODEL = "google/gemini-2.5-flash-lite";
const serverSchema = baseSchema.transform((e) => ({
  ...e,
  OPENROUTER_MODEL_VISION: e.OPENROUTER_MODEL_VISION ?? e.OPENROUTER_MODEL ?? DEFAULT_MODEL,
  OPENROUTER_MODEL_STYLIST: e.OPENROUTER_MODEL_STYLIST ?? e.OPENROUTER_MODEL ?? DEFAULT_MODEL,
  OPENROUTER_MODEL_CHEAP: e.OPENROUTER_MODEL_CHEAP ?? e.OPENROUTER_MODEL ?? DEFAULT_CHEAP_MODEL,
}));

export type ServerEnv = z.output<typeof serverSchema>;

let cached: ServerEnv | null = null;

/** Valida las variables de entorno la primera vez que se necesitan (no durante el build). */
export function env(): ServerEnv {
  if (cached) return cached;
  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Variables de entorno inválidas o ausentes: ${missing}`);
  }
  cached = parsed.data;
  return cached;
}
