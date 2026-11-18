export const CATEGORIES = [
  "TSHIRT", "SHIRT", "HOODIE", "SWEATER", "JACKET", "COAT", "TROUSERS", "JEANS", "SHORTS",
  "DRESS", "SKIRT", "SHOES", "SNEAKERS", "BOOTS", "ACCESSORY", "BAG", "OTHER",
] as const;
export type CategoryKey = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<CategoryKey, string> = {
  TSHIRT: "Camisetas", SHIRT: "Camisas", HOODIE: "Sudaderas", SWEATER: "Jerseys", JACKET: "Chaquetas",
  COAT: "Abrigos", TROUSERS: "Pantalones", JEANS: "Vaqueros", SHORTS: "Shorts", DRESS: "Vestidos",
  SKIRT: "Faldas", SHOES: "Zapatos", SNEAKERS: "Zapatillas", BOOTS: "Botas", ACCESSORY: "Accesorios",
  BAG: "Bolsos", OTHER: "Otros",
};

export const SEASONS = ["SPRING", "SUMMER", "AUTUMN", "WINTER", "ALL_YEAR"] as const;
export type SeasonKey = (typeof SEASONS)[number];
export const SEASON_LABELS: Record<SeasonKey, string> = {
  SPRING: "Primavera", SUMMER: "Verano", AUTUMN: "Otoño", WINTER: "Invierno", ALL_YEAR: "Todo el año",
};

export const STATUSES = ["AVAILABLE", "DIRTY", "UNAVAILABLE"] as const;
export type StatusKey = (typeof STATUSES)[number];
export const STATUS_LABELS: Record<StatusKey, string> = { AVAILABLE: "Disponible", DIRTY: "Sucia", UNAVAILABLE: "No disponible" };

/** Paleta cerrada: permite filtrar por color y que la IA no devuelva matices arbitrarios. */
export const COLORS = [
  "negro", "blanco", "gris", "beige", "crema", "marrón", "camel", "azul", "azul marino", "celeste",
  "verde", "caqui", "rojo", "burdeos", "rosa", "amarillo", "naranja", "morado", "multicolor", "otro",
] as const;
export type ColorKey = (typeof COLORS)[number];

export const COLOR_SWATCH: Record<ColorKey, string> = {
  negro: "#1d1b19", blanco: "#fbfaf7", gris: "#9a9690", beige: "#d8c8ad", crema: "#efe6d2", marrón: "#6b4a34",
  camel: "#b98a56", azul: "#3c62a8", "azul marino": "#1f2d4d", celeste: "#a9c8e6", verde: "#4d6a4f", caqui: "#85805a",
  rojo: "#b03a2e", burdeos: "#6d1f2b", rosa: "#e3a6b4", amarillo: "#e2c04a", naranja: "#d9803c", morado: "#6e4c8c",
  multicolor: "linear-gradient(135deg,#d9803c,#e2c04a,#4d6a4f,#3c62a8)", otro: "#c9c2b8",
};
