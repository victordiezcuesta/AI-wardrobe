import { describe, expect, it } from "vitest";
import { normalizeEnv, parseEnv } from "@/lib/env";

/** Mínimo de variables obligatorias para que la validación pase. */
const REQUIRED = {
  DATABASE_URL: "postgres://localhost/test",
  AUTH_SECRET: "x".repeat(32),
  CLOUDINARY_CLOUD_NAME: "c",
  CLOUDINARY_API_KEY: "k",
  CLOUDINARY_API_SECRET: "s",
};
const parse = (extra: Record<string, string | undefined> = {}) => parseEnv({ ...REQUIRED, ...extra });

describe("normalizeEnv", () => {
  it("convierte cadenas vacías o solo con espacios en undefined y conserva el resto", () => {
    expect(normalizeEnv({ A: "", B: "   ", C: "valor", D: undefined })).toEqual({ A: undefined, B: undefined, C: "valor", D: undefined });
  });
});

describe("variables numéricas", () => {
  it("vacía → aplica el valor por defecto", () => {
    const e = parse({ AI_DAILY_LIMIT_PER_USER: "", TRYON_DAILY_LIMIT_PER_USER: "", SMTP_PORT: "", POLLINATIONS_MAX_REFERENCES: "", CATALOG_MAX_ROWS_PER_FEED: "" });
    expect(e.AI_DAILY_LIMIT_PER_USER).toBe(60);
    expect(e.TRYON_DAILY_LIMIT_PER_USER).toBe(10);
    expect(e.SMTP_PORT).toBe(587);
    expect(e.POLLINATIONS_MAX_REFERENCES).toBe(5);
    expect(e.CATALOG_MAX_ROWS_PER_FEED).toBe(60000);
  });
  it("no definida → aplica el valor por defecto", () => {
    const e = parse();
    expect(e.AI_DAILY_LIMIT_PER_USER).toBe(60);
    expect(e.TRYON_DAILY_LIMIT_PER_USER).toBe(10);
    expect(e.SMTP_PORT).toBe(587);
  });
  it("con valor válido → lo conserva", () => {
    const e = parse({ AI_DAILY_LIMIT_PER_USER: "25", TRYON_DAILY_LIMIT_PER_USER: "3", SMTP_PORT: "465", POLLINATIONS_MAX_REFERENCES: "8" });
    expect(e.AI_DAILY_LIMIT_PER_USER).toBe(25);
    expect(e.TRYON_DAILY_LIMIT_PER_USER).toBe(3);
    expect(e.SMTP_PORT).toBe(465);
    expect(e.POLLINATIONS_MAX_REFERENCES).toBe(8);
  });
  it("con valor inválido → error de validación que nombra la variable", () => {
    expect(() => parse({ AI_DAILY_LIMIT_PER_USER: "abc" })).toThrow(/AI_DAILY_LIMIT_PER_USER/);
    expect(() => parse({ POLLINATIONS_MAX_REFERENCES: "99" })).toThrow(/POLLINATIONS_MAX_REFERENCES/);
  });
});

describe("variables de texto", () => {
  it("opcional vacía → se trata como ausente", () => {
    const e = parse({ OPENROUTER_API_KEY: "", POLLINATIONS_API_KEY: " ", SMTP_HOST: "", DIRECT_URL: "", CRON_SECRET: "", POLLINATIONS_IMAGE_SIZE: "" });
    expect(e.OPENROUTER_API_KEY).toBeUndefined();
    expect(e.POLLINATIONS_API_KEY).toBeUndefined();
    expect(e.SMTP_HOST).toBeUndefined();
    expect(e.DIRECT_URL).toBeUndefined();
    expect(e.CRON_SECRET).toBeUndefined(); // antes, "" fallaba por min(16)
    expect(e.POLLINATIONS_IMAGE_SIZE).toBeUndefined(); // antes, "" fallaba por la regex
  });
  it("con valor por defecto y vacía → aplica el valor por defecto", () => {
    const e = parse({ POLLINATIONS_MODEL: "", POLLINATIONS_BASE_URL: "", CATALOG_STORES: "", CATALOG_REGION: "", EMAIL_FROM: "", APP_TIMEZONE: "", NEXT_PUBLIC_APP_URL: "" });
    expect(e.POLLINATIONS_MODEL).toBe("google/gemini-2.5-flash-image");
    expect(e.POLLINATIONS_BASE_URL).toBe("https://gen.pollinations.ai");
    expect(e.CATALOG_STORES).toContain("Mango");
    expect(e.CATALOG_REGION).toBe("ES");
    expect(e.EMAIL_FROM).toBe("AI Wardrobe <no-reply@localhost>");
    expect(e.APP_TIMEZONE).toBe("Europe/Madrid");
    expect(e.NEXT_PUBLIC_APP_URL).toBe("http://localhost:3000");
  });
  it("modelos de OpenRouter vacíos → cadena de respaldo (común y luego por defecto)", () => {
    const empty = parse({ OPENROUTER_MODEL: "", OPENROUTER_MODEL_VISION: "", OPENROUTER_MODEL_STYLIST: "", OPENROUTER_MODEL_CHEAP: "" });
    expect(empty.OPENROUTER_MODEL_VISION).toBe("google/gemini-2.5-flash");
    expect(empty.OPENROUTER_MODEL_STYLIST).toBe("google/gemini-2.5-flash");
    expect(empty.OPENROUTER_MODEL_CHEAP).toBe("google/gemini-2.5-flash-lite");
    const common = parse({ OPENROUTER_MODEL: "p/comun", OPENROUTER_MODEL_VISION: "", OPENROUTER_MODEL_CHEAP: "p/barato" });
    expect(common.OPENROUTER_MODEL_VISION).toBe("p/comun");
    expect(common.OPENROUTER_MODEL_CHEAP).toBe("p/barato");
  });
});

describe("variables obligatorias", () => {
  it.each(Object.keys(REQUIRED))("%s vacía → error de validación", (key) => {
    expect(() => parse({ [key]: "" })).toThrow(new RegExp(key));
  });
  it("no definida → error de validación", () => {
    const { DATABASE_URL: _omit, ...rest } = REQUIRED;
    expect(() => parseEnv(rest)).toThrow(/DATABASE_URL/);
  });
  it("AUTH_SECRET demasiado corta → error de validación", () => {
    expect(() => parse({ AUTH_SECRET: "corta" })).toThrow(/AUTH_SECRET/);
  });
});
