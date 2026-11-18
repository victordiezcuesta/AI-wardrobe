import { z } from "zod";
import { env } from "@/lib/env";
import { logError } from "@/lib/errors";
import { chat, parseJson } from "@/lib/openrouter/client";
import { analysisSchema, type DetectedItem } from "@/lib/validations/wardrobe";
import { CATEGORIES, COLORS, SEASONS } from "@/features/wardrobe/constants";
import { aiUsageService } from "./ai-usage.service";

export type AnalysisMode = "single" | "multi";

const SYSTEM = `Eres un analista de moda que cataloga prendas a partir de fotografías. Respondes SOLO con JSON válido según el esquema.
Reglas estrictas:
- Describe únicamente lo que se ve. Si un atributo no se puede determinar con la imagen (material, estampado, subcategoría...), usa null o una lista vacía. NO inventes.
- "category" debe ser uno de: ${CATEGORIES.join(", ")}.
- "primaryColor" y "secondaryColors" deben ser de esta lista: ${COLORS.join(", ")}.
- "seasons" solo de: ${SEASONS.join(", ")}.
- "formality": 1 (muy informal) a 5 (muy formal), o null si no está claro.
- "material" es una estimación visual ("algodón", "punto", "cuero"); si dudas, null.
- "confidence": 0 a 1. Pon menos de 0.7 si la prenda está parcialmente tapada, borrosa o ambigua.
- "uncertainFields": nombres de campos de los que no estás seguro.
- "style": etiquetas como casual, smart casual, formal, streetwear, minimalista, old money, deportivo, elegante, urbano, clásico, business casual, vintage.
- "name": nombre corto en español, p. ej. "Camisa de lino azul claro".
- "box": recuadro normalizado de la prenda en la imagen (x, y esquina superior izquierda; width, height; todo entre 0 y 1) o null si no puedes localizarla con precisión.`;

function userPrompt(mode: AnalysisMode) {
  return mode === "single"
    ? "Hay una prenda protagonista en esta foto. Devuelve exactamente un elemento en items. Si no hay ninguna prenda, devuelve items vacío."
    : "Esta foto puede contener varias prendas o accesorios. Devuelve un elemento por cada prenda distinguible, con su box. Ignora personas, fondo y objetos que no sean ropa. Si no hay prendas, devuelve items vacío.";
}

/** Valida que el recuadro sea plausible; si no, se descarta (no se recorta a ciegas). */
export function sanitizeBox(box: DetectedItem["box"]): DetectedItem["box"] {
  if (!box) return null;
  const { x, y, width, height } = box;
  if ([x, y, width, height].some((n) => !Number.isFinite(n))) return null;
  if (x < 0 || y < 0 || width <= 0.03 || height <= 0.03 || x + width > 1.02 || y + height > 1.02) return null;
  return { x, y, width: Math.min(width, 1 - x), height: Math.min(height, 1 - y) };
}

export const itemAnalysisService = {
  async analyze(userId: string, imageUrl: string, mode: AnalysisMode): Promise<DetectedItem[]> {
    await aiUsageService.assertQuota(userId);
    const model = env().OPENROUTER_MODEL_VISION;
    const messages = [
      { role: "system" as const, content: SYSTEM },
      { role: "user" as const, content: [{ type: "text" as const, text: userPrompt(mode) }, { type: "image_url" as const, image_url: { url: imageUrl, detail: "auto" as const } }] },
    ];

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await chat({ model, messages, schema: analysisSchema, schemaName: "wardrobe_analysis", temperature: 0.2, maxTokens: 2500 });
        const parsed = parseJson(res.text, analysisSchema);
        await aiUsageService.log({ userId, task: "ITEM_ANALYSIS", provider: "openrouter", model, ...res.usage, success: true, latencyMs: res.latencyMs });
        return parsed.items;
      } catch (err) {
        const retryable = err instanceof z.ZodError || err instanceof SyntaxError;
        await aiUsageService.log({ userId, task: "ITEM_ANALYSIS", provider: "openrouter", model, success: false });
        if (!retryable || attempt === 1) throw err;
        logError("analysis.invalid_output", err);
      }
    }
    return [];
  },
};
