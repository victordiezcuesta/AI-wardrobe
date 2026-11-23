import { NextResponse } from "next/server";
import { AppError, handler } from "@/lib/errors";
import { isAuthorizedCron } from "@/lib/auth/cron";
import { purgeExpiredRateLimits } from "@/services/rate-limit-purge.service";

export const maxDuration = 60;

/**
 * Purga de filas caducadas de RateLimit (fase 19.14c). Solo para tareas programadas o administración (CRON_SECRET); no
 * acepta parámetros: retención, tamaño de lote, número de lotes y presupuesto son constantes del servicio. La autorización
 * se comprueba ANTES de tocar la base de datos. Respuesta mínima y agregada: nunca claves, emails, IP ni hashes.
 * Programada a diario a las 04:30 UTC en vercel.json.
 */
export const GET = handler("cron.rate_limit_purge", async (req: Request) => {
  if (!isAuthorizedCron(req)) throw new AppError("No autorizado", 401, "UNAUTHORIZED");
  const { deleted, batches, complete } = await purgeExpiredRateLimits();
  return NextResponse.json({ ok: true, deleted, batches, complete });
});
