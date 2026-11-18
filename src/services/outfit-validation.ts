import type { AiOutfits } from "@/lib/validations/stylist";
import type { CategoryKey } from "@/features/wardrobe/constants";

const TOPS: CategoryKey[] = ["TSHIRT", "SHIRT", "HOODIE", "SWEATER"];
const BOTTOMS: CategoryKey[] = ["TROUSERS", "JEANS", "SHORTS", "SKIRT"];

export interface AliasedItem { id: string; category: CategoryKey }
export interface ValidOutfit { raw: AiOutfits["outfits"][number]; itemIds: string[]; alternatives: Map<string, string[]> }

/**
 * REGLA FUNDAMENTAL: una prenda solo es válida si el alias existe en el mapa construido
 * desde el armario DISPONIBLE del usuario en esta petición. Cualquier otro id se rechaza.
 * Devuelve también los motivos de rechazo para reintentar con retroalimentación.
 */
export function validateOutfits(ai: AiOutfits, aliasMap: Map<string, AliasedItem>, avoidSignatures: Set<string> = new Set()): { valid: ValidOutfit[]; rejected: string[] } {
  const valid: ValidOutfit[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>(avoidSignatures);

  for (const o of ai.outfits) {
    const unknown = o.itemIds.filter((a) => !aliasMap.has(a));
    if (unknown.length) { rejected.push(`«${o.name}» usa ids inexistentes: ${unknown.join(", ")}`); continue; }
    const ids = [...new Set(o.itemIds.map((a) => aliasMap.get(a)!.id))];
    if (ids.length < 2) { rejected.push(`«${o.name}» tiene menos de 2 prendas distintas`); continue; }
    const cats = ids.map((id) => [...aliasMap.values()].find((v) => v.id === id)!.category);
    const complete = cats.includes("DRESS") || (cats.some((c) => TOPS.includes(c)) && cats.some((c) => BOTTOMS.includes(c)));
    if (!complete) { rejected.push(`«${o.name}» no es un conjunto completo (falta vestido o parte de arriba + parte de abajo)`); continue; }
    const signature = [...ids].sort().join("|");
    if (seen.has(signature)) { rejected.push(`«${o.name}» repite una combinación ya propuesta`); continue; }
    seen.add(signature);

    const alternatives = new Map<string, string[]>();
    for (const alt of o.alternatives) {
      const replacement = aliasMap.get(alt.itemId);
      const replaced = aliasMap.get(alt.replacesItemId);
      if (!replacement || !replaced || !ids.includes(replaced.id) || ids.includes(replacement.id)) continue; // alternativa inválida: se ignora
      alternatives.set(replaced.id, [...(alternatives.get(replaced.id) ?? []), replacement.id]);
    }
    valid.push({ raw: o, itemIds: ids, alternatives });
  }
  return { valid, rejected };
}

export const outfitSignature = (ids: string[]) => [...ids].sort().join("|");
