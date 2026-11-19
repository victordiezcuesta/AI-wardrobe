/**
 * Mensajes del probador que pueden llegar al cliente (respuestas HTTP y `errorMessage` de los trabajos). Nunca nombran
 * al proveedor, variables de entorno, claves, créditos ni el error original: ese detalle va solo al log del servidor.
 * Los códigos de error (TRYON_*) siguen distinguiendo cada caso.
 */
export const TRYON_MESSAGES = {
  unavailable: "El probador virtual no está disponible en este momento. Inténtalo más tarde.",
  busy: "El servicio de imágenes está saturado. Inténtalo de nuevo en unos minutos.",
  rejected: "No se pudo generar la imagen con esta foto y este conjunto. Prueba con otra foto o con otro conjunto.",
  timeout: "La generación de la imagen tardó demasiado. Inténtalo de nuevo.",
  failed: "No se pudo generar la imagen. Inténtalo de nuevo.",
} as const;

/** Solo se repite un Retry-After numérico y razonable (nunca texto arbitrario de la respuesta del proveedor). */
export function busyMessage(retryAfter: string | null): string {
  const secs = retryAfter && /^\d{1,4}$/.test(retryAfter.trim()) ? Number(retryAfter) : null;
  return secs ? `El servicio de imágenes está saturado; reintenta en ${secs}s` : TRYON_MESSAGES.busy;
}

/** Restos de versiones anteriores que sí exponían detalles internos (filas antiguas ya guardadas en la base de datos). */
const LEAKY = /pollinations|_API_KEY|\bsk[-_]|clave|créditos|cr[eé]dits?|api[ _-]?key/i;

/** Mensaje de error de un trabajo apto para el cliente: los que revelan detalles internos se sustituyen por uno genérico. */
export const publicTryOnError = (message: string | null): string | null =>
  message && LEAKY.test(message) ? TRYON_MESSAGES.failed : message;
