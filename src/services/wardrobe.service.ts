import { AppError, logError, notFound } from "@/lib/errors";
import { deleteImage, uploadBuffer, uploadCrop, type StoredImage } from "@/lib/cloudinary";
import { wardrobeRepository } from "@/repositories/wardrobe.repository";
import type { Prisma, WardrobeItem } from "@/generated/prisma/client";
import type { DetectedItem, ListQuery } from "@/lib/validations/wardrobe";
import type { z } from "zod";
import type { createItemSchema, updateItemSchema } from "@/lib/validations/wardrobe";
import { itemAnalysisService, sanitizeBox, type AnalysisMode } from "./item-analysis.service";

const folder = (userId: string) => `ai-wardrobe/${userId}/wardrobe`;
const LOW_CONFIDENCE = 0.7;

function fromDetected(d: DetectedItem, img: StoredImage, extraReview: boolean): Omit<Prisma.WardrobeItemUncheckedCreateInput, "userId"> {
  return {
    name: d.name,
    category: d.category,
    subcategory: d.subcategory,
    description: d.description,
    primaryColor: d.primaryColor,
    secondaryColors: d.secondaryColors,
    pattern: d.pattern,
    material: d.material,
    style: d.style,
    seasons: d.seasons,
    formality: d.formality,
    occasions: d.occasions,
    visualTraits: d.visualTraits,
    aiConfidence: d.confidence,
    needsReview: extraReview || d.confidence < LOW_CONFIDENCE || d.uncertainFields.length > 0,
    imagePublicId: img.publicId,
    imageUrl: img.url,
    thumbUrl: img.thumbUrl,
  };
}

/** Motivo para el cliente sin detalles internos (claves, proveedor, códigos HTTP): el detalle va solo al log. */
export function analysisFailureReason(err: unknown): string {
  if (err instanceof AppError && err.code === "RATE_LIMITED") return err.message; // cuota diaria agotada: útil y sin datos internos
  if (err instanceof AppError && err.code === "AI_RATE_LIMITED") return "El análisis automático ha alcanzado su límite de uso. Completa los datos a mano o inténtalo más tarde.";
  if (err instanceof AppError && err.code === "AI_NOT_CONFIGURED") return "El análisis automático no está disponible en este momento.";
  return "La IA no ha podido analizar la foto. Completa los datos a mano o inténtalo más tarde.";
}

export type UploadOutcome =
  | { status: "ok"; items: WardrobeItem[] }
  | { status: "no_garment"; items: [] }
  | { status: "analysis_failed"; items: WardrobeItem[]; reason: string };

export const wardrobeService = {
  list: (userId: string, filters: ListQuery) => wardrobeRepository.list(userId, filters),

  async get(userId: string, id: string) {
    const item = await wardrobeRepository.get(userId, id);
    if (!item) throw notFound("Prenda");
    return item;
  },

  create: (userId: string, input: z.infer<typeof createItemSchema>) => wardrobeRepository.create(userId, input),

  async update(userId: string, id: string, input: z.infer<typeof updateItemSchema>) {
    const item = await wardrobeRepository.update(userId, id, input);
    if (!item) throw notFound("Prenda");
    return item;
  },

  async remove(userId: string, id: string) {
    const item = await wardrobeRepository.get(userId, id);
    if (!item) throw notFound("Prenda");
    await wardrobeRepository.delete(userId, id);
    // Varias prendas pueden compartir foto (si falló un recorte): solo se borra al quedar huérfana.
    if (item.imagePublicId && (await wardrobeRepository.countByImage(userId, item.imagePublicId)) === 0) {
      await deleteImage(item.imagePublicId).catch((e) => logError("cloudinary.delete", e));
    }
  },

  /** Sube la foto, la analiza con IA y crea las prendas. Si la IA falla, la prenda se guarda marcada para revisión, sin atributos inventados. */
  async createFromUpload(userId: string, buffer: Buffer, mode: AnalysisMode): Promise<UploadOutcome> {
    const source = await uploadBuffer(buffer, folder(userId));
    let detected: DetectedItem[];
    try {
      detected = await itemAnalysisService.analyze(userId, source.url, mode);
    } catch (err) {
      logError("wardrobe.analysis", err);
      const item = await wardrobeRepository.create(userId, {
        name: "Prenda sin analizar", category: "OTHER", needsReview: true,
        imagePublicId: source.publicId, imageUrl: source.url, thumbUrl: source.thumbUrl,
      });
      return { status: "analysis_failed", items: [item], reason: analysisFailureReason(err) };
    }

    if (detected.length === 0) {
      await deleteImage(source.publicId).catch((e) => logError("cloudinary.delete", e));
      return { status: "no_garment", items: [] };
    }

    const chosen = mode === "single" ? detected.slice(0, 1) : detected;
    const created: WardrobeItem[] = [];
    for (const d of chosen) {
      const box = mode === "multi" ? sanitizeBox(d.box) : null;
      let image = source;
      let missingCrop = false;
      if (mode === "multi") {
        if (box) {
          try {
            image = await uploadCrop(source.publicId, {
              x: Math.round(box.x * source.width), y: Math.round(box.y * source.height),
              width: Math.max(1, Math.round(box.width * source.width)), height: Math.max(1, Math.round(box.height * source.height)),
            }, folder(userId));
          } catch (e) { logError("cloudinary.crop", e); missingCrop = true; }
        } else missingCrop = chosen.length > 1;
      }
      created.push(await wardrobeRepository.create(userId, fromDetected(d, image, missingCrop)));
    }

    if ((await wardrobeRepository.countByImage(userId, source.publicId)) === 0) {
      await deleteImage(source.publicId).catch((e) => logError("cloudinary.delete", e));
    }
    return { status: "ok", items: created };
  },
};
