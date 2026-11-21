import { NextResponse } from "next/server";
import { AppError, handler } from "@/lib/errors";
import { isAuthorizedCron } from "@/lib/auth/cron";
import { DEFAULT_BUDGET_MS, detectOrphanMedia } from "@/services/media-reconcile.service";

export const maxDuration = 300;

/**
 * Detector de imágenes huérfanas (SOLO LECTURA): devuelve un informe agregado, sin identificadores ni URLs. Solo para
 * tareas programadas o administración (CRON_SECRET); no acepta parámetros: carpetas, prefijos y plazos son fijos.
 * No está programado en vercel.json: cada ejecución consume cuota de la Admin API de Cloudinary.
 */
export const GET = handler("cron.media_reconcile", async (req: Request) => {
  if (!isAuthorizedCron(req)) throw new AppError("No autorizado", 401, "UNAUTHORIZED");
  return NextResponse.json(await detectOrphanMedia({ budgetMs: DEFAULT_BUDGET_MS }));
});
