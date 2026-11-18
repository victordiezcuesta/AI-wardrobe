import type { CategoryKey, ColorKey } from "@/features/wardrobe/constants";

const strip = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

// Orden importa: patrones más específicos primero (camiseta antes que camisa, vaquero antes que pantalón…).
const CATEGORY_RULES: [RegExp, CategoryKey][] = [
  [/\b(camiseta|camisetas|t-?shirt|tee|polo|polos|top de tirantes|tank)\b/, "TSHIRT"],
  [/\b(sudadera|sudaderas|hoodie|sweatshirt)\b/, "HOODIE"],
  [/\b(vaquero|vaqueros|jean|jeans|denim)\b/, "JEANS"],
  [/\b(camisa|camisas|shirt|shirts|blusa|blusas|blouse)\b/, "SHIRT"],
  [/\b(jersey|jerseys|sweater|cardigan|cárdigan|chaleco de punto|pullover|punto)\b/, "SWEATER"],
  [/\b(abrigo|abrigos|coat|parka|gabardina|trench|plumifero|anorak)\b/, "COAT"],
  [/\b(chaqueta|chaquetas|jacket|blazer|americana|cazadora|bomber|chaleco|cardigan)\b/, "JACKET"],
  [/\b(bermuda|bermudas|short|shorts)\b/, "SHORTS"],
  [/\b(pantalon|pantalones|trousers|pants|chino|chinos|jogger|joggers|leggings)\b/, "TROUSERS"],
  [/\b(vestido|vestidos|dress|dresses|mono|jumpsuit)\b/, "DRESS"],
  [/\b(falda|faldas|skirt|skirts)\b/, "SKIRT"],
  [/\b(zapatilla|zapatillas|sneaker|sneakers|trainer|trainers|deportivas)\b/, "SNEAKERS"],
  [/\b(bota|botas|botin|botines|boot|boots)\b/, "BOOTS"],
  [/\b(zapato|zapatos|shoe|shoes|mocasin|mocasines|loafer|loafers|derby|sandalia|sandalias|bailarina|bailarinas|tacon|tacones)\b/, "SHOES"],
  [/\b(bolso|bolsos|bag|bags|mochila|mochilas|bandolera|cartera|tote)\b/, "BAG"],
  [/\b(cinturon|cinturones|belt|gorro|gorra|bufanda|scarf|guantes|gafas|sunglasses|reloj|corbata|sombrero|panuelo|pendientes|collar)\b/, "ACCESSORY"],
];

/** Infiere la categoría del armario a partir del texto del feed. null = no es ropa/calzado/accesorio que gestionemos. */
export function inferCategory(...texts: (string | undefined)[]): CategoryKey | null {
  for (const t of texts) {
    if (!t) continue;
    const s = strip(t);
    for (const [re, cat] of CATEGORY_RULES) if (re.test(s)) return cat;
  }
  return null;
}

const COLOR_RULES: [RegExp, ColorKey][] = [
  [/\b(azul marino|marino|navy|midnight)\b/, "azul marino"],
  [/\b(celeste|azul claro|light blue|sky|baby blue)\b/, "celeste"],
  [/\b(azul|blue|denim blue|indigo|cobalto)\b/, "azul"],
  [/\b(negro|black|antracita)\b/, "negro"],
  [/\b(blanco|white|optic)\b/, "blanco"],
  [/\b(crudo|crema|cream|ecru|marfil|ivory|off.?white|hueso)\b/, "crema"],
  [/\b(beige|arena|sand|stone|taupe)\b/, "beige"],
  [/\b(camel|tan|cognac|coñac|cuero)\b/, "camel"],
  [/\b(marron|brown|chocolate|tabaco|moka|mocha)\b/, "marrón"],
  [/\b(gris|grey|gray|plomo|charcoal|marengo)\b/, "gris"],
  [/\b(caqui|khaki|oliva|olive|militar)\b/, "caqui"],
  [/\b(verde|green|menta|botella|esmeralda)\b/, "verde"],
  [/\b(burdeos|granate|burgundy|vino|wine|maroon)\b/, "burdeos"],
  [/\b(rojo|red|rubi|coral)\b/, "rojo"],
  [/\b(rosa|pink|fucsia|nude|maquillaje)\b/, "rosa"],
  [/\b(amarillo|yellow|mostaza|mustard|limon)\b/, "amarillo"],
  [/\b(naranja|orange|teja|terracota)\b/, "naranja"],
  [/\b(morado|purple|lila|violeta|violet|lavanda|lavender|malva)\b/, "morado"],
  [/\b(multicolor|multi|estampado|print|rayas|cuadros)\b/, "multicolor"],
];

export function inferColor(text: string | undefined): ColorKey | null {
  if (!text) return null;
  const s = strip(text);
  for (const [re, c] of COLOR_RULES) if (re.test(s)) return c;
  return null;
}

/** "29,95", "29.95", "EUR 29.95", "1.299,00", "€ 1,299.00" → céntimos. null si no es un precio válido. */
export function parsePriceCents(raw: string | undefined): number | null {
  if (!raw) return null;
  let s = raw.replace(/[^\d.,]/g, "");
  if (!s) return null;
  const lastComma = s.lastIndexOf(","), lastDot = s.lastIndexOf(".");
  if (lastComma > -1 && lastDot > -1) {
    // El último separador es el decimal; el otro, de millares.
    s = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (lastComma > -1) {
    s = /,\d{1,2}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
  } else if (lastDot > -1 && !/\.\d{1,2}$/.test(s)) s = s.replace(/\./g, "");
  const n = Number(s);
  return Number.isFinite(n) && n > 0 && n < 100000 ? Math.round(n * 100) : null;
}

export const isHttpsUrl = (u: string | undefined): u is string => {
  if (!u) return false;
  try { return new URL(u).protocol === "https:"; } catch { return false; }
};

export const slugify = (s: string) => strip(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
