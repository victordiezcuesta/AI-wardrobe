import { describe, expect, it } from "vitest";
import { changePasswordSchema, forgotSchema, loginSchema, registerSchema, resetSchema, verifySchema } from "@/lib/validations/auth";
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
  it("el login conserva su límite de 128 caracteres y no aplica el de 72 bytes", () => {
    expect(loginSchema.safeParse({ email: "a@b.co", password: `Aa1${"x".repeat(125)}` }).success).toBe(true);
    expect(loginSchema.safeParse({ email: "a@b.co", password: "😀".repeat(100) }).success).toBe(true); // 400 bytes
    expect(loginSchema.safeParse({ email: "a@b.co", password: "x".repeat(128) }).success).toBe(true);
    expect(loginSchema.safeParse({ email: "a@b.co", password: "x".repeat(129) }).success).toBe(false);
  });
});

/** Fase 19.17c — bcrypt solo usa los primeros 72 BYTES UTF-8: registro y restablecimiento rechazan lo que los supere. */
describe("passwordSchema: máximo 72 bytes UTF-8", () => {
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  const SCHEMAS = [
    ["registerSchema", (password: string) => registerSchema.safeParse({ email: "a@b.co", password })],
    ["resetSchema", (password: string) => resetSchema.safeParse({ token: "t".repeat(40), password })],
  ] as const;
  const CASES: [string, string, boolean][] = [
    ["ASCII 72 bytes", `Aa1${"x".repeat(69)}`, true],
    ["ASCII 73 bytes", `Aa1${"x".repeat(70)}`, false],
    ["ñ ×34 + Aa1x = 72 bytes", `${"ñ".repeat(34)}Aa1x`, true],
    ["ñ ×34 + Aa1xy = 73 bytes", `${"ñ".repeat(34)}Aa1xy`, false],
    ["😀 ×17 + Aa1x = 72 bytes", `${"😀".repeat(17)}Aa1x`, true],
    ["😀 ×18 + Aa1 = 75 bytes", `${"😀".repeat(18)}Aa1`, false],
  ];
  it("los ejemplos tienen los bytes esperados (y length no sirve para medirlos)", () => {
    expect(CASES.map(([, p]) => bytes(p))).toEqual([72, 73, 72, 73, 72, 75]);
    expect(`${"ñ".repeat(34)}Aa1x`.length).toBe(38);
  });
  describe.each(SCHEMAS)("%s", (_n, parse) => {
    it.each(CASES)("%s", (_label, password, ok) => {
      const r = parse(password);
      expect(r.success).toBe(ok);
      if (!ok) expect(JSON.stringify(r.error?.issues)).toContain("72 bytes UTF-8");
    });
    it("conserva el resto de reglas (mínimo, composición y 128 caracteres)", () => {
      for (const p of ["Aa1xxxxxx", "abcdefghij1", "ABCDEFGHIJ1", "Abcdefghij", `Aa1${"x".repeat(125)}`]) expect(parse(p).success, p).toBe(false);
    });
  });
});

/** Fase 20.3b — cambio de contraseña: la actual solo hasta 128 caracteres (sin el tope de 72 bytes); la nueva, passwordSchema. */
describe("changePasswordSchema", () => {
  const ok = (currentPassword: unknown, newPassword: unknown) => changePasswordSchema.safeParse({ currentPassword, newPassword });
  it("acepta una actual antigua de más de 72 bytes (hasta 128 caracteres) y una nueva válida", () => {
    expect(ok("x".repeat(128), "Nueva-clave-1").success).toBe(true);
    expect(ok("😀".repeat(100), "Nueva-clave-1").success).toBe(true); // 400 bytes, 100 puntos de código
    expect(ok("a", "Nueva-clave-1").success).toBe(true);
  });
  it("rechaza la actual vacía, de más de 128 caracteres o que no sea texto", () => {
    expect(ok("", "Nueva-clave-1").success).toBe(false);
    expect(ok("x".repeat(129), "Nueva-clave-1").success).toBe(false);
    expect(ok(123, "Nueva-clave-1").success).toBe(false);
    expect(changePasswordSchema.safeParse({ newPassword: "Nueva-clave-1" }).success).toBe(false);
  });
  it("la nueva usa passwordSchema completo: mínimo, composición, 128 caracteres y 72 bytes UTF-8", () => {
    for (const p of ["Corta1a", "sinmayuscula1", "SINMINUSCULA1", "SinNumeroAqui", `Aa1${"x".repeat(126)}`, `Aa1${"x".repeat(70)}`, `${"ñ".repeat(34)}Aa1xy`, `${"😀".repeat(18)}Aa1`]) {
      expect(ok("actual", p).success, p).toBe(false);
    }
    for (const p of [`Aa1${"x".repeat(69)}`, `${"ñ".repeat(34)}Aa1x`, `${"😀".repeat(17)}Aa1x`]) expect(ok("actual", p).success, p).toBe(true);
    expect(JSON.stringify(ok("actual", `Aa1${"x".repeat(70)}`).error?.issues)).toContain("72 bytes UTF-8");
  });
  it("no exige que la nueva difiera de la actual: eso lo comprueba el servicio tras verificar la actual", () => {
    expect(ok("Misma-clave-1", "Misma-clave-1").success).toBe(true);
  });
});

/** Fase 20.3c (correcciones): el máximo de 128 caracteres de passwordSchema tiene mensaje propio en español. */
describe("passwordSchema: mensaje del máximo de 128 caracteres", () => {
  const MSG = "La contraseña no puede superar los 128 caracteres";
  const long = `Aa1${"x".repeat(126)}`; // 129 caracteres (y por tanto > 72 bytes)
  const messages = (r: { success: boolean; error?: { issues: { message: string }[] } }) => r.error?.issues.map((i) => i.message) ?? [];

  it("más de 128 caracteres → mensaje en español, el primero de la lista, sin texto en inglés de Zod", () => {
    for (const r of [registerSchema.safeParse({ email: "a@b.co", password: long }), resetSchema.safeParse({ token: "t".repeat(40), password: long }), changePasswordSchema.safeParse({ currentPassword: "x", newPassword: long })]) {
      expect(r.success).toBe(false);
      const m = messages(r);
      expect(m[0]).toBe(MSG);
      expect(m.join(" ")).not.toMatch(/Too big|expected string/);
    }
  });

  it("el límite no cambia: 128 caracteres no dispara el mensaje de 128 (solo el de 72 bytes) y 129 sí; los 72 bytes siguen aplicándose", () => {
    const at128 = registerSchema.safeParse({ email: "a@b.co", password: `Aa1${"x".repeat(125)}` }); // 128 caracteres, 128 bytes
    expect(messages(at128)).toEqual([expect.stringContaining("72 bytes UTF-8")]); // el de 128 caracteres NO aparece
    expect(messages(registerSchema.safeParse({ email: "a@b.co", password: long })).some((m) => m.includes("72 bytes UTF-8"))).toBe(true); // 129 caracteres: fallan ambos límites
    expect(registerSchema.safeParse({ email: "a@b.co", password: `Aa1${"x".repeat(69)}` }).success).toBe(true);   // 72 bytes
    expect(registerSchema.safeParse({ email: "a@b.co", password: `Aa1${"x".repeat(70)}` }).success).toBe(false);  // 73 bytes
  });

  it("el login y la contraseña actual no cambian: 128 caracteres válidos, 129 inválidos (con el mensaje por defecto)", () => {
    expect(loginSchema.safeParse({ email: "a@b.co", password: "x".repeat(128) }).success).toBe(true);
    const r = loginSchema.safeParse({ email: "a@b.co", password: "x".repeat(129) });
    expect(r.success).toBe(false);
    expect(messages(r).join(" ")).not.toContain(MSG);
    expect(changePasswordSchema.safeParse({ currentPassword: "x".repeat(129), newPassword: "Nueva-clave-1" }).success).toBe(false);
    expect(changePasswordSchema.safeParse({ currentPassword: "x".repeat(128), newPassword: "Nueva-clave-1" }).success).toBe(true);
  });
});
