const PLACEHOLDER = "postgresql://localhost:5432/placeholder";

/** Neon expone el pooler (PgBouncer) en un host con el sufijo `-pooler` en la primera etiqueta. */
export function isPoolerUrl(url: string): boolean {
  try { return /-pooler(\.|$)/.test(new URL(url).hostname.split(".")[0] + "."); } catch { return false; }
}

/**
 * URL que usan las herramientas de Prisma (migrate, db…). Las migraciones necesitan conexión DIRECTA (bloqueos
 * consultivos y sesión estable, que PgBouncer en modo transacción no garantiza): se usa `DIRECT_URL`; `DATABASE_URL` solo
 * vale como alternativa. Ambas se descartan si son del pooler. Si no hay ninguna adecuada se devuelve un marcador que falla de forma
 * evidente al conectar (y no estorba a `prisma generate`, que no se conecta), en lugar de migrar por el pooler.
 */
export function migrationUrl(env: Record<string, string | undefined> = process.env): string {
  // Ninguna de las dos se acepta si apunta al pooler, tampoco DIRECT_URL (un error de configuración habitual).
  if (env.DIRECT_URL && !isPoolerUrl(env.DIRECT_URL)) return env.DIRECT_URL;
  if (env.DATABASE_URL && !isPoolerUrl(env.DATABASE_URL)) return env.DATABASE_URL;
  return PLACEHOLDER;
}
