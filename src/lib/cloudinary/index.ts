import { Agent } from "node:https";
import { v2 as cloudinary, type UploadApiResponse } from "cloudinary";
import { env } from "@/lib/env";
import { AppError, logError } from "@/lib/errors";

let configured = false;
function client() {
  if (!configured) {
    const e = env();
    cloudinary.config({ cloud_name: e.CLOUDINARY_CLOUD_NAME, api_key: e.CLOUDINARY_API_KEY, api_secret: e.CLOUDINARY_API_SECRET, secure: true });
    configured = true;
  }
  return cloudinary;
}

/** Formatos de imagen que se guardan (los mismos que acepta la validación por firma binaria: JPG, PNG y WebP). */
export const ALLOWED_FORMATS = ["jpg", "png", "webp"] as const;
const isAllowedFormat = (f: unknown): boolean => typeof f === "string" && (ALLOWED_FORMATS as readonly string[]).includes(f.toLowerCase());

export interface StoredImage { publicId: string; url: string; thumbUrl: string; width: number; height: number }

export function imageUrls(publicId: string) {
  const c = client();
  return {
    url: c.url(publicId, { secure: true, fetch_format: "auto", quality: "auto" }),
    thumbUrl: c.url(publicId, { secure: true, fetch_format: "auto", quality: "auto", width: 480, height: 600, crop: "fill", gravity: "auto" }),
  };
}

/** Los errores del SDK son objetos planos ({ message, http_code }): se registran completos y al cliente llega un AppError genérico. */
function providerError(err: unknown): Error {
  const e = err as { message?: string; http_code?: number } | undefined;
  return err instanceof Error ? err : new Error(`Cloudinary ${e?.http_code ?? "?"}: ${e?.message ?? String(err)}`);
}

/** Un 400 de Cloudinary en la subida significa archivo dañado o no procesable (p. ej. firma válida y contenido basura). */
export function uploadFailure(err: unknown): AppError {
  logError("cloudinary.upload", providerError(err));
  return (err as { http_code?: number } | undefined)?.http_code === 400
    ? new AppError("La imagen no es válida o está dañada. Prueba con otra foto.", 422, "INVALID_IMAGE")
    : new AppError("No se ha podido guardar la imagen. Inténtalo de nuevo en unos minutos.", 502, "STORAGE_UNAVAILABLE");
}

/** Si el proveedor no confirma el borrado se lanza, para que el llamador NO borre la referencia y se pueda reintentar. */
async function guardDelete(op: () => Promise<unknown>): Promise<void> {
  try {
    await op();
  } catch (err) {
    logError("cloudinary.delete", providerError(err));
    throw new AppError("No se ha podido borrar la imagen. Inténtalo de nuevo en unos minutos.", 502, "IMAGE_DELETE_FAILED");
  }
}

function toStored(r: UploadApiResponse): StoredImage {
  return { publicId: r.public_id, width: r.width, height: r.height, ...imageUrls(r.public_id) };
}

/** Sube un buffer. La transformación entrante limita el tamaño y elimina metadatos (EXIF/GPS). */
export function uploadBuffer(buffer: Buffer, folder: string): Promise<StoredImage> {
  const c = client();
  return new Promise((resolve, reject) => {
    const stream = c.uploader.upload_stream(
      {
        folder,
        resource_type: "image",
        transformation: [{ width: 1600, height: 1600, crop: "limit" }, { quality: "auto:good" }],
        allowed_formats: [...ALLOWED_FORMATS],
      },
      (err, result) => (err || !result ? reject(uploadFailure(err ?? new Error("Cloudinary sin respuesta"))) : resolve(toStored(result))),
    );
    stream.end(buffer);
  });
}

/**
 * Crea un recurso nuevo e independiente a partir de un recorte de otro (varias prendas en una foto). Exige los mismos
 * formatos que la subida original: Cloudinary rechaza cualquier otro (400 → INVALID_IMAGE) y, como defensa adicional,
 * un resultado con otro formato se borra y se rechaza igual. Los errores llegan como AppError de `uploadFailure`.
 */
export async function uploadCrop(sourcePublicId: string, box: { x: number; y: number; width: number; height: number }, folder: string): Promise<StoredImage> {
  const c = client();
  const cropUrl = c.url(sourcePublicId, { secure: true, transformation: [{ crop: "crop", x: box.x, y: box.y, width: box.width, height: box.height }] });
  let r: UploadApiResponse;
  try {
    r = await c.uploader.upload(cropUrl, { folder, resource_type: "image", allowed_formats: [...ALLOWED_FORMATS] });
  } catch (err) {
    throw uploadFailure(err);
  }
  if (!isAllowedFormat(r.format)) {
    await deleteImage(r.public_id).catch((e) => logError("cloudinary.delete", e));
    throw uploadFailure({ http_code: 400, message: `Formato de recorte no permitido: ${String(r.format)}` });
  }
  return toStored(r);
}

export async function deleteImage(publicId: string | null | undefined): Promise<void> {
  if (!publicId) return;
  await guardDelete(() => client().uploader.destroy(publicId, { invalidate: true }));
}

export async function deleteImages(publicIds: string[]): Promise<void> {
  if (publicIds.length === 0) return;
  for (let i = 0; i < publicIds.length; i += 100) {
    await guardDelete(() => client().api.delete_resources(publicIds.slice(i, i + 100), { invalidate: true }));
  }
}

/** Subida PRIVADA (type "authenticated"): sin URL pública; solo se sirve con firma y caducidad. */
export async function uploadPrivate(buffer: Buffer, folder: string, opts: { maxSide?: number } = {}): Promise<{ publicId: string; width: number; height: number }> {
  const c = client();
  const side = opts.maxSide ?? 1600;
  return new Promise((resolve, reject) => {
    const stream = c.uploader.upload_stream(
      {
        folder, resource_type: "image", type: "authenticated",
        transformation: [{ width: side, height: side, crop: "limit" }, { quality: "auto:good" }],
        allowed_formats: [...ALLOWED_FORMATS],
      },
      (err, r) => (err || !r ? reject(uploadFailure(err ?? new Error("Cloudinary sin respuesta"))) : resolve({ publicId: r.public_id, width: r.width, height: r.height })),
    );
    stream.end(buffer);
  });
}

/** URL firmada y con caducidad para un recurso privado. Con attachment=true fuerza la descarga. */
export function signedUrl(publicId: string, opts: { expiresInSec?: number; attachment?: boolean } = {}): string {
  const c = client();
  return c.utils.private_download_url(publicId, "jpg", {
    type: "authenticated",
    resource_type: "image",
    expires_at: Math.floor(Date.now() / 1000) + (opts.expiresInSec ?? 3600),
    ...(opts.attachment && { attachment: true }),
  });
}

export async function deletePrivateImages(publicIds: string[]): Promise<void> {
  for (let i = 0; i < publicIds.length; i += 100) {
    await guardDelete(() => client().api.delete_resources(publicIds.slice(i, i + 100), { type: "authenticated", invalidate: true }));
  }
}

/**
 * Borra TODO lo que un usuario tiene en Cloudinary (públicas y privadas) por prefijo de carpeta.
 * Más completo que borrar por id: también elimina huérfanos. Lanza si algo falla, para no dejar datos sin dueño.
 */
export async function deleteAllUserAssets(userId: string): Promise<void> {
  const c = client();
  const prefix = `ai-wardrobe/${userId}/`;
  for (const type of ["upload", "authenticated"] as const) {
    for (let page = 0; page < 50; page++) {
      const res = (await c.api.delete_resources_by_prefix(prefix, { type, resource_type: "image", invalidate: true })) as { partial?: boolean };
      if (!res.partial) break; // Cloudinary borra por tandas; "partial" indica que quedan más
    }
  }
  await c.api.delete_folder(`ai-wardrobe/${userId}`).catch(() => undefined); // carpeta vacía: mejor esfuerzo
}

/** Raíz de todo lo que sube la aplicación (`ai-wardrobe/<userId>/<tipo>/…`). El inventario nunca recorre nada fuera. */
export const APP_ROOT_PREFIX = "ai-wardrobe/";
/** Tipos de entrega de las imágenes de la aplicación: públicas (`upload`) y privadas (`authenticated`). */
export type DeliveryType = "upload" | "authenticated";
/**
 * Página tal como la devuelve la Admin API (se valida en quien la usa: no se confía en su forma). En las respuestas
 * correctas, el SDK copia las cabeceras `X-FeatureRateLimit-*` a `rate_limit_*` (`reset_at` llega como Date aunque
 * su tipo diga string); en los errores (p. ej. 420) no las incluye.
 */
export interface ResourcePage {
  resources?: unknown; next_cursor?: unknown;
  rate_limit_allowed?: unknown; rate_limit_remaining?: unknown; rate_limit_reset_at?: unknown;
}

/**
 * SOLO LECTURA (Admin API, `GET /resources/image/<tipo>`): una página del inventario de imágenes de la aplicación para
 * un tipo de entrega. El prefijo es fijo (APP_ROOT_PREFIX): quien llama no puede recorrer otras carpetas. No modifica
 * nada en Cloudinary. Consume cuota horaria de la Admin API.
 *
 * Cancelación real: el SDK no acepta AbortSignal y su `timeout` solo programa `request.setTimeout` sin cerrar nada, pero
 * sí reenvía la opción `agent` a `https.request`. Cada página usa su propio Agent: al abortarse `signal`, `agent.destroy()`
 * cierra el socket de la petición en curso (el SDK la rechaza con ECONNRESET) y no queda nada ejecutándose en segundo
 * plano. Al terminar, por cualquier vía, el Agent se destruye también.
 */
export async function listAppResourcesPage(type: DeliveryType, cursor?: string, signal?: AbortSignal): Promise<ResourcePage> {
  if (signal?.aborted) throw signal.reason; // ya cancelada: no se crea ningún recurso
  const agent = new Agent({ keepAlive: false });
  const cancel = () => agent.destroy();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    return (await client().api.resources({
      resource_type: "image", type, prefix: APP_ROOT_PREFIX, max_results: 500, agent, ...(cursor ? { next_cursor: cursor } : {}),
    })) as ResourcePage;
  } finally {
    signal?.removeEventListener("abort", cancel);
    agent.destroy();
  }
}
