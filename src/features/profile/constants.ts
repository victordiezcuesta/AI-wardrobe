export const STYLES = [
  { value: "casual", label: "Casual" },
  { value: "smart_casual", label: "Smart casual" },
  { value: "formal", label: "Formal" },
  { value: "streetwear", label: "Streetwear" },
  { value: "minimalista", label: "Minimalista" },
  { value: "old_money", label: "Old money" },
  { value: "deportivo", label: "Deportivo" },
  { value: "elegante", label: "Elegante" },
  { value: "urbano", label: "Urbano" },
  { value: "clasico", label: "Clásico" },
  { value: "business_casual", label: "Business casual" },
  { value: "vintage", label: "Vintage" },
] as const;

export const GARMENT_TYPES = [
  { value: "camisetas", label: "Camisetas" }, { value: "camisas", label: "Camisas" },
  { value: "sudaderas", label: "Sudaderas" }, { value: "jerseys", label: "Jerseys" },
  { value: "chaquetas", label: "Chaquetas" }, { value: "abrigos", label: "Abrigos" },
  { value: "pantalones", label: "Pantalones" }, { value: "vaqueros", label: "Vaqueros" },
  { value: "vestidos", label: "Vestidos" }, { value: "faldas", label: "Faldas" },
  { value: "zapatillas", label: "Zapatillas" }, { value: "botas", label: "Botas" },
] as const;

export const FIT_OPTIONS = [
  { value: "ajustado", label: "Ajustado" },
  { value: "regular", label: "Regular" },
  { value: "holgado", label: "Holgado / oversize" },
] as const;
