import { after } from "next/server";
import { AppError, logError, notFound } from "@/lib/errors";
import { deletePrivateImages, signedUrl, uploadPrivate } from "@/lib/cloudinary";
import { editImage, type RefImage } from "@/lib/pollinations/client";
import { publicTryOnError, TRYON_MESSAGES } from "@/lib/pollinations/messages";
import { fetchImage, sniffImage } from "@/lib/uploads/validate";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import type { GeneratedImage } from "@/generated/prisma/client";
import { MAX_ATTEMPTS, type PoseKey, type ScenarioKey } from "@/features/virtual-try-on/constants";
import type { CategoryKey } from "@/features/wardrobe/constants";
import { aiUsageService } from "./ai-usage.service";
import { consentService } from "./consent.service";
import { outfitService } from "./outfit.service";
import { photoService } from "./photo.service";
import { buildTryOnPrompt, pickReferences, type PromptItem } from "./tryon-prompt";

const STALE_PROCESSING_MS = 6 * 60_000;
const STALE_PENDING_MS = 2 * 60_000;
const MAX_REF_BYTES = 8 * 1024 * 1024;

/**
 * Hosts de los que se descargan referencias (comprobados en el SDK de Cloudinary 2.11, sin private_cdn/cname/
 * upload_prefix configurados): `signedUrl()` → api.cloudinary.com (UPLOAD_PREFIX, API de descarga, que puede redirigir
 * al CDN) y las prendas → res.cloudinary.com (SHARED_CDN).
 */
const CLOUDINARY_DOWNLOAD_HOSTS = ["api.cloudinary.com", "res.cloudinary.com"] as const;
const fetchBytes = (url: string) => fetchImage(url, { allowedHosts: CLOUDINARY_DOWNLOAD_HOSTS, maxBytes: MAX_REF_BYTES, timeoutMs: 20_000 });

/**
 * Solo se descargan referencias del CDN de Cloudinary de NUESTRA cuenta, por HTTPS (evita SSRF y el uso de imágenes
 * de otras cuentas de Cloudinary si un dato se corrompiera o se manipulara).
 */
export function isOwnCloudinaryUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && url.hostname === "res.cloudinary.com" && !url.username && !url.password && !url.port
      && url.pathname.startsWith(`/${env().CLOUDINARY_CLOUD_NAME}/`);
  } catch { return false; }
}

export function toDTO(row: GeneratedImage) {
  const done = row.status === "COMPLETED" && row.publicId;
  return {
    id: row.id, status: row.status, scenario: row.scenario, pose: row.pose, outfitId: row.outfitId,
    errorMessage: publicTryOnError(row.errorMessage), attempts: row.attempts, isFavorite: row.isFavorite, createdAt: row.createdAt, updatedAt: row.updatedAt,
    imageUrl: done ? signedUrl(row.publicId!, { expiresInSec: 3600 }) : null,
    downloadUrl: done ? signedUrl(row.publicId!, { expiresInSec: 900, attachment: true }) : null,
  };
}

/** Devuelve una reserva de try-on cuyo trabajo no llegó a llamar al proveedor. */
const releaseQuota = (reservation: string) => aiUsageService.release(reservation).catch((e) => logError("tryon.quota_release", e));

/**
 * Genera la imagen de un trabajo y resuelve SU reserva de cuota (hecha al crear o reintentar):
 * - completado → la reserva queda como uso real;
 * - fallo ANTES de llamar a Pollinations (consentimiento retirado, foto o conjunto ya no disponibles, no se pudieron
 *   descargar las referencias) o el trabajo ya no estaba pendiente → se devuelve la unidad;
 * - cualquier fallo desde la llamada a Pollinations (sin garantías documentadas de no facturación) → consumida.
 */
async function run(jobId: string, reservation: string) {
  // Reclamo atómico: si dos ejecuciones coinciden, solo una pasa de PENDING a PROCESSING.
  const claimed = await prisma.generatedImage.updateMany({ where: { id: jobId, status: "PENDING" }, data: { status: "PROCESSING", attempts: { increment: 1 }, errorMessage: null } });
  if (claimed.count === 0) return releaseQuota(reservation);
  const job = await prisma.generatedImage.findUnique({ where: { id: jobId } });
  if (!job) return releaseQuota(reservation);
  const started = Date.now();
  let providerCalled = false;
  try {
    await consentService.require(job.userId);
    if (!job.outfitId || !job.sourcePhotoId) throw new AppError("Falta el conjunto o la foto", 422);
    if (!(await photoService.owns(job.userId, job.sourcePhotoId))) throw new AppError("La foto ya no está disponible", 422);
    const outfit = await outfitService.get(job.userId, job.outfitId);

    const withUrls = await prisma.wardrobeItem.findMany({ where: { userId: job.userId, id: { in: outfit.items.map((i) => i.itemId) } }, select: { id: true, name: true, category: true, primaryColor: true, imageUrl: true } });
    const promptItems: PromptItem[] = withUrls.map((i) => ({ id: i.id, name: i.name, category: i.category as CategoryKey, color: i.primaryColor, hasImage: !!i.imageUrl && isOwnCloudinaryUrl(i.imageUrl) }));
    const referenced = pickReferences(promptItems, env().POLLINATIONS_MAX_REFERENCES);
    const prompt = buildTryOnPrompt(promptItems, referenced, job.scenario as ScenarioKey, job.pose as PoseKey);

    const person = await fetchBytes(signedUrl(job.sourcePhotoId, { expiresInSec: 600 }));
    const images: RefImage[] = [{ ...person, name: "person.jpg" }];
    for (const [idx, r] of referenced.entries()) {
      const url = withUrls.find((w) => w.id === r.id)!.imageUrl!;
      try { images.push({ ...(await fetchBytes(url)), name: `garment-${idx + 1}.jpg` }); }
      catch (e) { logError("tryon.garment", e); throw new AppError("No se pudo cargar la foto de una de las prendas", 502); }
    }

    providerCalled = true;
    const out = await editImage({ prompt, images });
    if (!sniffImage(out)) { logError("tryon.invalid_output", new Error("La respuesta no es una imagen")); throw new AppError(TRYON_MESSAGES.failed, 502, "TRYON_INVALID"); }
    const stored = await uploadPrivate(out, `ai-wardrobe/${job.userId}/try-on`, { maxSide: 2048 });

    await prisma.generatedImage.update({ where: { id: job.id }, data: { status: "COMPLETED", publicId: stored.publicId, prompt, errorMessage: null } });
    await aiUsageService.complete(reservation, { success: true, latencyMs: Date.now() - started }).catch((e) => logError("tryon.quota_complete", e));
  } catch (err) {
    logError("tryon.run", err);
    const message = err instanceof AppError ? err.message : TRYON_MESSAGES.failed;
    await prisma.generatedImage.update({ where: { id: job.id }, data: { status: "FAILED", errorMessage: message } }).catch(() => undefined);
    if (providerCalled) await aiUsageService.complete(reservation, { success: false, latencyMs: Date.now() - started }).catch((e) => logError("tryon.quota_complete", e));
    else await releaseQuota(reservation);
  }
}

/** Reserva atómica de la cuota PROPIA del probador (solo cuenta TRY_ON, límite independiente). */
const reserveTryOn = (userId: string) =>
  aiUsageService.reserve(userId, { task: "TRY_ON", provider: "pollinations", model: env().POLLINATIONS_MODEL }, "TRY_ON");

export const tryOnService = {
  async create(userId: string, input: { outfitId: string; photoPublicId: string; scenario: ScenarioKey; pose: PoseKey }) {
    await consentService.require(userId);
    if (!env().POLLINATIONS_API_KEY) {
      logError("tryon.config", new Error("Falta POLLINATIONS_API_KEY"));
      throw new AppError(TRYON_MESSAGES.unavailable, 503, "TRYON_NOT_CONFIGURED");
    }
    if (!(await photoService.owns(userId, input.photoPublicId))) throw notFound("Foto");
    await outfitService.get(userId, input.outfitId); // comprueba que el conjunto es del usuario
    const active = await prisma.generatedImage.count({ where: { userId, status: { in: ["PENDING", "PROCESSING"] }, updatedAt: { gt: new Date(Date.now() - STALE_PROCESSING_MS) } } });
    if (active >= 2) throw new AppError("Ya tienes 2 imágenes en proceso. Espera a que terminen.", 429, "TOO_MANY_ACTIVE");

    // La unidad se reserva YA (no al terminar): un trabajo pendiente cuenta para el límite desde que se crea.
    const reservation = await reserveTryOn(userId);
    let job: GeneratedImage;
    try {
      job = await prisma.generatedImage.create({ data: { userId, outfitId: input.outfitId, sourcePhotoId: input.photoPublicId, scenario: input.scenario, pose: input.pose, status: "PENDING" } });
    } catch (e) {
      await releaseQuota(reservation);
      throw e;
    }
    after(() => run(job.id, reservation)); // la respuesta sale ya; la generación sigue en segundo plano
    return toDTO(job);
  },

  /** Devuelve el estado actual; si un trabajo lleva demasiado tiempo parado, lo marca como fallido. */
  async get(userId: string, id: string) {
    let row = await prisma.generatedImage.findFirst({ where: { id, userId } });
    if (!row) throw notFound("Imagen");
    const age = Date.now() - row.updatedAt.getTime();
    if ((row.status === "PROCESSING" && age > STALE_PROCESSING_MS) || (row.status === "PENDING" && age > STALE_PENDING_MS)) {
      row = await prisma.generatedImage.update({ where: { id }, data: { status: "FAILED", errorMessage: "La generación tardó demasiado. Puedes reintentarlo." } });
    }
    return toDTO(row);
  },

  async list(userId: string, opts: { cursor?: string; favorites?: boolean }) {
    const rows = await prisma.generatedImage.findMany({
      where: { userId, ...(opts.favorites && { isFavorite: true }) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 13,
      ...(opts.cursor && { cursor: { id: opts.cursor }, skip: 1 }),
    });
    const hasMore = rows.length > 12;
    const page = hasMore ? rows.slice(0, 12) : rows;
    return { images: page.map(toDTO), nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null };
  },

  async retry(userId: string, id: string) {
    await consentService.require(userId);
    const row = await prisma.generatedImage.findFirst({ where: { id, userId } });
    if (!row) throw notFound("Imagen");
    if (row.status !== "FAILED") throw new AppError("Solo se pueden reintentar las generaciones fallidas", 409, "NOT_RETRYABLE");
    if (row.attempts >= MAX_ATTEMPTS) throw new AppError(`Máximo ${MAX_ATTEMPTS} intentos por imagen`, 429, "MAX_ATTEMPTS");
    const reservation = await reserveTryOn(userId);
    const reset = await prisma.generatedImage.updateMany({ where: { id, userId, status: "FAILED" }, data: { status: "PENDING", errorMessage: null } }).catch(async (e) => { await releaseQuota(reservation); throw e; });
    if (reset.count === 0) {
      await releaseQuota(reservation);
      throw new AppError("La imagen ya está en proceso", 409, "ALREADY_RUNNING");
    }
    after(() => run(id, reservation));
    return this.get(userId, id);
  },

  async setFavorite(userId: string, id: string, isFavorite: boolean) {
    const r = await prisma.generatedImage.updateMany({ where: { id, userId }, data: { isFavorite } });
    if (r.count === 0) throw notFound("Imagen");
    return this.get(userId, id);
  },

  async remove(userId: string, id: string) {
    const row = await prisma.generatedImage.findFirst({ where: { id, userId } });
    if (!row) throw notFound("Imagen");
    await prisma.generatedImage.delete({ where: { id } });
    if (row.publicId) await deletePrivateImages([row.publicId]).catch((e) => logError("tryon.delete", e));
  },
};
