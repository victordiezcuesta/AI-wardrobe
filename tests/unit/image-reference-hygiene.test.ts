import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createItemSchema, updateItemSchema } from "@/lib/validations/wardrobe";

/**
 * Higiene de referencias de imagen (fase 19.1). El detector de huérfanas se apoya en un invariante: ningún cliente puede
 * asociar un public_id o una URL de imagen EXISTENTES a una fila; las referencias solo las crean los servicios internos
 * con el resultado de su propia subida. Si un cambio futuro rompe esto, estas pruebas fallan antes de que la limpieza
 * pueda borrar algo que vuelva a estar en uso.
 */
const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    if (p.startsWith(path.join(SRC, "generated"))) return [];
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}
const sources = files(SRC).map((f) => ({ file: path.relative(ROOT, f), text: readFileSync(f, "utf8") }));
const where = (re: RegExp) => sources.filter((s) => re.test(s.text)).map((s) => s.file).sort();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const IMAGE_FIELDS = ["imagePublicId", "imageUrl", "thumbUrl"] as const;

describe("esquemas de prendas: el cliente no puede fijar la imagen", () => {
  const injected = { imagePublicId: "ai-wardrobe/otro/wardrobe/x", imageUrl: "https://res.cloudinary.com/demo/image/upload/v1/ai-wardrobe/otro/wardrobe/x", thumbUrl: "https://res.cloudinary.com/demo/image/upload/v1/x", userId: "otro" };

  it("ningún campo de imagen forma parte de los esquemas", () => {
    for (const f of IMAGE_FIELDS) {
      expect(Object.keys(createItemSchema.shape)).not.toContain(f);
      expect(Object.keys((updateItemSchema as unknown as { shape: object }).shape ?? {})).not.toContain(f);
    }
  });

  it("alta: los campos de imagen (y userId) se descartan", () => {
    const out = createItemSchema.parse({ name: "Camisa", category: "SHIRT", ...injected });
    for (const f of [...IMAGE_FIELDS, "userId"]) expect(out).not.toHaveProperty(f);
  });

  it("edición: se descartan; si solo venían campos de imagen, se rechaza como «Sin cambios»", () => {
    const out = updateItemSchema.parse({ name: "Otra", ...injected });
    for (const f of [...IMAGE_FIELDS, "userId"]) expect(out).not.toHaveProperty(f);
    expect(() => updateItemSchema.parse(injected)).toThrow();
  });
});

describe("quién puede escribir referencias de imagen", () => {
  it("las escrituras Prisma en WardrobeItem solo están en su repositorio; no hay SQL en bruto que inserte o actualice prendas", () => {
    expect(where(/prisma\.wardrobeItem\.(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert)\b/)).toEqual(["src/repositories/wardrobe.repository.ts"]);
    expect(where(/(INSERT\s+INTO|UPDATE)\s+"WardrobeItem"/i)).toEqual([]);
  });

  it("el repositorio de prendas solo lo usa el servicio de prendas para crear o actualizar", () => {
    expect(where(/wardrobeRepository\.(create|update)\(/)).toEqual(["src/services/wardrobe.service.ts"]);
  });

  it("en el servicio, los campos de imagen solo se asignan desde el resultado de una subida propia", () => {
    const text = read("src/services/wardrobe.service.ts");
    const assigned = [...text.matchAll(/\b(imagePublicId|imageUrl|thumbUrl):\s*([\w.]+)/g)].map((m) => `${m[1]}=${m[2]}`);
    expect(assigned.length).toBeGreaterThan(0);
    for (const a of assigned) expect(a).toMatch(/^(imagePublicId=(img|source)\.publicId|imageUrl=(img|source)\.url|thumbUrl=(img|source)\.thumbUrl)$/);
  });

  it("las rutas de alta y edición pasan al servicio SOLO lo validado por su esquema", () => {
    expect(where(/wardrobeService\.(create|update)\(/)).toEqual(["src/app/api/wardrobe/[id]/route.ts", "src/app/api/wardrobe/route.ts"]);
    const create = read("src/app/api/wardrobe/route.ts");
    expect(create).toMatch(/const input = createItemSchema\.parse\(await req\.json\(\)\);/);
    expect(create).toMatch(/wardrobeService\.create\(userId, input\)/);
    const update = read("src/app/api/wardrobe/[id]/route.ts");
    expect(update).toMatch(/const input = updateItemSchema\.parse\(await req\.json\(\)\);/);
    expect(update).toMatch(/wardrobeService\.update\(userId, \(await params\)\.id, input\)/);
  });

  it("GeneratedImage: publicId solo se guarda desde la subida del propio trabajo; imageUrl no se escribe nunca", () => {
    const assigned = sources.flatMap((s) => [...s.text.matchAll(/data:\s*\{[^}]*\bpublicId:\s*([\w.]+)/g)].map((m) => `${s.file}:${m[1]}`));
    expect(assigned).toEqual(["src/services/tryon.service.ts:stored.publicId"]);
    const writers = sources.filter((s) => /prisma\.generatedImage\.(create|createMany|update|updateMany|upsert)\b/.test(s.text));
    expect(writers.map((s) => s.file)).toEqual(["src/services/tryon.service.ts"]);
    expect(writers[0]!.text).not.toMatch(/data:\s*\{[^}]*\bimageUrl:/);
  });

  it("fotos personales: solo se añaden con array_append del resultado de la subida; nunca con set/push de Prisma", () => {
    const appends = sources.flatMap((s) => [...s.text.matchAll(/array_append\("photoPublicIds",\s*\$\{([^}]+)\}\)/g)].map((m) => `${s.file}:${m[1]}`));
    expect(appends).toEqual(["src/services/photo.service.ts:stored.publicId"]);
    expect(where(/photoPublicIds:\s*\{\s*(set|push)\b/)).toEqual([]);
    expect(where(/data:\s*\{[^}]*photoPublicIds/)).toEqual([]);
  });

  it("try-on: la foto que elige el cliente es solo una cita y se exige que sea suya antes de guardarla", () => {
    const text = read("src/services/tryon.service.ts");
    const owns = text.indexOf("photoService.owns(userId, input.photoPublicId)");
    const create = text.indexOf("sourcePhotoId: input.photoPublicId");
    expect(owns).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(owns);
  });
});
