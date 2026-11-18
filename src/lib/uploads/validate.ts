import { AppError } from "@/lib/errors";

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // límite de cuerpo de las funciones de Vercel ≈ 4,5 MB

export type ImageKind = "jpeg" | "png" | "webp";

/** Detecta el formato por firma binaria; no se fía del Content-Type ni de la extensión. */
export function sniffImage(buf: Buffer): ImageKind | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return null;
}

export async function readImageFile(file: File): Promise<Buffer> {
  if (file.size === 0) throw new AppError("El archivo está vacío", 422, "INVALID_FILE");
  if (file.size > MAX_UPLOAD_BYTES) throw new AppError("La imagen supera los 4 MB", 413, "FILE_TOO_LARGE");
  const buf = Buffer.from(await file.arrayBuffer());
  if (!sniffImage(buf)) throw new AppError("Formato no admitido. Usa JPG, PNG o WebP", 415, "UNSUPPORTED_TYPE");
  return buf;
}
