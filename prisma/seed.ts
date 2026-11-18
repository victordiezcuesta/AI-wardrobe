/**
 * Inicializa datos de referencia: `npm run db:seed` (idempotente).
 * Crea las categorías de prenda; el resto de datos los genera cada usuario.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { CATEGORIES, CATEGORY_LABELS } from "../src/features/wardrobe/constants";

async function main() {
  for (const key of CATEGORIES) {
    await prisma.clothingCategory.upsert({ where: { key }, create: { key, label: CATEGORY_LABELS[key] }, update: { label: CATEGORY_LABELS[key] } });
  }
  console.log(`✓ ${CATEGORIES.length} categorías de prenda sincronizadas`);
}

main().then(() => process.exit(0), (e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
