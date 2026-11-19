import { describe, expect, it } from "vitest";
import { registerSchema, resetSchema } from "@/lib/validations/auth";
import { profileSchema } from "@/lib/validations/profile";

describe("registerSchema", () => {
  it("normaliza el email y acepta una contraseña fuerte", () => {
    const r = registerSchema.parse({ email: "  Ana@Example.COM ", password: "Abcdefghi1" });
    expect(r.email).toBe("ana@example.com");
  });
  it("rechaza contraseñas débiles", () => {
    expect(registerSchema.safeParse({ email: "a@b.co", password: "corta1A" }).success).toBe(false);
    expect(registerSchema.safeParse({ email: "a@b.co", password: "sinmayusculas123" }).success).toBe(false);
  });
});

describe("resetSchema", () => {
  it("exige token y contraseña válida", () => {
    expect(resetSchema.safeParse({ token: "x", password: "Abcdefghi1" }).success).toBe(false);
  });
});

describe("profileSchema", () => {
  it("rechaza presupuesto mínimo mayor que el máximo", () => {
    const r = profileSchema.safeParse({ budgetMin: 100, budgetMax: 50 });
    expect(r.success).toBe(false);
  });
  it("no inventa valores para las listas omitidas (actualización parcial) y conserva [] explícito", () => {
    const omitted = profileSchema.parse({});
    for (const k of ["usualStyles", "exploreStyles", "favoriteColors", "avoidedColors", "favoriteBrands", "favoriteGarments"] as const) {
      expect(omitted[k], k).toBeUndefined();
      expect(k in omitted, k).toBe(false); // ni siquiera aparece la clave: Prisma no la toca
    }
    expect(profileSchema.parse({ usualStyles: [] }).usualStyles).toEqual([]);
    expect(profileSchema.parse({ usualStyles: [" casual "] }).usualStyles).toEqual(["casual"]);
  });
  it("rechaza listas inválidas", () => {
    expect(profileSchema.safeParse({ usualStyles: [""] }).success).toBe(false);
    expect(profileSchema.safeParse({ usualStyles: Array(13).fill("x") }).success).toBe(false);
    expect(profileSchema.safeParse({ favoriteColors: null }).success).toBe(false);
    expect(profileSchema.safeParse({ favoriteColors: "rojo" }).success).toBe(false);
  });
});
