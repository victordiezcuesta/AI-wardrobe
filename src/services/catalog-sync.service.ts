import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { env } from "@/lib/env";
import { logError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { parseCsvRecords } from "@/lib/catalog/csv";
import { toCatalogRow, type CatalogRow } from "@/lib/catalog/record";
import { configuredProviders, type FeedSource } from "@/lib/catalog/providers";
import { catalogRepository } from "@/repositories/catalog.repository";

const BATCH = 500;

/** Abre el feed como stream de texto; descomprime solo si empieza con la firma gzip (1f 8b). */
export async function openFeed(url: string): Promise<Readable> {
  const res = await fetch(url, { signal: AbortSignal.timeout(280_000) });
  if (!res.ok || !res.body) throw new Error(`El feed respondió ${res.status}`);
  const iterator = Readable.fromWeb(res.body as never)[Symbol.asyncIterator]();
  const first = await iterator.next();
  const head = first.done ? null : (first.value as Buffer);
  const raw = Readable.from((async function* () {
    if (head) yield head;
    for (;;) { const n = await iterator.next(); if (n.done) return; yield n.value as Buffer; }
  })());
  return head && head[0] === 0x1f && head[1] === 0x8b ? raw.pipe(createGunzip()) : raw;
}

export interface FeedResult { feedId: string; store: string; rows: number; imported: number; truncated: boolean; error?: string }

export const catalogSyncService = {
  async syncFeed(source: FeedSource): Promise<FeedResult> {
    const startedAt = new Date();
    const log = await catalogRepository.startSync(source.provider, source.feedId, source.store);
    const maxRows = env().CATALOG_MAX_ROWS_PER_FEED;
    const meta = { provider: source.provider, feedId: source.feedId, store: source.store };
    let rows = 0, imported = 0, truncated = false;
    try {
      let batch: CatalogRow[] = [];
      for await (const rec of parseCsvRecords(await openFeed(source.url))) {
        rows++;
        const row = toCatalogRow(rec, source.mapping);
        if (!row) continue;
        batch.push(row);
        if (batch.length >= BATCH) { imported += await catalogRepository.upsertBatch(meta, batch); batch = []; }
        if (imported + batch.length >= maxRows) { truncated = true; break; }
      }
      imported += await catalogRepository.upsertBatch(meta, batch);
      // Solo una descarga COMPLETA permite concluir que lo ausente ya no está a la venta.
      if (!truncated) await catalogRepository.deleteStale(source.provider, source.feedId, startedAt);
      await catalogRepository.finishSync(log.id, { status: "OK", rows, imported });
      return { feedId: source.feedId, store: source.store, rows, imported, truncated };
    } catch (err) {
      logError("catalog.sync", err);
      const message = err instanceof Error ? err.message.replace(/apikey\/[^/\s]+/gi, "apikey/***") : "Error";
      await catalogRepository.finishSync(log.id, { status: "FAILED", rows, imported, error: message.slice(0, 300) });
      return { feedId: source.feedId, store: source.store, rows, imported, truncated, error: message };
    }
  },

  /** Sincroniza los feeds autorizados, empezando por los que llevan más tiempo sin actualizarse. */
  async syncAll(opts: { budgetMs?: number } = {}) {
    const providers = configuredProviders();
    if (providers.length === 0) return { configured: false as const, results: [] as FeedResult[], skipped: 0 };

    const feeds: FeedSource[] = [];
    for (const p of providers) {
      try { feeds.push(...(await p.discoverFeeds())); } catch (e) { logError(`catalog.discover.${p.id}`, e); }
    }
    const last = await prisma.catalogSync.findMany({ where: { status: "OK" }, orderBy: { finishedAt: "desc" }, distinct: ["provider", "feedId"], select: { provider: true, feedId: true, finishedAt: true } });
    const lastAt = new Map(last.map((l) => [`${l.provider}:${l.feedId}`, l.finishedAt?.getTime() ?? 0]));
    feeds.sort((a, b) => (lastAt.get(`${a.provider}:${a.feedId}`) ?? 0) - (lastAt.get(`${b.provider}:${b.feedId}`) ?? 0));

    const deadline = opts.budgetMs ? Date.now() + opts.budgetMs : Infinity;
    const results: FeedResult[] = [];
    let skipped = 0;
    for (const f of feeds) {
      if (Date.now() > deadline) { skipped++; continue; }
      results.push(await this.syncFeed(f));
    }
    return { configured: true as const, results, skipped };
  },
};
