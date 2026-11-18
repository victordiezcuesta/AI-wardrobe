import { env } from "@/lib/env";
import { parseCsvRecords } from "@/lib/catalog/csv";
import { isHttpsUrl, slugify } from "@/lib/catalog/normalize";
import { Readable } from "node:stream";
import type { CatalogProvider, FeedSource, FieldMapping } from "./types";

/** Columnas documentadas por Awin para feeds de publisher (aw_deep_link es el enlace con tu tracking). */
export const AWIN_MAPPING: FieldMapping = {
  id: ["aw_product_id", "merchant_product_id"],
  name: ["product_name"],
  link: ["aw_deep_link"],
  image: ["merchant_image_url", "aw_image_url", "large_image"],
  price: ["search_price", "store_price", "base_price"],
  brand: ["brand_name"],
  color: ["colour", "color"],
  category: ["merchant_category", "category_name", "merchant_product_category_path"],
  description: ["description", "product_short_description"],
  stock: ["in_stock"],
};

const norm = (s: string) => slugify(s).replace(/-/g, "");

export const awinProvider: CatalogProvider = {
  id: "awin",
  isConfigured: () => !!(env().AWIN_PUBLISHER_ID && env().AWIN_DATAFEED_KEY),

  /**
   * Lista los feeds de tu cuenta (https://ui.awin.com/productdata-darwin-download/publisher/{id}/{key}/1/feedList)
   * y se queda con los de tiendas permitidas, de tu región y con membresía activa: solo lo que Awin te autoriza.
   */
  async discoverFeeds(): Promise<FeedSource[]> {
    const e = env();
    const url = `https://ui.awin.com/productdata-darwin-download/publisher/${e.AWIN_PUBLISHER_ID}/${e.AWIN_DATAFEED_KEY}/1/feedList`;
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Awin feedList respondió ${res.status}`);
    const allowed = e.CATALOG_STORES.split(",").map((s) => norm(s)).filter(Boolean);
    const region = e.CATALOG_REGION.toLowerCase();

    const feeds: FeedSource[] = [];
    for await (const r of parseCsvRecords(Readable.fromWeb(res.body as never))) {
      const name = r["advertiser name"] ?? "";
      if ((r["membership status"] ?? "").toLowerCase() !== "active") continue;
      if ((r["primary region"] ?? "").toLowerCase() !== region) continue;
      if (!allowed.some((a) => norm(name).includes(a))) continue;
      if (!isHttpsUrl(r["url"]) || !r["feed id"]) continue;
      feeds.push({ provider: "awin", feedId: r["feed id"], store: name, url: r["url"], mapping: AWIN_MAPPING });
    }
    return feeds;
  },
};
