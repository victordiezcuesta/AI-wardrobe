import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

/**
 * Autorización de tareas programadas (mismo patrón que /api/cron/catalog-sync): Vercel Cron envía
 * "Authorization: Bearer $CRON_SECRET". Sin CRON_SECRET configurado, nadie está autorizado. Comparación en tiempo constante.
 * Las longitudes se comparan en BYTES: con caracteres no ASCII la longitud en caracteres puede coincidir y la de bytes no,
 * y timingSafeEqual lanzaría una excepción (500) en lugar de denegar.
 */
export function isAuthorizedCron(req: Request): boolean {
  const secret = env().CRON_SECRET;
  if (!secret) return false;
  const given = Buffer.from(req.headers.get("authorization") ?? "", "utf8");
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
