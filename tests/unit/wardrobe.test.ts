import { describe, expect, it } from "vitest";
import { sniffImage } from "@/lib/uploads/validate";
import { sanitizeBox } from "@/services/item-analysis.service";
import { analysisSchema, createItemSchema, listQuerySchema } from "@/lib/validations/wardrobe";

describe("sniffImage", () => {
  it("reconoce formatos por firma binaria", () => {
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe("jpeg");
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))).toBe("png");
    expect(sniffImage(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]))).toBe("webp");
  });
  it("rechaza ejecutables o texto disfrazados de imagen", () => {
    expect(sniffImage(Buffer.from("MZ\x90\x00 not an image at all"))).toBeNull();
    expect(sniffImage(Buffer.from("<svg xmlns='x'></svg>  "))).toBeNull();
  });
});

describe("sanitizeBox", () => {
  it("acepta recuadros plausibles", () => {
    expect(sanitizeBox({ x: 0.1, y: 0.1, width: 0.5, height: 0.6 })).not.toBeNull();
  });
  it("descarta recuadros fuera de rango o diminutos", () => {
    expect(sanitizeBox({ x: 0.8, y: 0.1, width: 0.5, height: 0.6 })).toBeNull();
    expect(sanitizeBox({ x: 0.1, y: 0.1, width: 0.01, height: 0.6 })).toBeNull();
    expect(sanitizeBox({ x: -0.2, y: 0, width: 0.5, height: 0.5 })).toBeNull();
    expect(sanitizeBox(null)).toBeNull();
  });
});

describe("esquemas del armario", () => {
  const valid = {
    name: "Camisa azul", category: "SHIRT", subcategory: null, primaryColor: "azul", secondaryColors: [], pattern: null,
    material: null, style: ["casual"], seasons: ["SPRING"], formality: 3, occasions: [], visualTraits: [], description: null,
    confidence: 0.9, uncertainFields: [], box: null,
  };
  it("valida la salida de la IA", () => {
    expect(analysisSchema.safeParse({ items: [valid] }).success).toBe(true);
  });
  it("rechaza categorías o colores inventados por la IA", () => {
    expect(analysisSchema.safeParse({ items: [{ ...valid, category: "SPACESUIT" }] }).success).toBe(false);
    expect(analysisSchema.safeParse({ items: [{ ...valid, primaryColor: "fucsia fosforito" }] }).success).toBe(false);
  });
  it("exige nombre y categoría al crear manualmente", () => {
    expect(createItemSchema.safeParse({ name: "x" }).success).toBe(false);
    expect(createItemSchema.safeParse({ name: "x", category: "TSHIRT" }).success).toBe(true);
  });
  it("valida los filtros de listado", () => {
    expect(listQuerySchema.safeParse({ category: "NOPE" }).success).toBe(false);
    expect(listQuerySchema.safeParse({ category: "JEANS", favorite: "true" }).success).toBe(true);
  });
});
