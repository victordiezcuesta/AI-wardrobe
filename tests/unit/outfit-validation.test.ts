import { describe, expect, it } from "vitest";
import { validateOutfits, type AliasedItem } from "@/services/outfit-validation";
import { formalityBand } from "@/services/preference.service";
import { weatherToText, type WeatherSummary } from "@/lib/weather/open-meteo";
import type { AiOutfits } from "@/lib/validations/stylist";

const aliasMap = new Map<string, AliasedItem>([
  ["i1", { id: "db-1", category: "TSHIRT" }], ["i2", { id: "db-2", category: "JEANS" }], ["i3", { id: "db-3", category: "SNEAKERS" }],
  ["i4", { id: "db-4", category: "SHIRT" }], ["i5", { id: "db-5", category: "TROUSERS" }], ["i6", { id: "db-6", category: "BOOTS" }],
]);
const outfit = (over: Partial<AiOutfits["outfits"][number]> = {}): AiOutfits["outfits"][number] => ({
  name: "Look", description: "d", occasion: "o", reasoning: "r", colorExplanation: "c", weatherFit: "w", styleFit: "s",
  itemIds: ["i1", "i2", "i3"], alternatives: [], ...over,
});

describe("validateOutfits (regla fundamental)", () => {
  it("acepta conjuntos con prendas reales y los traduce a ids de base de datos", () => {
    const { valid, rejected } = validateOutfits({ outfits: [outfit()] }, aliasMap);
    expect(rejected).toEqual([]);
    expect(valid[0]?.itemIds).toEqual(["db-1", "db-2", "db-3"]);
  });
  it("rechaza ids inventados", () => {
    const { valid, rejected } = validateOutfits({ outfits: [outfit({ itemIds: ["i1", "i2", "i99"] })] }, aliasMap);
    expect(valid).toHaveLength(0);
    expect(rejected[0]).toContain("i99");
  });
  it("rechaza ids reales de la base de datos (solo valen los alias de esta petición)", () => {
    expect(validateOutfits({ outfits: [outfit({ itemIds: ["db-1", "db-2"] })] }, aliasMap).valid).toHaveLength(0);
  });
  it("exige conjunto completo", () => {
    expect(validateOutfits({ outfits: [outfit({ itemIds: ["i1", "i3"] })] }, aliasMap).valid).toHaveLength(0);
  });
  it("descarta conjuntos repetidos o ya propuestos", () => {
    const dup = validateOutfits({ outfits: [outfit(), outfit({ name: "Otro", itemIds: ["i3", "i2", "i1"] })] }, aliasMap);
    expect(dup.valid).toHaveLength(1);
    const prev = validateOutfits({ outfits: [outfit()] }, aliasMap, new Set(["db-1|db-2|db-3"]));
    expect(prev.valid).toHaveLength(0);
  });
  it("ignora alternativas inválidas pero conserva las correctas", () => {
    const { valid } = validateOutfits({
      outfits: [outfit({ alternatives: [
        { itemId: "i4", replacesItemId: "i1", reason: "ok" },
        { itemId: "i99", replacesItemId: "i1", reason: "inventada" },
        { itemId: "i5", replacesItemId: "i6", reason: "reemplaza algo que no está en el conjunto" },
      ] })],
    }, aliasMap);
    expect([...(valid[0]?.alternatives ?? new Map())]).toEqual([["db-1", ["db-4"]]]);
  });
});

describe("preferencias y clima", () => {
  it("agrupa la formalidad en franjas", () => {
    expect(formalityBand(1)).toBe("informal");
    expect(formalityBand(3)).toBe("media");
    expect(formalityBand(5)).toBe("formal");
    expect(formalityBand(null)).toBeNull();
  });
  it("resume el clima y la franja horaria pedida", () => {
    const w: WeatherSummary = {
      date: "2026-11-17", timezone: "Europe/Madrid",
      daily: { tMin: 6, tMax: 14, apparentMin: 4, apparentMax: 12, precipProbMax: 70, windMax: 25, code: 61, description: "lluvia ligera" },
      hourly: [{ time: "2026-11-17T20:00", temperature: 9, apparent: 7, precipProb: 60, wind: 12, code: 61 }],
    };
    const t = weatherToText(w, "21:00");
    expect(t).toContain("lluvia ligera");
    expect(t).toContain("Hacia las 21:00");
  });
});
