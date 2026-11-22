import { NextResponse } from "next/server";
import { AppError, handler } from "@/lib/errors";
import { isAuthorizedCron } from "@/lib/auth/cron";
import { mediaReconcileRunner, type MediaReconcileRunResult } from "@/services/media-reconcile-run.service";

/** Debe coincidir con RUN_MAX_DURATION_MS (el TTL del lease la supera en ≥ 60 s; lo comprueban las pruebas). */
export const maxDuration = 300;

/**
 * Reconciliación de medios PERSISTENTE (fase 19.7): adquiere el lease, detecta, guarda las candidatas de una detección
 * completa y cierra la ejecución. Solo para tareas programadas o administración (CRON_SECRET); no acepta parámetros.
 * No borra nada en Cloudinary. No está programada en vercel.json. El detector de solo lectura sigue en
 * /api/cron/media-reconcile, sin cambios.
 *
 * Respuesta AGREGADA (sin runId, fencingToken, publicId, URLs, ownerUserId, assetId ni candidatas):
 * - 200: COMPLETED, INCOMPLETE y BUSY (lease ocupado: no se ha ejecutado nada).
 * - 500: FAILED o LEASE_LOST (con códigos genéricos). Errores inesperados: respuesta genérica del handler común.
 */
export const GET = handler("cron.media_reconcile_run", async (req: Request) => {
  if (!isAuthorizedCron(req)) throw new AppError("No autorizado", 401, "UNAUTHORIZED");
  const r = await mediaReconcileRunner.run();
  return NextResponse.json(publicResult(r), { status: r.outcome === "FAILED" || r.outcome === "LEASE_LOST" ? 500 : 200 });
});

/** Lista blanca explícita de campos: lo que no esté aquí nunca sale en la respuesta. */
function publicResult(r: MediaReconcileRunResult) {
  if (r.outcome === "BUSY") return { outcome: r.outcome, reason: r.reason };
  return { outcome: r.outcome, finalized: r.finalized, errorCodes: r.errorCodes, persisted: r.persisted, report: r.report };
}
