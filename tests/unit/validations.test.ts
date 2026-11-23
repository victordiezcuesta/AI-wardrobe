import { describe, expect, it } from "vitest";
import { forgotSchema, loginSchema, registerSchema, resetSchema, verifySchema } from "@/lib/validations/auth";
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

/** Fase 19.17b — emails de hasta 254 caracteres (medidos tras trim + minúsculas) y tokens de 20 a 64. */
const emailOfLength = (n: number) => `${"a".repeat(n - "@example.com".length)}@example.com`;
const EMAIL_SCHEMAS = [
  ["registerSchema", (email: string) => registerSchema.safeParse({ email, password: "Abcdefghi1" })],
  ["loginSchema", (email: string) => loginSchema.safeParse({ email, password: "cualquiera" })],
  ["forgotSchema", (email: string) => forgotSchema.safeParse({ email })],
] as const;

describe.each(EMAIL_SCHEMAS)("%s: longitud del email", (_name, parse) => {
  it("254 caracteres es válido y 255 inválido", () => {
    expect(parse(emailOfLength(254)).success).toBe(true);
    const r = parse(emailOfLength(255));
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("254");
  });
  it("la longitud se mide tras normalizar: espacios exteriores y mayúsculas no cuentan", () => {
    expect(parse(`  ${emailOfLength(254).toUpperCase()}  `).success).toBe(true);
    expect(parse(`  ${emailOfLength(255).toUpperCase()}  `).success).toBe(false);
  });
  it("el valor devuelto está normalizado (recortado y en minúsculas)", () => {
    const r = parse("  ANA@Example.COM ");
    expect(r.success && (r.data as { email: string }).email).toBe("ana@example.com");
  });
  it("partes excesivas: local de 5000, etiqueta de dominio de 100000 y 3000 en total", () => {
    for (const email of [`${"a".repeat(5000)}@example.com`, `a@${"b".repeat(100_000)}.com`, emailOfLength(3000)]) expect(parse(email).success).toBe(false);
  });
  it("sigue exigiendo un email con formato válido", () => {
    for (const email of ["", "sin-arroba", "a@", "@b.co", "a b@c.co"]) expect(parse(email).success, email).toBe(false);
  });
});

describe("tokens de verificación y restablecimiento (20–64 caracteres)", () => {
  const PASS = "Abcdefghi1";
  const CASES = [
    ["verifySchema", (token: string) => verifySchema.safeParse({ token })],
    ["resetSchema", (token: string) => resetSchema.safeParse({ token, password: PASS })],
  ] as const;
  it.each(CASES)("%s: 19 inválido, 20 y 64 válidos, 65 inválido", (_n, parse) => {
    expect(parse("t".repeat(19)).success).toBe(false);
    expect(parse("t".repeat(20)).success).toBe(true);
    expect(parse("t".repeat(64)).success).toBe(true);
    expect(parse("t".repeat(65)).success).toBe(false);
    expect(parse("t".repeat(100_000)).success).toBe(false);
  });
  it("acepta un token real (randomBytes(32).toString('hex'): 64 hexadecimales)", async () => {
    const { randomBytes } = await import("node:crypto");
    const token = randomBytes(32).toString("hex");
    expect(token).toHaveLength(64);
    for (const [, parse] of CASES) expect(parse(token).success).toBe(true);
  });
  it("las contraseñas no cambian en esta fase: 128 caracteres siguen siendo válidos", () => {
    expect(resetSchema.safeParse({ token: "t".repeat(40), password: `Aa1${"x".repeat(125)}` }).success).toBe(true);
    expect(loginSchema.safeParse({ email: "a@b.co", password: "x".repeat(128) }).success).toBe(true);
    expect(loginSchema.safeParse({ email: "a@b.co", password: "x".repeat(129) }).success).toBe(false);
  });
});
