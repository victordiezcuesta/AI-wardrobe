import { prisma } from "@/lib/prisma";
import { tooMany } from "@/lib/errors";

/**
 * Ventana fija respaldada por PostgreSQL: funciona entre instancias serverless
 * (un limitador en memoria no sirve en Vercel). Una sola consulta atómica.
 */
export async function rateLimit(key: string, limit: number, windowSec: number): Promise<void> {
  const rows = await prisma.$queryRaw<{ count: number; windowStart: Date }[]>`
    INSERT INTO "RateLimit" ("key", "count", "windowStart")
    VALUES (${key}, 1, NOW())
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "RateLimit"."windowStart" < NOW() - (${windowSec} * INTERVAL '1 second') THEN 1 ELSE "RateLimit"."count" + 1 END,
      "windowStart" = CASE WHEN "RateLimit"."windowStart" < NOW() - (${windowSec} * INTERVAL '1 second') THEN NOW() ELSE "RateLimit"."windowStart" END
    RETURNING "count", "windowStart"`;
  const row = rows[0];
  if (row && row.count > limit) {
    const elapsed = Math.floor((Date.now() - row.windowStart.getTime()) / 1000);
    throw tooMany(Math.max(1, windowSec - elapsed));
  }
}

export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}
