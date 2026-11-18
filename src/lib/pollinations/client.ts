import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";

export interface RefImage { bytes: Buffer; mime: string; name: string }

/** Mensajes seguros para el usuario; el detalle técnico no se expone. */
function mapStatus(status: number, retryAfter: string | null): AppError {
  if (status === 401) return new AppError("La clave de Pollinations no es válida", 503, "TRYON_NOT_CONFIGURED");
  if (status === 402) return new AppError("Se han agotado los créditos de generación de imágenes", 503, "TRYON_NO_CREDITS");
  if (status === 429 || status === 503) return new AppError(`El servicio de imágenes está saturado${retryAfter ? `; reintenta en ${retryAfter}s` : ""}`, 503, "TRYON_BUSY");
  if (status === 400 || status === 422) return new AppError("El proveedor rechazó la imagen o la descripción (puede haber saltado su filtro de contenido)", 422, "TRYON_REJECTED");
  return new AppError("El servicio de imágenes no ha podido generar el resultado", 502, "TRYON_UPSTREAM");
}

/**
 * Edición de imagen con referencias vía POST /v1/images/edits (multipart, compatible con OpenAI).
 * La primera imagen es la persona; el resto, las prendas. Se pide b64_json para que el resultado
 * no quede alojado en el almacén de medios del proveedor.
 */
export async function editImage(opts: { prompt: string; images: RefImage[] }): Promise<Buffer> {
  const e = env();
  if (!e.POLLINATIONS_API_KEY) throw new AppError("El probador virtual no está configurado (falta POLLINATIONS_API_KEY)", 503, "TRYON_NOT_CONFIGURED");

  const form = new FormData();
  form.set("model", e.POLLINATIONS_MODEL);
  form.set("prompt", opts.prompt);
  form.set("response_format", "b64_json");
  form.set("n", "1");
  if (e.POLLINATIONS_IMAGE_SIZE) form.set("size", e.POLLINATIONS_IMAGE_SIZE);
  for (const img of opts.images) form.append("image", new Blob([new Uint8Array(img.bytes)], { type: img.mime }), img.name);

  let res: Response;
  try {
    res = await fetch(`${e.POLLINATIONS_BASE_URL}/v1/images/edits`, {
      method: "POST",
      headers: { Authorization: `Bearer ${e.POLLINATIONS_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(240_000),
    });
  } catch {
    throw new AppError("El servicio de imágenes tardó demasiado en responder", 504, "TRYON_TIMEOUT");
  }
  if (!res.ok) throw mapStatus(res.status, res.headers.get("retry-after"));

  const data = (await res.json().catch(() => null)) as { data?: { b64_json?: string; url?: string }[] } | null;
  const first = data?.data?.[0];
  if (first?.b64_json) return Buffer.from(first.b64_json, "base64");
  if (first?.url) {
    const img = await fetch(first.url, { signal: AbortSignal.timeout(30_000) });
    if (img.ok) return Buffer.from(await img.arrayBuffer());
  }
  throw new AppError("El proveedor no devolvió ninguna imagen", 502, "TRYON_EMPTY");
}
