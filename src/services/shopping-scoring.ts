import { inferColor } from "@/lib/catalog/normalize";

export interface ScoringProfile { favoriteBrands: string[]; favoriteColors: string[]; avoidedColors: string[]; budgetMinCents: number | null; budgetMaxCents: number | null }
export interface ScoredCandidate { id: string; brand: string | null; colorKey: string | null; priceCents: number }

const lc = (s: string) => s.trim().toLowerCase();

/** Colores que el usuario dice evitar, traducidos a la paleta cerrada. */
export const avoidedColorKeys = (p: Pick<ScoringProfile, "avoidedColors">) => new Set(p.avoidedColors.map((c) => inferColor(c)).filter((c): c is NonNullable<typeof c> => !!c));

/** Puntuación determinista (0–100) usada cuando la IA no puede ordenar. Cada punto tiene un motivo verificable. */
export function scoreCandidate(c: ScoredCandidate, gapColor: string | null, p: ScoringProfile): { score: number; reason: string } {
  let score = 50;
  const why: string[] = [];
  if (gapColor && c.colorKey === gapColor) { score += 25; why.push(`es del color buscado (${gapColor})`); }
  const fav = new Set(p.favoriteColors.map((x) => inferColor(x)).filter(Boolean));
  if (c.colorKey && fav.has(c.colorKey as never)) { score += 10; why.push("encaja con tus colores favoritos"); }
  if (c.brand && p.favoriteBrands.some((b) => lc(b) === lc(c.brand!))) { score += 10; why.push(`es de una marca que te gusta (${c.brand})`); }
  if (p.budgetMaxCents && c.priceCents <= p.budgetMaxCents) { score += 5; why.push("entra en tu presupuesto"); }
  return { score: Math.min(100, score), reason: why.length ? `Coincide con lo que buscas: ${why.join(", ")}.` : "Coincide con la categoría que buscas." };
}

/** Excluye lo que el usuario no quiere ver: colores evitados y precios fuera de su rango. */
export function passesFilters<T extends ScoredCandidate>(c: T, p: ScoringProfile): boolean {
  if (c.colorKey && avoidedColorKeys(p).has(c.colorKey as never)) return false;
  if (p.budgetMaxCents && c.priceCents > p.budgetMaxCents) return false;
  if (p.budgetMinCents && c.priceCents < p.budgetMinCents) return false;
  return true;
}
