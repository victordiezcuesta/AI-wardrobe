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
  it("aplica valores por defecto a las listas", () => {
    const r = profileSchema.parse({});
    expect(r.usualStyles).toEqual([]);
  });
});
