import { logError } from "@/lib/errors";
import { resolveClientIp } from "@/lib/net/client-ip";
import { rateLimit } from "./index";

/**
 * Fase 19.12f.2 — rate limiting por IP FIABLE. SOLO Node.js (resolveClientIp importa `node:net`).
 *
 * La IP la decide únicamente `resolveClientIp` (solo `x-forwarded-for` y solo con VERCEL === "1"; cualquier otra cosa →
 * null). Con IP, se llama exactamente una vez a `rateLimit("<scope>:<ipKey>", limit, windowSec)` y sus errores (429 o de
 * almacenamiento) se propagan tal cual. Sin IP NO se llama a `rateLimit`: nunca hay una clave compartida («unknown») y la
 * ruta conserva sus demás protecciones.
 */
export async function rateLimitByIp(req: Request, scope: string, limit: number, windowSec: number): Promise<void> {
  const ipKey = resolveClientIp(req.headers);
  if (ipKey === null) {
    warnIpUnavailable();
    return;
  }
  await rateLimit(`${scope}:${ipKey}`, limit, windowSec);
}

/** Una vez por proceso: ya se avisó de que, en Vercel, no hay IP fiable. */
let warned = false;

/**
 * Aviso de CONFIGURACIÓN (no de petición): con VERCEL === "1" siempre debería haber IP, así que su ausencia indica una
 * cabecera inesperada (p. ej. varias IP, por un proxy delante de Vercel). Como mucho una vez por proceso; mensaje fijo,
 * sin IP, cabeceras ni datos de la petición; nunca lanza ni cambia el resultado.
 *
 * LIMITACIÓN: el aviso solo existe si `process.env.VERCEL === "1"`. Si Vercel no expone sus variables de sistema (ajuste
 * «Enable access to System Environment Variables» desactivado), `VERCEL` queda sin definir y ese despliegue es
 * INDISTINGUIBLE de un entorno local o autoalojado: no hay IP fiable, el límite por IP no se aplica y NO se emite ningún
 * aviso. Por eso el ajuste debe estar activado (ver README, «Despliegue en Vercel»); el código no puede detectarlo.
 * En local y autoalojado (VERCEL distinto de "1") tampoco avisa: ahí no tener IP es lo esperado.
 */
function warnIpUnavailable(): void {
  if (warned || process.env.VERCEL !== "1") return;
  warned = true;
  try {
    logError("rate_limit.ip_unavailable", new Error("Sin IP fiable en Vercel: el límite por IP está desactivado en esta petición"));
  } catch { /* un fallo de log nunca afecta a la petición */ }
}
