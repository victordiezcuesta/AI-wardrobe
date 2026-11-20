import { AppError, logError, notFound } from "@/lib/errors";
import { safeDbError } from "@/lib/errors/db";
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

/**
 * Tras un fallo al guardar una prenda con una imagen recién subida: ¿quedó referenciada? Devuelve la prenda propia si se
 * guardó pese al error; "other" si la usa otra fila (no se toca); "absent" si se confirma que nadie la usa (se puede
 * borrar); "unknown" si no se pudo consultar (no se borra a ciegas; se registra sin publicId ni userId).
 * Solo lee: la limpieza nunca escribe en la base de datos, así que no puede pisar una escritura concurrente.
 */
async function imageReference(userId: string, publicId: string): Promise<WardrobeItem | "other" | "absent" | "unknown"> {
  try {
    const own = await wardrobeRepository.findByImage(userId, publicId);
    if (own) return own;
    return (await wardrobeRepository.isImageReferenced(publicId)) ? "other" : "absent";
  } catch (e) {
    logError("wardrobe.orphan_unverified", safeDbError(e));
    return "unknown";
  }
}

/**
 * Guarda la prenda. Si la base de datos falla, la imagen recién subida (pública) solo se borra si se confirma que
 * ninguna fila la usa; si la prenda llegó a guardarse (se perdió la respuesta), se devuelve como guardada.
 */
async function persistOrDiscard(userId: string, data: Omit<Prisma.WardrobeItemUncheckedCreateInput, "userId">, uploaded: StoredImage | null) {
  try {
    return await wardrobeRepository.create(userId, data);
  } catch (err) {
    if (!uploaded) throw safeDbError(err); // imagen compartida (la original): de ella se ocupa createFromUpload
    const ref = await imageReference(userId, uploaded.publicId);
    if (typeof ref === "object") return ref;
    if (ref === "absent") await deleteImage(uploaded.publicId).catch((e) => logError("cloudinary.delete", e));
    throw safeDbError(err); // "other"/"unknown": la imagen se conserva
  }
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

  /**
   * Varias prendas pueden compartir foto (si falló un recorte). Si otra prenda la sigue usando, solo se quita esta
   * (decisión atómica y serializada con los demás borrados, ver `removeIfImageShared`). Si es la última, primero se
   * borra la foto en Cloudinary (es pública: una copia huérfana seguiría accesible por su URL) y solo si eso va bien, la
   * prenda; si el proveedor falla, la prenda y su referencia se conservan y el usuario puede reintentar.
   */
  async remove(userId: string, id: string): Promise<void> {
    const item = await wardrobeRepository.get(userId, id);
    if (!item) throw notFound("Prenda");
    if (item.imagePublicId) {
      const outcome = await wardrobeRepository.removeIfImageShared(userId, id, item.imagePublicId);
      if (outcome === "removed") return;
      if (outcome === "missing") {
        // Otro borrado se adelantó (nada que hacer) o la prenda cambió de foto entretanto (se decide de nuevo).
        if (await wardrobeRepository.get(userId, id)) return this.remove(userId, id);
        return;
      }
      await deleteImage(item.imagePublicId); // última referencia: si falla, se lanza y la prenda se conserva
    }
    await wardrobeRepository.delete(userId, id);
  },

  /** Sube la foto, la analiza con IA y crea las prendas. Si la IA falla, la prenda se guarda marcada para revisión, sin atributos inventados. */
  async createFromUpload(userId: string, buffer: Buffer, mode: AnalysisMode): Promise<UploadOutcome> {
    const source = await uploadBuffer(buffer, folder(userId));
    let detected: DetectedItem[];
    try {
      detected = await itemAnalysisService.analyze(userId, source.url, mode);
    } catch (err) {
      logError("wardrobe.analysis", err);
      const item = await persistOrDiscard(userId, {
        name: "Prenda sin analizar", category: "OTHER", needsReview: true,
        imagePublicId: source.publicId, imageUrl: source.url, thumbUrl: source.thumbUrl,
      }, source);
      return { status: "analysis_failed", items: [item], reason: analysisFailureReason(err) };
    }

    if (detected.length === 0) {
      await deleteImage(source.publicId).catch((e) => logError("cloudinary.delete", e));
      return { status: "no_garment", items: [] };
    }

    const chosen = mode === "single" ? detected.slice(0, 1) : detected;
    const created: WardrobeItem[] = [];
    try {
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
        created.push(await persistOrDiscard(userId, fromDetected(d, image, missingCrop), image === source ? null : image));
      }
    } finally {
      // La foto original solo se borra si se confirma que ninguna prenda la usa (también si el bucle se cortó por un error,
      // incluida una prenda que se guardó aunque se perdiera la respuesta). Está en la carpeta de ESTE usuario y acaba de
      // subirse, así que basta con sus prendas (consulta por userId, con índice; la global queda para los caminos de
      // error de persistOrDiscard). Si no se puede consultar, se conserva.
      const stillUsed = await wardrobeRepository.countByImage(userId, source.publicId)
        .catch((e) => { logError("wardrobe.orphan_unverified", safeDbError(e)); return 1; });
      if (stillUsed === 0) await deleteImage(source.publicId).catch((e) => logError("cloudinary.delete", e));
    }
    return { status: "ok", items: created };
  },
};
