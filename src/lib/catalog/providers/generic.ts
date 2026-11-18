import { z } from "zod";
import { env } from "@/lib/env";
import { AWIN_MAPPING } from "./awin";
import type { CatalogProvider, FeedSource, FieldMapping } from "./types";

const listOf = z.array(z.string()).min(1);
const feedSchema = z.object({
  feedId: z.string().min(1),
  store: z.string().min(1),
  url: z.string().url().refine((u) => u.startsWith("https://"), "Solo https"),
  mapping: z.object({
    id: listOf, name: listOf, link: listOf, image: listOf, price: listOf, brand: listOf, color: listOf, category: listOf, description: listOf, stock: listOf,
  }).partial().optional(),
});

/**
 * Cualquier feed CSV que tengas autorizado (otra red de afiliación, un acuerdo directo con la tienda…).
 * Se declara en CATALOG_FEEDS_JSON; el mapeo de columnas parte del de Awin y se puede sobrescribir.
 */
export const genericProvider: CatalogProvider = {
  id: "feed",
  isConfigured: () => !!env().CATALOG_FEEDS_JSON,
  async discoverFeeds(): Promise<FeedSource[]> {
    const raw = env().CATALOG_FEEDS_JSON;
    if (!raw) return [];
    const feeds = z.array(feedSchema).parse(JSON.parse(raw));
    return feeds.map((f) => ({ provider: "feed", feedId: f.feedId, store: f.store, url: f.url, mapping: { ...AWIN_MAPPING, ...f.mapping } as FieldMapping }));
  },
};
