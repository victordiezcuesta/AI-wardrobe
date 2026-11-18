import { describe, expect, it } from "vitest";
import { passesFilters, scoreCandidate, type ScoringProfile } from "@/services/shopping-scoring";
import { gapsSchema, rankingSchema } from "@/lib/validations/shopping";

const profile: ScoringProfile = { favoriteBrands: ["Mango"], favoriteColors: ["beige"], avoidedColors: ["rojo", "naranja"], budgetMinCents: null, budgetMaxCents: 5000 };
const c = (over: Partial<{ id: string; brand: string | null; colorKey: string | null; priceCents: number }> = {}) => ({ id: "1", brand: "Mango", colorKey: "azul", priceCents: 3000, ...over });

describe("passesFilters", () => {
  it("excluye colores que el usuario evita (aunque los escriba en texto libre)", () => {
    expect(passesFilters(c({ colorKey: "rojo" }), profile)).toBe(false);
    expect(passesFilters(c({ colorKey: "naranja" }), profile)).toBe(false);
    expect(passesFilters(c({ colorKey: "azul" }), profile)).toBe(true);
  });
  it("respeta el presupuesto", () => {
    expect(passesFilters(c({ priceCents: 5001 }), profile)).toBe(false);
    expect(passesFilters(c({ priceCents: 5000 }), profile)).toBe(true);
    expect(passesFilters(c({ priceCents: 500 }), { ...profile, budgetMinCents: 1000 })).toBe(false);
  });
});

describe("scoreCandidate", () => {
  it("premia color buscado, marca favorita y presupuesto, con motivos veraces", () => {
    const r = scoreCandidate(c({ colorKey: "celeste" }), "celeste", profile);
    expect(r.score).toBe(90);
    expect(r.reason).toContain("color buscado");
    expect(r.reason).toContain("Mango");
    expect(r.reason).toContain("presupuesto");
  });
  it("no afirma nada que no se cumpla", () => {
    const r = scoreCandidate(c({ brand: "Otra", colorKey: "verde", priceCents: 9000 }), "celeste", { ...profile, budgetMaxCents: null });
    expect(r.score).toBe(50);
    expect(r.reason).not.toContain("color buscado");
    expect(r.reason).not.toContain("marca");
  });
});

describe("esquemas de IA", () => {
  it("rechaza categorías fuera de lista y OTHER", () => {
    const base = { label: "Camisa", color: null, reason: "Desbloquea looks", combinesWith: [], searchTerms: [] };
    expect(gapsSchema.safeParse({ gaps: [{ ...base, category: "SHIRT" }] }).success).toBe(true);
    expect(gapsSchema.safeParse({ gaps: [{ ...base, category: "OTHER" }] }).success).toBe(false);
    expect(gapsSchema.safeParse({ gaps: [{ ...base, category: "CAPE" }] }).success).toBe(false);
  });
  it("limita la longitud de las listas del ranking", () => {
    const r = { productId: "p1", score: 80, reason: "Buen precio", combinesWith: [] };
    expect(rankingSchema.safeParse({ gaps: [{ gap: "g1", ranking: [r] }] }).success).toBe(true);
    expect(rankingSchema.safeParse({ gaps: [{ gap: "g1", ranking: [{ ...r, score: 150 }] }] }).success).toBe(false);
  });
});
