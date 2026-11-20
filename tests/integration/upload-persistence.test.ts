import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { startTestDb, type TestDb } from "../helpers/db";
import { prismaProxy, setTestEnv } from "../helpers/mock-prisma";

/**
 * Persistencia incierta al guardar imágenes recién subidas (fotos personales y prendas), con PostgreSQL real (PGlite)
 * y Cloudinary simulado. Principio: una imagen solo se borra si se confirma que ninguna fila la referencia; si la
 * escritura se confirmó (se perdió la respuesta) se da por guardada; si no se puede verificar, se conserva.
 * Los errores simulados son clases REALES de Prisma cuyo mensaje repite el publicId y el userId (no deben llegar al log).
 */
const holder = vi.hoisted(() => ({ prisma: null as PrismaClient | null }));
const cloud = vi.hoisted(() => ({
  stored: new Set<string>(), deleted: [] as string[], failDelete: false, failCrop: false,
  /** publicId que devolverá la próxima subida (para preparar referencias de antemano). */
  nextIds: [] as string[], uploads: 0,
  /** Se ejecuta antes de completar cada borrado (para observar el orden o intercalar otra operación). */
  beforeDelete: null as ((ids: string[]) => Promise<void>) | null,
}));
const analysis = vi.hoisted(() => ({ analyze: vi.fn() }));

vi.mock("@/lib/prisma", () => ({ prisma: prismaProxy(holder) }));
vi.mock("@/services/item-analysis.service", () => ({
  itemAnalysisService: { analyze: analysis.analyze },
  sanitizeBox: (b: unknown) => b ?? null,
}));
vi.mock("@/lib/cloudinary", () => {
  const nextId = (folder: string) => cloud.nextIds.shift() ?? `${folder}/img-${++cloud.uploads}`;
  const stored = (folder: string) => {
    const publicId = nextId(folder);
    cloud.stored.add(publicId);
    return { publicId, url: `https://res.cloudinary.com/demo/${publicId}.jpg`, thumbUrl: `https://res.cloudinary.com/demo/t/${publicId}.jpg`, width: 100, height: 100 };
  };
  const remove = async (ids: string[]) => {
    if (cloud.failDelete) throw Object.assign(new Error("No se ha podido borrar la imagen. Inténtalo de nuevo en unos minutos."), { status: 502, code: "IMAGE_DELETE_FAILED" });
    await cloud.beforeDelete?.(ids);
    for (const id of ids) { cloud.deleted.push(id); cloud.stored.delete(id); }
  };
  return {
    uploadBuffer: async (_b: Buffer, folder: string) => stored(folder),
    uploadCrop: async (_src: string, _box: unknown, folder: string) => { if (cloud.failCrop) throw new Error("crop falló"); return stored(folder); },
    uploadPrivate: async (_b: Buffer, folder: string) => { const s = stored(folder); return { publicId: s.publicId, width: 1, height: 1 }; },
    signedUrl: (id: string) => `https://api.cloudinary.com/signed/${id}`,
    deleteImage: async (id: string | null | undefined) => { if (id) await remove([id]); },
    deletePrivateImages: remove,
    deleteImages: remove,
  };
});

let t: TestDb;
beforeAll(async () => { setTestEnv(); t = await startTestDb(); holder.prisma = t.prisma; }, 60_000);
afterAll(async () => { await t?.stop(); });
let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  holder.prisma = t.prisma;
  cloud.stored.clear(); cloud.deleted = []; cloud.failDelete = false; cloud.failCrop = false; cloud.nextIds = []; cloud.beforeDelete = null;
  analysis.analyze.mockReset();
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { holder.prisma = t.prisma; errSpy.mockRestore(); });
const logged = () => errSpy.mock.calls.flat().map(String).join("\n");

type Impl = (orig: (...a: unknown[]) => Promise<unknown>, args: unknown[]) => Promise<unknown>;
/** Sustituye operaciones del cliente (`$executeRaw`…) o de un modelo (`wardrobeItem.create`…) hasta el final de la prueba. */
function override(impls: { root?: Record<string, Impl>; models?: Record<string, Record<string, Impl>> }) {
  const real = t.prisma;
  const wrap = (obj: object, table: Record<string, Impl> | undefined) => new Proxy(obj, {
    get(o, k) {
      const v = Reflect.get(o, k, o) as unknown;
      if (typeof v !== "function") return v;
      const bound = (v as (...a: unknown[]) => Promise<unknown>).bind(o);
      const impl = typeof k === "string" ? table?.[k] : undefined;
      return impl ? (...args: unknown[]) => impl(bound, args) : bound;
    },
  });
  holder.prisma = new Proxy(real, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (typeof prop === "string" && impls.models?.[prop]) return wrap(v as object, impls.models[prop]);
      if (typeof v !== "function") return v;
      const bound = (v as (...a: unknown[]) => unknown).bind(target);
      const impl = typeof prop === "string" ? impls.root?.[prop] : undefined;
      return impl ? (...args: unknown[]) => impl(bound as (...a: unknown[]) => Promise<unknown>, args) : bound;
    },
  }) as PrismaClient;
}
/** Error de Prisma real cuyo mensaje repite los argumentos (como hace Prisma en algunos casos). */
const prismaError = (detail: string, code = "P1017") => new Prisma.PrismaClientKnownRequestError(`Invalid invocation: ${detail} Server has closed the connection.`, { code, clientVersion: "test" });
const verifyError = (detail: string) => new Prisma.PrismaClientValidationError(`Invalid \`count()\` invocation: ${detail}`, { clientVersion: "test" });
const failsWith = (p: Promise<unknown>) => p.then(() => { throw new Error("no falló"); }, (e: unknown) => e as Error);

const services = async () => ({
  photos: (await import("@/services/photo.service")).photoService,
  wardrobe: (await import("@/services/wardrobe.service")).wardrobeService,
});
async function userWithConsent(photoPublicIds: string[] = []) {
  return t.prisma.user.create({ data: { email: `p${Math.random().toString(36).slice(2)}@q.com`, profile: { create: { aiPhotoConsent: true, consentAt: new Date(), photoPublicIds } } } });
}
const profilePhotos = async (userId: string) => (await t.prisma.userProfile.findUniqueOrThrow({ where: { userId } })).photoPublicIds;
const IMG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);

describe("fotos personales (photoService.add)", () => {
  it("escritura confirmada y respuesta perdida → se detecta la referencia: se devuelve como guardada y NO se borra", async () => {
    const u = await userWithConsent();
    const { photos } = await services();
    override({ root: { $executeRaw: async (orig, args) => { await orig(...args); throw prismaError(`photoPublicIds += "${String(args[1])}" userId "${u.id}"`); } } });
    const out = await photos.add(u.id, IMG);
    holder.prisma = t.prisma;
    expect(await profilePhotos(u.id)).toEqual([out.publicId]);
    expect(cloud.stored.has(out.publicId)).toBe(true);
    expect(cloud.deleted).toEqual([]);
  });

  it("escritura fallida sin referencia → la foto se borra; el error que sale está saneado y el perfil no cambia", async () => {
    const u = await userWithConsent();
    const { photos } = await services();
    let leaked = "";
    override({ root: { $executeRaw: async (_orig, args) => { leaked = String(args[1]); throw prismaError(`photoPublicIds += "${leaked}" userId "${u.id}"`); } } });
    const err = await failsWith(photos.add(u.id, IMG));
    holder.prisma = t.prisma;
    expect(err.message).toBe("Fallo de base de datos (P1017)");
    expect(cloud.deleted).toEqual([leaked]);
    expect(await profilePhotos(u.id)).toEqual([]);
    expect(logged()).not.toContain(leaked);
  });

  it("error de consulta durante la verificación → la foto se conserva; se registra sin publicId ni userId", async () => {
    const u = await userWithConsent();
    const { photos } = await services();
    let leaked = "";
    override({
      root: { $executeRaw: async (_orig, args) => { leaked = String(args[1]); throw prismaError(`"${leaked}"`); } },
      models: { userProfile: { count: async (_o, args) => { throw verifyError(JSON.stringify(args[0])); } } },
    });
    const err = await failsWith(photos.add(u.id, IMG));
    holder.prisma = t.prisma;
    expect(cloud.deleted).toEqual([]);
    expect(cloud.stored.has(leaked)).toBe(true);
    expect(await profilePhotos(u.id)).toEqual([]);
    expect(logged()).toContain("photos.orphan_unverified");
    expect(logged()).not.toContain(leaked);
    expect(logged()).not.toContain(u.id);
    expect(err.message).not.toContain(leaked);
  });

  it("Cloudinary falla durante la limpieza → queda registrado; sale el error de base de datos (saneado) y el perfil no cambia", async () => {
    const u = await userWithConsent();
    const { photos } = await services();
    override({ root: { $executeRaw: async () => { throw prismaError("x"); } } });
    cloud.failDelete = true;
    const err = await failsWith(photos.add(u.id, IMG));
    holder.prisma = t.prisma;
    expect(err.message).toBe("Fallo de base de datos (P1017)");
    expect(logged()).toContain("photos.orphan");
    expect(cloud.stored.size).toBe(1); // no se pudo borrar: registrado
    expect(await profilePhotos(u.id)).toEqual([]);
  });

  it.each([
    ["el perfil de OTRO usuario", "profile"],
    ["una generación del probador (sourcePhotoId)", "generation"],
  ])("la misma foto referenciada por %s → no se borra ni se toca esa fila; no se da por guardada para este usuario", async (_n, where) => {
    const shared = `ai-wardrobe/compartida/personal/p-${Math.random().toString(36).slice(2)}`;
    const other = await userWithConsent(where === "profile" ? [shared] : []);
    if (where === "generation") await t.prisma.generatedImage.create({ data: { userId: other.id, scenario: "studio", pose: "standing", sourcePhotoId: shared } });
    const u = await userWithConsent();
    const { photos } = await services();
    cloud.nextIds = [shared];
    override({ root: { $executeRaw: async () => { throw prismaError("x"); } } });
    await expect(photos.add(u.id, IMG)).rejects.toThrow("Fallo de base de datos");
    holder.prisma = t.prisma;
    expect(cloud.deleted).toEqual([]);
    expect(await profilePhotos(u.id)).toEqual([]); // aislamiento: no aparece en el perfil de este usuario
    if (where === "profile") expect(await profilePhotos(other.id)).toEqual([shared]);
    else expect(await t.prisma.generatedImage.count({ where: { sourcePhotoId: shared } })).toBe(1);
  });

  it("límite alcanzado (la sentencia se ejecutó y no añadió nada) → la foto se borra como antes", async () => {
    const max = (await import("@/features/virtual-try-on/constants")).MAX_PERSONAL_PHOTOS;
    const u = await userWithConsent(Array.from({ length: max }, (_, i) => `ai-wardrobe/x/personal/${i}`));
    const { photos } = await services();
    // El primer control (lectura) se salta para llegar al UPDATE con el límite ya alcanzado.
    override({ models: { userProfile: { findUnique: async (orig, args) => { const r = (await orig(...args)) as { photoPublicIds?: string[] } | null; return r && { ...r, photoPublicIds: [] }; } } } });
    await expect(photos.add(u.id, IMG)).rejects.toMatchObject({ code: "PHOTO_LIMIT" });
    holder.prisma = t.prisma;
    expect(await profilePhotos(u.id)).toHaveLength(max); // el UPDATE no añadió nada
    expect(cloud.deleted).toHaveLength(1);
    expect(cloud.stored.size).toBe(0);
  });
});

/**
 * Borrado de fotos personales: primero Cloudinary y, solo si va bien, la referencia (con array_remove atómico). Si
 * Cloudinary falla, la referencia se conserva para poder reintentar; nunca queda una foto privada sin referencia.
 */
describe("fotos personales (photoService.remove)", () => {
  /** Usuario con fotos ya subidas (presentes en el perfil y en el Cloudinary simulado). */
  async function userWithPhotos(...names: string[]) {
    const ids = names.map((n) => `ai-wardrobe/rm-${Math.random().toString(36).slice(2)}/personal/${n}`);
    for (const id of ids) cloud.stored.add(id);
    return { user: await userWithConsent(ids), ids };
  }

  it("eliminación normal: primero se borra en Cloudinary (con la referencia aún guardada) y después la referencia; las demás fotos se conservan", async () => {
    const { user, ids: [a, b] } = await userWithPhotos("a", "b");
    const { photos } = await services();
    const refsWhileDeleting: string[][] = [];
    cloud.beforeDelete = async () => { refsWhileDeleting.push(await profilePhotos(user.id)); };
    await photos.remove(user.id, a!);
    expect(refsWhileDeleting).toEqual([[a, b]]); // orden: Cloudinary antes que la base de datos
    expect(cloud.deleted).toEqual([a]);
    expect(cloud.stored.has(a!)).toBe(false);
    expect(await profilePhotos(user.id)).toEqual([b]);
  });

  it("fallo de Cloudinary → IMAGE_DELETE_FAILED; la referencia permanece; un segundo intento completa el borrado", async () => {
    const { user, ids: [a] } = await userWithPhotos("a");
    const { photos } = await services();
    cloud.failDelete = true;
    await expect(photos.remove(user.id, a!)).rejects.toMatchObject({ status: 502, code: "IMAGE_DELETE_FAILED" });
    expect(await profilePhotos(user.id)).toEqual([a]); // la referencia sigue: el usuario la ve y puede reintentar
    expect(cloud.stored.has(a!)).toBe(true);
    cloud.failDelete = false;
    await photos.remove(user.id, a!);
    expect(await profilePhotos(user.id)).toEqual([]);
    expect(cloud.stored.has(a!)).toBe(false);
  });

  it("foto ajena → 404 sin llamar a Cloudinary; la foto y la referencia del dueño quedan intactas", async () => {
    const { user: owner, ids: [a] } = await userWithPhotos("a");
    const { user: other } = await userWithPhotos();
    const { photos } = await services();
    let cloudCalls = 0;
    cloud.beforeDelete = async () => { cloudCalls++; };
    await expect(photos.remove(other.id, a!)).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(cloudCalls).toBe(0);
    expect(cloud.deleted).toEqual([]);
    expect(cloud.stored.has(a!)).toBe(true);
    expect(await profilePhotos(owner.id)).toEqual([a]);
  });

  it("una subida que se completa MIENTRAS se borra otra foto (entre la comprobación y el array_remove) no desaparece", async () => {
    const { user, ids: [a] } = await userWithPhotos("a");
    const { photos } = await services();
    let added = "";
    // La subida concurrente se completa entera justo cuando el borrado ya ha leído la lista y está en Cloudinary.
    cloud.beforeDelete = async () => { cloud.beforeDelete = null; added = (await photos.add(user.id, IMG)).publicId; };
    await photos.remove(user.id, a!);
    expect(added).toBeTruthy();
    expect(await profilePhotos(user.id)).toEqual([added]); // se quitó solo la borrada; la nueva sigue
    expect(cloud.stored.has(added)).toBe(true);
    expect(cloud.stored.has(a!)).toBe(false);
  });

  it("subidas y borrados lanzados a la vez → la lista final es exactamente la esperada (ninguna operación pisa a otra)", async () => {
    const { user, ids } = await userWithPhotos("a", "b", "c");
    const { photos } = await services();
    const results = await Promise.all([
      photos.remove(user.id, ids[0]!), photos.add(user.id, IMG), photos.remove(user.id, ids[2]!), photos.add(user.id, IMG),
    ]);
    const addedIds = [results[1], results[3]].map((r) => (r as { publicId: string }).publicId);
    expect(new Set(await profilePhotos(user.id))).toEqual(new Set([ids[1], ...addedIds]));
    expect(cloud.deleted.sort()).toEqual([ids[0], ids[2]].sort());
  });
});

const detected = (box: { x: number; y: number; width: number; height: number } | null = null, name = "Camiseta") => ({
  name, category: "TSHIRT" as const, subcategory: null, primaryColor: null, secondaryColors: [], pattern: null, material: null,
  style: [], seasons: [], formality: null, occasions: [], visualTraits: [], description: null, confidence: 0.9, uncertainFields: [], box,
});
const BOX = { x: 0.1, y: 0.1, width: 0.4, height: 0.4 };
const userItems = (userId: string) => t.prisma.wardrobeItem.findMany({ where: { userId } });
const isSave = (args: unknown[]) => typeof (args[0] as { data?: { imagePublicId?: unknown } }).data?.imagePublicId === "string";

describe("prendas (wardrobeService.createFromUpload)", () => {
  it("escritura confirmada y respuesta perdida (prenda sin analizar) → se devuelve la prenda guardada y la foto NO se borra", async () => {
    const u = await userWithConsent();
    const { wardrobe } = await services();
    analysis.analyze.mockRejectedValue(new Error("IA no disponible"));
    override({ models: { wardrobeItem: { create: async (orig, args) => { await orig(...args); throw prismaError(JSON.stringify(args[0])); } } } });
    const out = await wardrobe.createFromUpload(u.id, IMG, "single");
    holder.prisma = t.prisma;
    expect(out.status).toBe("analysis_failed");
    const items = await userItems(u.id);
    expect(items.map((i) => i.id)).toEqual(out.items.map((i) => i.id));
    expect(cloud.stored.has(items[0]!.imagePublicId!)).toBe(true);
    expect(cloud.deleted).toEqual([]);
  });

  it("escritura confirmada y respuesta perdida (prenda con recorte) → se conserva el recorte; la foto original sin uso se borra", async () => {
    const u = await userWithConsent();
    const { wardrobe } = await services();
    analysis.analyze.mockResolvedValue([detected(BOX)]);
    override({ models: { wardrobeItem: { create: async (orig, args) => { await orig(...args); throw prismaError(JSON.stringify(args[0])); } } } });
    const out = await wardrobe.createFromUpload(u.id, IMG, "multi");
    holder.prisma = t.prisma;
    expect(out.status).toBe("ok");
    const [item] = await userItems(u.id);
    expect(out.items.map((i) => i.id)).toEqual([item!.id]);
    expect(cloud.stored.has(item!.imagePublicId!)).toBe(true); // recorte referenciado: conservado
    expect(cloud.deleted).toHaveLength(1); // solo la original, que ninguna prenda usa
    expect(cloud.deleted[0]).not.toBe(item!.imagePublicId);
  });

  it("escritura fallida sin referencia → la foto se borra; error saneado; sin prendas", async () => {
    const u = await userWithConsent();
    const { wardrobe } = await services();
    analysis.analyze.mockRejectedValue(new Error("IA no disponible"));
    let leaked = "";
    override({ models: { wardrobeItem: { create: async (_o, args) => { leaked = (args[0] as { data: { imagePublicId: string } }).data.imagePublicId; throw prismaError(`"${leaked}" "${u.id}"`); } } } });
    const err = await failsWith(wardrobe.createFromUpload(u.id, IMG, "single"));
    holder.prisma = t.prisma;
    expect(err.message).toBe("Fallo de base de datos (P1017)");
    expect(cloud.deleted).toEqual([leaked]);
    expect(await userItems(u.id)).toEqual([]);
    expect(logged()).not.toContain(leaked);
  });

  it("error de consulta durante la verificación → la foto se conserva; se registra sin publicId ni userId", async () => {
    const u = await userWithConsent();
    const { wardrobe } = await services();
    analysis.analyze.mockRejectedValue(new Error("IA no disponible"));
    let leaked = "";
    override({
      models: {
        wardrobeItem: {
          create: async (_o, args) => { leaked = (args[0] as { data: { imagePublicId: string } }).data.imagePublicId; throw prismaError(`"${leaked}"`); },
          findFirst: async (_o, args) => { throw verifyError(`${JSON.stringify(args[0])} "${u.id}"`); },
        },
      },
    });
    await expect(wardrobe.createFromUpload(u.id, IMG, "single")).rejects.toThrow("Fallo de base de datos");
    holder.prisma = t.prisma;
    expect(cloud.deleted).toEqual([]);
    expect(cloud.stored.has(leaked)).toBe(true);
    expect(logged()).toContain("wardrobe.orphan_unverified");
    expect(logged()).not.toContain(leaked);
    expect(logged()).not.toContain(u.id);
  });

  it("un error que NO es de base de datos se relanza intacto (no se convierte en genérico) y la imagen se trata igual", async () => {
    const u = await userWithConsent();
    const { wardrobe } = await services();
    analysis.analyze.mockRejectedValue(new Error("IA no disponible"));
    const bug = new TypeError("Cannot read properties of undefined (reading 'x')");
    override({ models: { wardrobeItem: { create: async () => { throw bug; } } } });
    await expect(wardrobe.createFromUpload(u.id, IMG, "single")).rejects.toBe(bug);
    holder.prisma = t.prisma;
    expect(cloud.deleted).toHaveLength(1); // verificado: sin referencia → se borra
    expect(await userItems(u.id)).toEqual([]);
  });

  it("Cloudinary falla durante la limpieza → queda registrado; sale el error de base de datos y no hay prendas", async () => {
    const u = await userWithConsent();
    const { wardrobe } = await services();
    analysis.analyze.mockRejectedValue(new Error("IA no disponible"));
    override({ models: { wardrobeItem: { create: async () => { throw prismaError("x"); } } } });
    cloud.failDelete = true;
    await expect(wardrobe.createFromUpload(u.id, IMG, "single")).rejects.toThrow("Fallo de base de datos (P1017)");
    holder.prisma = t.prisma;
    expect(logged()).toContain("cloudinary.delete");
    expect(cloud.stored.size).toBe(1);
    expect(await userItems(u.id)).toEqual([]);
  });

  it("foto original compartida por varias prendas (recortes fallidos) y falla la segunda → la foto NO se borra: la primera la sigue usando", async () => {
    const u = await userWithConsent();
    const { wardrobe } = await services();
    analysis.analyze.mockResolvedValue([detected(BOX, "Camiseta"), detected(BOX, "Vaqueros")]);
    cloud.failCrop = true; // ambas prendas apuntan a la foto original
    let saves = 0;
    override({ models: { wardrobeItem: { create: async (orig, args) => { if (isSave(args) && ++saves === 2) throw prismaError("x"); return orig(...args); } } } });
    await expect(wardrobe.createFromUpload(u.id, IMG, "multi")).rejects.toThrow("Fallo de base de datos");
    holder.prisma = t.prisma;
    const items = await userItems(u.id);
    expect(items).toHaveLength(1);
    expect(cloud.deleted).toEqual([]);
    expect(cloud.stored.has(items[0]!.imagePublicId!)).toBe(true);
  });

  it("foto original compartida y la segunda escritura se confirma pero se pierde la respuesta → nada se borra", async () => {
    const u = await userWithConsent();
    const { wardrobe } = await services();
    analysis.analyze.mockResolvedValue([detected(BOX, "Camiseta"), detected(BOX, "Vaqueros")]);
    cloud.failCrop = true;
    let saves = 0;
    override({ models: { wardrobeItem: { create: async (orig, args) => { const r = await orig(...args); if (isSave(args) && ++saves === 2) throw prismaError("x"); return r; } } } });
    await expect(wardrobe.createFromUpload(u.id, IMG, "multi")).rejects.toThrow("Fallo de base de datos");
    holder.prisma = t.prisma;
    expect(await userItems(u.id)).toHaveLength(2);
    expect(cloud.deleted).toEqual([]);
  });

  it("foto original sin uso pero la consulta de referencias (por usuario) falla → NO se borra; se registra saneado", async () => {
    const u = await userWithConsent();
    const { wardrobe } = await services();
    analysis.analyze.mockResolvedValue([detected(BOX)]); // el recorte sale bien: la original no la usa ninguna prenda
    override({ models: { wardrobeItem: { count: async (_o, args) => { throw verifyError(`${JSON.stringify(args[0])} "${u.id}"`); } } } });
    const out = await wardrobe.createFromUpload(u.id, IMG, "multi");
    holder.prisma = t.prisma;
    expect(out.status).toBe("ok");
    const [item] = await userItems(u.id);
    const original = [...cloud.stored].find((id) => id !== item!.imagePublicId)!;
    expect(original).toBeTruthy();
    expect(cloud.deleted).toEqual([]); // sin confirmación, la original se conserva
    expect(logged()).toContain("wardrobe.orphan_unverified");
    expect(logged()).not.toContain(original);
    expect(logged()).not.toContain(u.id);
  });

  it("aislamiento: la imagen referenciada por una prenda de OTRO usuario → no se borra, no se toca esa prenda ni se da por guardada", async () => {
    const shared = `ai-wardrobe/compartida/wardrobe/img-${Math.random().toString(36).slice(2)}`;
    const other = await userWithConsent();
    await t.prisma.wardrobeItem.create({ data: { userId: other.id, name: "Ajena", category: "OTHER", imagePublicId: shared } });
    const u = await userWithConsent();
    const { wardrobe } = await services();
    analysis.analyze.mockRejectedValue(new Error("IA no disponible"));
    cloud.nextIds = [shared];
    override({ models: { wardrobeItem: { create: async () => { throw prismaError("x"); } } } });
    await expect(wardrobe.createFromUpload(u.id, IMG, "single")).rejects.toThrow("Fallo de base de datos");
    holder.prisma = t.prisma;
    expect(cloud.deleted).toEqual([]);
    expect(await userItems(u.id)).toEqual([]);
    expect(await t.prisma.wardrobeItem.count({ where: { userId: other.id, imagePublicId: shared } })).toBe(1);
  });
});
