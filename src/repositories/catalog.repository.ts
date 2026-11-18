import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { CatalogRow } from "@/lib/catalog/record";
import type { CategoryKey } from "@/features/wardrobe/constants";

export interface SyncBatchMeta { provider: string; feedId: string; store: string; currency?: string }

/**
 * Upsert masivo de una tanda en UNA sentencia (unnest). Función pura que devuelve SQL parametrizado,
 * para poder ejecutarla tal cual contra PostgreSQL en los tests.
 */
export function buildUpsertSql(meta: SyncBatchMeta, rows: CatalogRow[]): { sql: string; params: unknown[] } {
  // Una misma tanda no puede repetir la clave de conflicto: se queda la última aparición.
  const unique = [...new Map(rows.map((r) => [r.externalId, r])).values()];
  const params = [
    unique.map(() => randomUUID()),
    unique.map(() => meta.provider),
    unique.map(() => meta.feedId),
    unique.map((r) => r.externalId),
    unique.map(() => meta.store),
    unique.map((r) => r.brand ?? ""),
    unique.map((r) => r.name),
    unique.map((r) => r.description ?? ""),
    unique.map((r) => r.category),
    unique.map((r) => r.colorKey ?? ""),
    unique.map((r) => r.colorText ?? ""),
    unique.map((r) => r.priceCents),
    unique.map(() => meta.currency ?? "EUR"),
    unique.map((r) => r.imageUrl),
    unique.map((r) => r.url),
  ];
  const sql = `
INSERT INTO "CatalogProduct" ("id","provider","feedId","externalId","store","brand","name","description","category","colorKey","colorText","priceCents","currency","imageUrl","url","syncedAt")
SELECT t.id, t.provider, t.feed, t.ext, t.store, NULLIF(t.brand,''), t.name, NULLIF(t.descr,''), t.cat::"Category", NULLIF(t.ck,''), NULLIF(t.ct,''), t.price, t.cur, t.img, t.url, NOW()
FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::int[], $13::text[], $14::text[], $15::text[])
  AS t(id, provider, feed, ext, store, brand, name, descr, cat, ck, ct, price, cur, img, url)
ON CONFLICT ("provider","feedId","externalId") DO UPDATE SET
  "store" = EXCLUDED."store", "brand" = EXCLUDED."brand", "name" = EXCLUDED."name", "description" = EXCLUDED."description",
  "category" = EXCLUDED."category", "colorKey" = EXCLUDED."colorKey", "colorText" = EXCLUDED."colorText",
  "priceCents" = EXCLUDED."priceCents", "currency" = EXCLUDED."currency", "imageUrl" = EXCLUDED."imageUrl",
  "url" = EXCLUDED."url", "syncedAt" = NOW()`;
  return { sql, params };
}

export interface CatalogSearch {
  category: CategoryKey;
  colorKey?: string | null;
  maxPriceCents?: number | null;
  minPriceCents?: number | null;
  terms?: string[];
  stores?: string[];
  limit?: number;
}

export const catalogRepository = {
  async upsertBatch(meta: SyncBatchMeta, rows: CatalogRow[]) {
    if (rows.length === 0) return 0;
    const { sql, params } = buildUpsertSql(meta, rows);
    await prisma.$executeRawUnsafe(sql, ...params);
    return rows.length;
  },
  /** Lo que no aparece en la última descarga completa ya no está a la venta: se elimina. */
  async deleteStale(provider: string, feedId: string, before: Date) {
    return (await prisma.catalogProduct.deleteMany({ where: { provider, feedId, syncedAt: { lt: before } } })).count;
  },
  startSync: (provider: string, feedId: string, store: string) =>
    prisma.catalogSync.create({ data: { provider, feedId, store, status: "RUNNING" } }),
  finishSync: (id: string, data: { status: "OK" | "FAILED"; rows: number; imported: number; error?: string }) =>
    prisma.catalogSync.update({ where: { id }, data: { ...data, finishedAt: new Date() } }),
  stats: async () => {
    const [products, stores, lastSync] = await Promise.all([
      prisma.catalogProduct.count(),
      prisma.catalogProduct.groupBy({ by: ["store"], _count: { _all: true } }),
      prisma.catalogSync.findFirst({ where: { status: "OK" }, orderBy: { finishedAt: "desc" }, select: { finishedAt: true } }),
    ]);
    return { products, stores: stores.map((s) => ({ store: s.store, count: s._count._all })), lastSyncAt: lastSync?.finishedAt ?? null };
  },
  async search(q: CatalogSearch) {
    const terms = (q.terms ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 4);
    return prisma.catalogProduct.findMany({
      where: {
        category: q.category,
        ...(q.colorKey && { colorKey: q.colorKey }),
        ...((q.maxPriceCents || q.minPriceCents) && { priceCents: { ...(q.minPriceCents && { gte: q.minPriceCents }), ...(q.maxPriceCents && { lte: q.maxPriceCents }) } }),
        ...(q.stores?.length && { store: { in: q.stores } }),
        ...(terms.length && { OR: terms.map((t) => ({ name: { contains: t, mode: "insensitive" as const } })) }),
      },
      orderBy: [{ syncedAt: "desc" }, { priceCents: "asc" }],
      take: q.limit ?? 40,
    });
  },
};
