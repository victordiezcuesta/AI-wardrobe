import { NextResponse } from "next/server";
import { AppError, handler } from "@/lib/errors";
import { isAuthorizedCron } from "@/lib/auth/cron";
import { DEFAULT_BUDGET_MS, detectOrphanMedia } from "@/services/media-reconcile.service";
import { publicReport } from "@/services/media-reconcile-public";

export const maxDuration = 300;

/**
 * Detector de imágenes huérfanas (SOLO LECTURA): devuelve un informe agregado, sin identificadores ni URLs. Solo para
 * tareas programadas o administración (CRON_SECRET); no acepta parámetros: carpetas, prefijos y plazos son fijos.
 * No está programado en vercel.json: cada ejecución consume cuota de la Admin API de Cloudinary.
 * El cuerpo es el informe tal cual (mismas claves), pero proyectado por publicReport (19.9e): lista blanca de campos y de
 * códigos de error, fechas ISO UTC estrictas; nada más sale al cliente.
 */
export const GET = handler("cron.media_reconcile", async (req: Request) => {
  if (!isAuthorizedCron(req)) throw new AppError("No autorizado", 401, "UNAUTHORIZED");
  return NextResponse.json(publicReport(await detectOrphanMedia({ budgetMs: DEFAULT_BUDGET_MS })));
});
