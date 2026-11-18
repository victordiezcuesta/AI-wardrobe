import type { CategoryKey } from "@/features/wardrobe/constants";
import { inferCategory, inferColor, isHttpsUrl, parsePriceCents } from "./normalize";
import type { FieldMapping } from "./providers/types";

export interface CatalogRow {
  externalId: string; name: string; brand: string | null; description: string | null; category: CategoryKey;
  colorKey: string | null; colorText: string | null; priceCents: number; imageUrl: string; url: string;
}

const pick = (rec: Record<string, string>, keys: string[]) => { for (const k of keys) { const v = rec[k]; if (v) return v; } return ""; };

/** Convierte una fila de feed en un producto del catálogo, o null si le falta algo imprescindible. Nada se inventa. */
export function toCatalogRow(rec: Record<string, string>, m: FieldMapping): CatalogRow | null {
  const stock = pick(rec, m.stock).toLowerCase();
  if (stock && ["0", "false", "no", "out of stock", "agotado"].includes(stock)) return null;

  const externalId = pick(rec, m.id);
  const name = pick(rec, m.name).slice(0, 160);
  const url = pick(rec, m.link);
  const imageUrl = pick(rec, m.image);
  const priceCents = parsePriceCents(pick(rec, m.price));
  if (!externalId || !name || !isHttpsUrl(url) || !isHttpsUrl(imageUrl) || priceCents == null) return null;

  const category = inferCategory(pick(rec, m.category), name);
  if (!category) return null;
  const colorText = pick(rec, m.color) || null;
  return {
    externalId, name, url, imageUrl, priceCents, category,
    brand: pick(rec, m.brand).slice(0, 80) || null,
    description: pick(rec, m.description).slice(0, 400) || null,
    colorText: colorText?.slice(0, 60) ?? null,
    colorKey: inferColor(colorText ?? undefined) ?? inferColor(name),
  };
}
