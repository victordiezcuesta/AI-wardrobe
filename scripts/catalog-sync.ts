/**
 * Sincroniza el catálogo fuera de serverless (sin límite de tiempo): `npm run catalog:sync`.
 * Útil para catálogos grandes o la primera carga. Requiere DATABASE_URL y las variables de las fuentes.
 */
import "dotenv/config";
import { catalogSyncService } from "../src/services/catalog-sync.service";

async function main(): Promise<number> {
  const out = await catalogSyncService.syncAll();
  if (!out.configured) {
    console.error("No hay ninguna fuente de catálogo configurada (AWIN_PUBLISHER_ID/AWIN_DATAFEED_KEY o CATALOG_FEEDS_JSON).");
    return 1;
  }
  for (const r of out.results) {
    console.log(`${r.error ? "✗" : "✓"} ${r.store} (feed ${r.feedId}): ${r.imported}/${r.rows} productos importados${r.truncated ? " [truncado]" : ""}${r.error ? ` — ${r.error}` : ""}`);
  }
  return out.results.some((r) => r.error) ? 2 : 0;
}

main().then((code) => process.exit(code), (err) => { console.error(err instanceof Error ? err.message : err); process.exit(3); });
