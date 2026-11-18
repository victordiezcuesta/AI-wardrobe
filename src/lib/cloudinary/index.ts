import { v2 as cloudinary, type UploadApiResponse } from "cloudinary";
import { env } from "@/lib/env";

let configured = false;
function client() {
  if (!configured) {
    const e = env();
    cloudinary.config({ cloud_name: e.CLOUDINARY_CLOUD_NAME, api_key: e.CLOUDINARY_API_KEY, api_secret: e.CLOUDINARY_API_SECRET, secure: true });
    configured = true;
  }
  return cloudinary;
}

export interface StoredImage { publicId: string; url: string; thumbUrl: string; width: number; height: number }

export function imageUrls(publicId: string) {
  const c = client();
  return {
    url: c.url(publicId, { secure: true, fetch_format: "auto", quality: "auto" }),
    thumbUrl: c.url(publicId, { secure: true, fetch_format: "auto", quality: "auto", width: 480, height: 600, crop: "fill", gravity: "auto" }),
  };
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
        allowed_formats: ["jpg", "png", "webp"],
      },
      (err, result) => (err || !result ? reject(err ?? new Error("Cloudinary sin respuesta")) : resolve(toStored(result))),
    );
    stream.end(buffer);
  });
}

/** Crea un recurso nuevo e independiente a partir de un recorte de otro (varias prendas en una foto). */
export async function uploadCrop(sourcePublicId: string, box: { x: number; y: number; width: number; height: number }, folder: string): Promise<StoredImage> {
  const c = client();
  const cropUrl = c.url(sourcePublicId, { secure: true, transformation: [{ crop: "crop", x: box.x, y: box.y, width: box.width, height: box.height }] });
  const r = await c.uploader.upload(cropUrl, { folder, resource_type: "image" });
  return toStored(r);
}

export async function deleteImage(publicId: string | null | undefined): Promise<void> {
  if (!publicId) return;
  await client().uploader.destroy(publicId, { invalidate: true });
}

export async function deleteImages(publicIds: string[]): Promise<void> {
  if (publicIds.length === 0) return;
  for (let i = 0; i < publicIds.length; i += 100) {
    await client().api.delete_resources(publicIds.slice(i, i + 100), { invalidate: true });
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
        allowed_formats: ["jpg", "png", "webp"],
      },
      (err, r) => (err || !r ? reject(err ?? new Error("Cloudinary sin respuesta")) : resolve({ publicId: r.public_id, width: r.width, height: r.height })),
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
    await client().api.delete_resources(publicIds.slice(i, i + 100), { type: "authenticated", invalidate: true });
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
