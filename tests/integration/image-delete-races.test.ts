import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { startTestDb, type TestDb } from "../helpers/db";
import { prismaProxy, setTestEnv } from "../helpers/mock-prisma";

/**
 * Carreras en los borrados de imágenes, con PostgreSQL real (PGlite) y Cloudinary simulado (sin llamadas reales).
 * Las intercalaciones se fuerzan a nivel de aplicación (un «gancho» tras una lectura concreta) para que sean
 * deterministas: el pool de pruebas tiene una sola conexión y no permite esperas reales entre dos conexiones.
 */
const holder = vi.hoisted(() => ({ prisma: null as PrismaClient | null }));
const bg = vi.hoisted(() => ({ jobs: [] as (() => Promise<unknown>)[] }));
const PNG = vi.hoisted(() => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6]));
/** Estado de Cloudinary simulado: imágenes «existentes» y borrados pedidos. `fail` hace fallar los borrados. */
const cloud = vi.hoisted(() => ({ stored: new Set<string>(), deleted: [] as string[], fail: false, uploads: 0 }));

vi.mock("node:dns/promises", () => { const lookup = async () => [{ address: "104.18.20.1", family: 4 }]; return { lookup, default: { lookup } }; });
/** Descargas simuladas; `net.fail` las hace fallar con un error que NO es de base de datos. */
const net = vi.hoisted(() => ({ fail: null as Error | null }));
vi.mock("@/lib/uploads/pinned-request", () => ({ requestPinned: async () => { if (net.fail) throw net.fail; return new Response(new Uint8Array(PNG), { status: 200 }); } }));
vi.mock("@/lib/prisma", () => ({ prisma: prismaProxy(holder) }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => Promise<unknown>) => { bg.jobs.push(fn); } }));
vi.mock("@/lib/pollinations/client", () => ({ editImage: async () => PNG }));
vi.mock("@/lib/cloudinary", () => {
  const remove = async (ids: string[]) => {
    if (cloud.fail) throw Object.assign(new Error("No se ha podido borrar la imagen. Inténtalo de nuevo en unos minutos."), { status: 502, code: "IMAGE_DELETE_FAILED" });
    for (const id of ids) { cloud.deleted.push(id); cloud.stored.delete(id); }
  };
  return {
    signedUrl: (id: string) => `https://api.cloudinary.com/signed/${id}`,
    uploadPrivate: async (_b: Buffer, folder: string) => { const publicId = `${folder}/result-${++cloud.uploads}`; cloud.stored.add(publicId); return { publicId, width: 1, height: 1 }; },
    deletePrivateImages: remove,
    deleteImage: async (id: string | null | undefined) => { if (id) await remove([id]); },
    deleteImages: remove,
  };
});

let t: TestDb;
beforeAll(async () => { setTestEnv(); t = await startTestDb(); holder.prisma = t.prisma; }, 60_000);
afterAll(async () => { await t?.stop(); });
let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  holder.prisma = t.prisma;
  bg.jobs.length = 0;
  cloud.stored.clear(); cloud.deleted = []; cloud.fail = false; net.fail = null;
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { holder.prisma = t.prisma; errSpy.mockRestore(); });
const runBackground = async () => { while (bg.jobs.length) await bg.jobs.shift()!(); };

/**
 * Ejecuta `between` justo DESPUÉS de la primera llamada a `prisma.<model>.<method>` (una sola vez): fuerza la
 * intercalación «A lee → B actúa → A sigue».
 */
function afterFirst(model: "generatedImage" | "wardrobeItem", method: string, between: () => Promise<unknown>) {
  const real = t.prisma;
  let fired = false;
  holder.prisma = new Proxy(real, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (prop !== model) return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      return new Proxy(v as object, {
        get(m, q) {
          const f = Reflect.get(m, q, m) as unknown;
          if (typeof f !== "function") return f;
          if (q !== method) return (f as (...a: unknown[]) => unknown).bind(m);
          return async (...args: unknown[]) => {
            const r = await (f as (...a: unknown[]) => Promise<unknown>).apply(m, args);
            if (!fired) { fired = true; holder.prisma = real; await between(); }
            return r;
          };
        },
      });
    },
  }) as PrismaClient;
}

const services = async () => ({
  wardrobe: (await import("@/services/wardrobe.service")).wardrobeService,
  tryOn: (await import("@/services/tryon.service")).tryOnService,
});

async function newUser() {
  return t.prisma.user.create({ data: { email: `r${Math.random().toString(36).slice(2)}@q.com` } });
}
/** `n` prendas del usuario que comparten una misma foto (como cuando falla un recorte). */
async function sharedItems(userId: string, n: number, imagePublicId = `ai-wardrobe/${userId}/wardrobe/src-${Math.random().toString(36).slice(2)}`) {
  cloud.stored.add(imagePublicId);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    ids.push((await t.prisma.wardrobeItem.create({ data: { userId, name: `Prenda ${i}`, category: "OTHER", imagePublicId, imageUrl: `https://res.cloudinary.com/demo/${imagePublicId}.jpg` } })).id);
  }
  return { ids, imagePublicId };
}
const remaining = (ids: string[]) => t.prisma.wardrobeItem.count({ where: { id: { in: ids } } });

describe("prendas que comparten foto", () => {
  it("B se borra entera entre la lectura de A y su decisión → se borran las dos y la foto también", async () => {
    const u = await newUser();
    const { wardrobe } = await services();
    const { ids, imagePublicId } = await sharedItems(u.id, 2);
    // A lee su prenda; justo después, B se ejecuta entera; A decide con el estado ya cambiado.
    afterFirst("wardrobeItem", "findFirst", () => wardrobe.remove(u.id, ids[1]!));
    await wardrobe.remove(u.id, ids[0]!);
    expect(await remaining(ids)).toBe(0);
    expect(cloud.stored.has(imagePublicId)).toBe(false); // sin imagen huérfana
    expect(cloud.deleted.filter((d) => d === imagePublicId).length).toBeGreaterThanOrEqual(1);
  });

  it("dos borrados lanzados a la vez (Promise.all) → sin imagen huérfana", async () => {
    const u = await newUser();
    const { wardrobe } = await services();
    const { ids, imagePublicId } = await sharedItems(u.id, 2);
    await Promise.all(ids.map((id) => wardrobe.remove(u.id, id)));
    expect(await remaining(ids)).toBe(0);
    expect(cloud.stored.has(imagePublicId)).toBe(false);
  });

  it("cuatro prendas borradas a la vez → la foto se borra una vez quitada la última, nunca antes", async () => {
    const u = await newUser();
    const { wardrobe } = await services();
    const { ids, imagePublicId } = await sharedItems(u.id, 4);
    await Promise.all(ids.map((id) => wardrobe.remove(u.id, id)));
    expect(await remaining(ids)).toBe(0);
    expect(cloud.stored.has(imagePublicId)).toBe(false);
  });

  it("borrar una de dos → la foto NO se borra (sigue referenciada) y la otra prenda la conserva", async () => {
    const u = await newUser();
    const { wardrobe } = await services();
    const { ids, imagePublicId } = await sharedItems(u.id, 2);
    await wardrobe.remove(u.id, ids[0]!);
    expect(cloud.deleted).not.toContain(imagePublicId);
    expect(cloud.stored.has(imagePublicId)).toBe(true);
    expect(await t.prisma.wardrobeItem.findUnique({ where: { id: ids[1]! } })).toMatchObject({ imagePublicId });
  });

  it("la misma foto de OTRO usuario no cuenta como referencia propia ni se ve afectada", async () => {
    const [a, b] = [await newUser(), await newUser()];
    const { wardrobe } = await services();
    const shared = `ai-wardrobe/x/wardrobe/compartida-${Math.random()}`;
    const mine = await sharedItems(a.id, 1, shared);
    await sharedItems(b.id, 1, shared);
    await wardrobe.remove(a.id, mine.ids[0]!);
    expect(cloud.deleted).toContain(shared); // la última referencia de A
    expect(await t.prisma.wardrobeItem.count({ where: { userId: b.id, imagePublicId: shared } })).toBe(1);
  });

  it("Cloudinary falla al borrar la última referencia → la prenda se conserva (reintentable) y el reintento termina", async () => {
    const u = await newUser();
    const { wardrobe } = await services();
    const { ids, imagePublicId } = await sharedItems(u.id, 1);
    cloud.fail = true;
    await expect(wardrobe.remove(u.id, ids[0]!)).rejects.toMatchObject({ code: "IMAGE_DELETE_FAILED" });
    expect(await t.prisma.wardrobeItem.findUnique({ where: { id: ids[0]! } })).toMatchObject({ imagePublicId }); // referencia intacta
    cloud.fail = false;
    await wardrobe.remove(u.id, ids[0]!);
    expect(await remaining(ids)).toBe(0);
    expect(cloud.stored.has(imagePublicId)).toBe(false);
  });

  it("Cloudinary falla con dos prendas borradas a la vez → ninguna referencia se pierde: queda al menos una para reintentar", async () => {
    const u = await newUser();
    const { wardrobe } = await services();
    const { ids, imagePublicId } = await sharedItems(u.id, 2);
    cloud.fail = true;
    const results = await Promise.allSettled(ids.map((id) => wardrobe.remove(u.id, id)));
    expect(results.filter((r) => r.status === "rejected").length).toBe(1); // solo la última necesitaba Cloudinary
    expect(await remaining(ids)).toBe(1);
    expect(cloud.stored.has(imagePublicId)).toBe(true);
    cloud.fail = false;
    const left = (await t.prisma.wardrobeItem.findFirstOrThrow({ where: { id: { in: ids } } })).id;
    await wardrobe.remove(u.id, left);
    expect(await remaining(ids)).toBe(0);
    expect(cloud.stored.has(imagePublicId)).toBe(false);
  });

  it("una prenda sin foto se borra sin tocar Cloudinary; una ajena da 404", async () => {
    const [u, other] = [await newUser(), await newUser()];
    const { wardrobe } = await services();
    const item = await t.prisma.wardrobeItem.create({ data: { userId: u.id, name: "Sin foto", category: "OTHER" } });
    await expect(wardrobe.remove(other.id, item.id)).rejects.toMatchObject({ status: 404 });
    await wardrobe.remove(u.id, item.id);
    expect(cloud.deleted).toEqual([]);
    expect(await remaining([item.id])).toBe(0);
  });
});

/** Usuario con consentimiento, foto y conjunto, y un trabajo del probador recién creado (PENDING). */
async function jobInProgress() {
  const photo = "ai-wardrobe/u/personal/p1";
  const u = await t.prisma.user.create({ data: { email: `g${Math.random().toString(36).slice(2)}@q.com`, profile: { create: { aiPhotoConsent: true, consentAt: new Date(), photoPublicIds: [photo] } } } });
  const a = await t.prisma.wardrobeItem.create({ data: { userId: u.id, name: "Camiseta", category: "TSHIRT", imageUrl: "https://res.cloudinary.com/demo/a.jpg" } });
  const outfitId = (await t.prisma.outfit.create({ data: { userId: u.id, name: "Look", description: "d", items: { create: [{ itemId: a.id }] } } })).id;
  const { tryOn } = await services();
  const job = await tryOn.create(u.id, { outfitId, photoPublicId: photo, scenario: "studio", pose: "standing" });
  return { userId: u.id, jobId: job.id, tryOn };
}

describe("probador: borrar mientras termina una generación", () => {

  it("el borrado lee la fila (aún sin resultado) y la generación termina antes de que borre → el resultado no queda huérfano", async () => {
    const { userId, jobId, tryOn } = await jobInProgress();
    // El borrado lee la fila; justo después, la generación termina y guarda su publicId.
    afterFirst("generatedImage", "findFirst", runBackground);
    await tryOn.remove(userId, jobId);
    expect(cloud.uploads).toBeGreaterThan(0);
    expect([...cloud.stored].filter((id) => id.includes("/try-on/"))).toEqual([]); // ningún resultado sin fila
    expect(await t.prisma.generatedImage.findUnique({ where: { id: jobId } })).toBeNull();
  });

  it("la fila cambia entre la lectura y el borrado (favorito) → no se borra a ciegas: se relee y se borra la versión actual", async () => {
    const { userId, jobId, tryOn } = await jobInProgress();
    await runBackground();
    const done = await t.prisma.generatedImage.findUniqueOrThrow({ where: { id: jobId } });
    const deletes = vi.spyOn(t.prisma.generatedImage, "deleteMany");
    afterFirst("generatedImage", "findFirst", async () => {
      await new Promise((r) => setTimeout(r, 5)); // updatedAt (ms) distinto
      await t.prisma.generatedImage.update({ where: { id: jobId }, data: { isFavorite: true } });
    });
    await tryOn.remove(userId, jobId);
    expect(deletes).toHaveBeenCalledTimes(2); // el primer intento no encontró la fila tal como la leyó
    expect((await deletes.mock.results[0]!.value).count).toBe(0);
    deletes.mockRestore();
    expect(await t.prisma.generatedImage.findUnique({ where: { id: jobId } })).toBeNull();
    expect(cloud.stored.has(done.publicId!)).toBe(false);
  });

  it("el borrado ocurre antes de que la generación guarde su resultado → la generación elimina su propio resultado", async () => {
    const { userId, jobId, tryOn } = await jobInProgress();
    await tryOn.remove(userId, jobId); // aún PENDING
    await runBackground(); // la generación ya no tiene fila
    expect([...cloud.stored].filter((id) => id.includes("/try-on/"))).toEqual([]);
    expect(await t.prisma.generatedImage.findUnique({ where: { id: jobId } })).toBeNull();
  });

  it("Cloudinary falla al borrar una generación terminada → la fila conserva su publicId y el reintento la borra", async () => {
    const { userId, jobId, tryOn } = await jobInProgress();
    await runBackground();
    const done = await t.prisma.generatedImage.findUniqueOrThrow({ where: { id: jobId } });
    expect(done).toMatchObject({ status: "COMPLETED" });
    cloud.fail = true;
    await expect(tryOn.remove(userId, jobId)).rejects.toMatchObject({ code: "IMAGE_DELETE_FAILED" });
    expect(await t.prisma.generatedImage.findUnique({ where: { id: jobId } })).toMatchObject({ publicId: done.publicId });
    cloud.fail = false;
    await tryOn.remove(userId, jobId);
    expect(cloud.stored.has(done.publicId!)).toBe(false);
    expect(await t.prisma.generatedImage.findUnique({ where: { id: jobId } })).toBeNull();
  });

  it("dos borrados simultáneos de la misma generación terminada → una sola fila borrada, sin errores ni huérfanos", async () => {
    const { userId, jobId, tryOn } = await jobInProgress();
    await runBackground();
    const results = await Promise.allSettled([tryOn.remove(userId, jobId), tryOn.remove(userId, jobId)]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ status: 404 });
    expect([...cloud.stored].filter((id) => id.includes("/try-on/"))).toEqual([]);
    expect(await t.prisma.generatedImage.findUnique({ where: { id: jobId } })).toBeNull();
  });
});

type PrismaImpl = (orig: (...a: unknown[]) => Promise<unknown>, args: unknown[]) => Promise<unknown>;
/**
 * Sustituye operaciones concretas de `prisma.<model>` hasta el final de la prueba (cada `impl` recibe la original).
 * Simula fallos de la base de datos en puntos exactos sin tocar el resto de consultas.
 */
function overrideModel(model: "generatedImage" | "wardrobeItem", impls: Record<string, PrismaImpl>) {
  const real = t.prisma;
  holder.prisma = new Proxy(real, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (prop !== model) return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      return new Proxy(v as object, {
        get(m, q) {
          const f = Reflect.get(m, q, m) as unknown;
          if (typeof f !== "function") return f;
          const bound = (f as (...a: unknown[]) => Promise<unknown>).bind(m);
          const impl = typeof q === "string" ? impls[q] : undefined;
          return impl ? (...args: unknown[]) => impl(bound, args) : bound;
        },
      });
    },
  }) as PrismaClient;
}
const overridePrisma = (model: "generatedImage", method: string, impl: PrismaImpl) => overrideModel(model, { [method]: impl });
/** ¿Es el UPDATE que guarda el resultado (COMPLETED con publicId)? */
const isResultSave = (args: unknown[]) => (args[0] as { data?: { status?: string } }).data?.status === "COMPLETED";
const dbDown = () => Object.assign(new Error("Can't reach database server"), { code: "P1001" });

describe("probador: fallo al guardar el resultado tras subirlo", () => {
  const results = () => [...cloud.stored].filter((id) => id.includes("/try-on/"));
  const usage = (userId: string) => t.prisma.aiUsageLog.findMany({ where: { userId, task: "TRY_ON" } });
  const logged = () => errSpy.mock.calls.flat().join(" ");

  it("guardado correcto → resultado conservado, COMPLETED y cuota como éxito (sin cambios)", async () => {
    const { userId, jobId } = await jobInProgress();
    await runBackground();
    const row = await t.prisma.generatedImage.findUniqueOrThrow({ where: { id: jobId } });
    expect(row).toMatchObject({ status: "COMPLETED" });
    expect(results()).toEqual([row.publicId]);
    expect(cloud.deleted).toEqual([]);
    expect(await usage(userId)).toMatchObject([{ success: true }]);
  });

  it("el guardado falla y no quedó nada guardado → se comprueba, se borra el resultado; FAILED y cuota consumida como antes", async () => {
    const { userId, jobId } = await jobInProgress();
    overridePrisma("generatedImage", "updateMany", (orig, args) => (isResultSave(args) ? Promise.reject(dbDown()) : orig(...args)));
    await runBackground();
    holder.prisma = t.prisma;
    expect(cloud.uploads).toBeGreaterThan(0);
    expect(results()).toEqual([]); // ningún resultado sin referencia
    expect(cloud.deleted.some((id) => id.includes("/try-on/"))).toBe(true);
    expect(await t.prisma.generatedImage.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: "FAILED", publicId: null });
    expect(await usage(userId)).toMatchObject([{ success: false }]); // se llamó al proveedor: consumida, como siempre
  });

  it("el guardado se confirmó pero su respuesta se perdió → se detecta la referencia: NO se borra y el trabajo queda completo", async () => {
    const { userId, jobId } = await jobInProgress();
    overridePrisma("generatedImage", "updateMany", async (orig, args) => {
      const r = await orig(...args);
      if (isResultSave(args)) throw dbDown(); // se escribió, pero el llamador recibe un error
      return r;
    });
    await runBackground();
    holder.prisma = t.prisma;
    const row = await t.prisma.generatedImage.findUniqueOrThrow({ where: { id: jobId } });
    expect(row).toMatchObject({ status: "COMPLETED" });
    expect(row.publicId).toBeTruthy();
    expect(results()).toEqual([row.publicId]); // la imagen referenciada sigue ahí
    expect(cloud.deleted).toEqual([]);
    expect(await usage(userId)).toMatchObject([{ success: true }]);
    expect(logged()).toContain("tryon.persist_uncertain");
  });

  it("no se puede consultar la base de datos para verificar → NO se borra a ciegas; queda registrado sin datos sensibles", async () => {
    const { userId, jobId } = await jobInProgress();
    overridePrisma("generatedImage", "updateMany", (orig, args) => (isResultSave(args) ? Promise.reject(dbDown()) : orig(...args)));
    let countCalls = 0;
    const base = holder.prisma!;
    holder.prisma = new Proxy(base, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target) as unknown;
        if (prop !== "generatedImage") return v;
        return new Proxy(v as object, { get: (m, q) => (q === "count" ? async () => { countCalls++; throw dbDown(); } : Reflect.get(m, q, m)) });
      },
    }) as PrismaClient;
    await runBackground();
    holder.prisma = t.prisma;
    expect(countCalls).toBe(1);
    expect(cloud.deleted).toEqual([]); // sin verificación, no se borra
    expect(results()).toHaveLength(1);
    expect(logged()).toContain("tryon.orphan_unverified");
    expect(logged()).not.toContain(results()[0]!); // el publicId (ruta con el id de usuario) no va al log
    expect(await t.prisma.generatedImage.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: "FAILED" });
    expect(await usage(userId)).toMatchObject([{ success: false }]);
  });

  it("Cloudinary falla al limpiar → queda registrado (tryon.orphan), el trabajo termina FAILED y la cuota como antes", async () => {
    const { userId, jobId } = await jobInProgress();
    overridePrisma("generatedImage", "updateMany", (orig, args) => (isResultSave(args) ? Promise.reject(dbDown()) : orig(...args)));
    cloud.fail = true;
    await runBackground();
    holder.prisma = t.prisma;
    cloud.fail = false;
    expect(logged()).toContain("tryon.orphan");
    expect(await t.prisma.generatedImage.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: "FAILED" });
    expect(await usage(userId)).toMatchObject([{ success: false }]);
  });
});

/**
 * Guardado del resultado con la base de datos poco fiable: si no se puede verificar si la escritura se confirmó,
 * ni se borra la imagen ni se marca FAILED una fila que la tenga guardada (no podría reintentarse y sobrescribirse).
 * Los errores simulados repiten el publicId en su mensaje (como puede hacer Prisma) para comprobar que no llega al log.
 */
describe("probador: guardado no verificable del resultado", () => {
  const results = () => [...cloud.stored].filter((id) => id.includes("/try-on/"));
  const usage = (userId: string) => t.prisma.aiUsageLog.findMany({ where: { userId, task: "TRY_ON" } });
  const logged = () => errSpy.mock.calls.flat().join(" ");
  /** Error de conexión cuyo mensaje incluye los argumentos de la consulta (y con ellos el publicId). */
  const echoError = (args: unknown[]) => Object.assign(new Error(`Invalid \`prisma.generatedImage\` invocation: ${JSON.stringify(args[0])} Can't reach database server`), { code: "P1001" });
  const saveFails: PrismaImpl = (orig, args) => (isResultSave(args) ? Promise.reject(echoError(args)) : orig(...args));
  const saveCommitsButResponseLost: PrismaImpl = async (orig, args) => { const r = await orig(...args); if (isResultSave(args)) throw echoError(args); return r; };
  const verifyFails: PrismaImpl = async (_orig, args) => { throw echoError(args); };

  it("la escritura falla y la verificación también → la imagen NO se borra; FAILED (no hay resultado guardado); cuota consumida; log sin publicId", async () => {
    const { userId, jobId } = await jobInProgress();
    overrideModel("generatedImage", { updateMany: saveFails, count: verifyFails });
    await runBackground();
    holder.prisma = t.prisma;
    const [kept] = results();
    expect(kept).toBeTruthy();
    expect(cloud.deleted).toEqual([]); // sin verificación, nunca se borra a ciegas
    expect(await t.prisma.generatedImage.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: "FAILED", publicId: null });
    expect(await usage(userId)).toMatchObject([{ success: false }]);
    expect(logged()).toContain("tryon.orphan_unverified");
    expect(logged()).toContain("P1001");
    expect(logged()).not.toContain(kept!); // ni en tryon.orphan_unverified ni en tryon.run
  });

  it("la escritura se confirma, se pierde la respuesta y la verificación falla → la fila sigue COMPLETED con su publicId (no pasa a FAILED) y la imagen se conserva", async () => {
    const { userId, jobId } = await jobInProgress();
    overrideModel("generatedImage", { updateMany: saveCommitsButResponseLost, count: verifyFails });
    await runBackground();
    holder.prisma = t.prisma;
    const row = await t.prisma.generatedImage.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.status).toBe("COMPLETED");
    expect(row.publicId).toBeTruthy();
    expect(results()).toEqual([row.publicId]); // la imagen referenciada sigue en Cloudinary
    expect(cloud.deleted).toEqual([]);
    // Cuota: se llamó al proveedor y el resultado no se pudo confirmar → consumida (misma regla que cualquier fallo tras llamarlo).
    expect(await usage(userId)).toMatchObject([{ success: false }]);
    expect(logged()).not.toContain(row.publicId!);
  });

  it("una referencia ya guardada nunca se sobrescribe ni se elimina: no se puede reintentar y el usuario ve el resultado", async () => {
    const { userId, jobId } = await jobInProgress();
    overrideModel("generatedImage", { updateMany: saveCommitsButResponseLost, count: verifyFails });
    await runBackground();
    holder.prisma = t.prisma;
    const before = await t.prisma.generatedImage.findUniqueOrThrow({ where: { id: jobId } });
    const { tryOn } = await services();
    await expect(tryOn.retry(userId, jobId)).rejects.toMatchObject({ status: 409, code: "NOT_RETRYABLE" });
    await runBackground(); // nada pendiente que pueda sustituirlo
    const dto = await tryOn.get(userId, jobId);
    expect(dto).toMatchObject({ status: "COMPLETED" });
    expect(dto.imageUrl).toContain(before.publicId!);
    const after = await t.prisma.generatedImage.findUniqueOrThrow({ where: { id: jobId } });
    expect(after.publicId).toBe(before.publicId);
    expect(results()).toEqual([before.publicId]);
    expect(await usage(userId)).toHaveLength(1); // el reintento rechazado no reservó otra unidad
  });

  it("si además falla la marca de FAILED (base de datos caída), la fila no se altera y la imagen no se borra", async () => {
    const { userId, jobId } = await jobInProgress();
    overrideModel("generatedImage", {
      updateMany: async (orig, args) => {
        if (isResultSave(args)) throw echoError(args);
        if ((args[0] as { data?: { status?: string } }).data?.status === "FAILED") throw echoError(args);
        return orig(...args);
      },
      count: verifyFails,
    });
    await runBackground();
    holder.prisma = t.prisma;
    expect(await t.prisma.generatedImage.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: "PROCESSING", publicId: null });
    expect(cloud.deleted).toEqual([]);
    expect(results()).toHaveLength(1);
    expect(await usage(userId)).toMatchObject([{ success: false }]);
  });

  it("fallo confirmado sin referencia → la imagen se sigue limpiando; FAILED y cuota consumida; log sin publicId", async () => {
    const { userId, jobId } = await jobInProgress();
    overrideModel("generatedImage", { updateMany: saveFails });
    await runBackground();
    holder.prisma = t.prisma;
    expect(results()).toEqual([]);
    const cleaned = cloud.deleted.find((id) => id.includes("/try-on/"));
    expect(cleaned).toBeTruthy();
    expect(await t.prisma.generatedImage.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: "FAILED", publicId: null });
    expect(await usage(userId)).toMatchObject([{ success: false }]);
    expect(logged()).not.toContain(cleaned!);
  });

  it("Cloudinary falla al limpiar → la fila del trabajo se conserva intacta y reintentable; el reintento guarda su nueva referencia", async () => {
    const { userId, jobId } = await jobInProgress();
    overrideModel("generatedImage", { updateMany: saveFails });
    cloud.fail = true;
    await runBackground();
    holder.prisma = t.prisma;
    cloud.fail = false;
    expect(logged()).toContain("tryon.orphan");
    const failed = await t.prisma.generatedImage.findUniqueOrThrow({ where: { id: jobId } });
    expect(failed).toMatchObject({ status: "FAILED", publicId: null, attempts: 1 });
    const { tryOn } = await services();
    await tryOn.retry(userId, jobId);
    await runBackground();
    const done = await t.prisma.generatedImage.findUniqueOrThrow({ where: { id: jobId } });
    expect(done).toMatchObject({ status: "COMPLETED", attempts: 2 });
    expect(cloud.stored.has(done.publicId!)).toBe(true);
    expect(await usage(userId)).toMatchObject([{ success: false }, { success: true }]);
  });

  it("la escritura se confirma y se pierde la respuesta, con Cloudinary fallando → se verifica guardada: ni se intenta borrar ni se pierde la referencia", async () => {
    const { userId, jobId } = await jobInProgress();
    overrideModel("generatedImage", { updateMany: saveCommitsButResponseLost });
    cloud.fail = true;
    await runBackground();
    holder.prisma = t.prisma;
    cloud.fail = false;
    const row = await t.prisma.generatedImage.findUniqueOrThrow({ where: { id: jobId } });
    expect(row).toMatchObject({ status: "COMPLETED" });
    expect(results()).toEqual([row.publicId]);
    expect(cloud.deleted).toEqual([]);
    expect(await usage(userId)).toMatchObject([{ success: true }]);
  });
});

/**
 * Ningún log de run() puede contener mensajes originales de Prisma (que repiten argumentos: publicId, id de usuario,
 * publicId de la foto personal). Se usan las clases de error REALES de Prisma y se espían todas las salidas de consola.
 * Los errores que no son de base de datos conservan su diagnóstico.
 */
describe("probador: logs de run() sin datos sensibles", () => {
  let spies: ReturnType<typeof vi.spyOn>[] = [];
  beforeEach(() => { spies = (["warn", "log", "info", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined)); });
  afterEach(() => { for (const sp of spies) sp.mockRestore(); });
  /** Todo lo escrito en consola (error, warn, log, info, debug), incluidos los stacks. */
  const allLogs = () => [errSpy, ...spies].flatMap((sp) => (sp.mock.calls.flat() as unknown[]).map((a: unknown) => (typeof a === "string" ? a : JSON.stringify(a) ?? String(a)))).join("\n");
  const usage = (userId: string) => t.prisma.aiUsageLog.findMany({ where: { userId, task: "TRY_ON" } });
  const known = (msg: string, code = "P1017") => new Prisma.PrismaClientKnownRequestError(msg, { code, clientVersion: "test" });
  const validation = (msg: string) => new Prisma.PrismaClientValidationError(msg, { clientVersion: "test" });
  const savedPublicId = (args: unknown[]) => (args[0] as { data: { publicId: string } }).data.publicId;

  it("absent: el guardado falla con un error de Prisma que contiene el publicId → se limpia y el publicId no aparece en ningún log", async () => {
    const { userId, jobId } = await jobInProgress();
    let leaked = "";
    overrideModel("generatedImage", {
      updateMany: (orig, args) => {
        if (!isResultSave(args)) return orig(...args);
        leaked = savedPublicId(args);
        return Promise.reject(known(`Invalid \`prisma.generatedImage.updateMany()\` invocation: { publicId: "${leaked}" } Server has closed the connection.`));
      },
    });
    await runBackground();
    holder.prisma = t.prisma;
    expect(leaked).toContain("/try-on/");
    expect(cloud.deleted).toContain(leaked); // absent → limpiada
    expect(await t.prisma.generatedImage.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: "FAILED", publicId: null });
    expect(await usage(userId)).toMatchObject([{ success: false }]);
    const logs = allLogs();
    expect(logs).toContain("tryon.run");
    expect(logs).toContain("Fallo de base de datos (P1017)"); // diagnóstico: el código, no el mensaje
    expect(logs).not.toContain(leaked);
    expect(logs).not.toContain("Invalid `prisma");
  });

  it("unknown: el guardado y la verificación fallan con errores de Prisma (KnownRequest y Validation) que contienen el publicId → nada se borra y no aparece en ningún log", async () => {
    const { userId, jobId } = await jobInProgress();
    let leaked = "";
    overrideModel("generatedImage", {
      updateMany: (orig, args) => {
        if (!isResultSave(args)) return orig(...args);
        leaked = savedPublicId(args);
        return Promise.reject(known(`Invalid invocation: { publicId: "${leaked}" } Timed out fetching a new connection`, "P2024"));
      },
      count: async (_orig, args) => { throw validation(`Invalid \`prisma.generatedImage.count()\` invocation:\n{ where: { publicId: "${(args[0] as { where: { publicId: string } }).where.publicId}" } }`); },
    });
    await runBackground();
    holder.prisma = t.prisma;
    expect(cloud.deleted).toEqual([]); // unknown → no se borra a ciegas
    expect(cloud.stored.has(leaked)).toBe(true);
    expect(await t.prisma.generatedImage.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: "FAILED", publicId: null });
    expect(await usage(userId)).toMatchObject([{ success: false }]);
    const logs = allLogs();
    expect(logs).toContain("tryon.orphan_unverified");
    expect(logs).toContain("Fallo de base de datos (P2024)");
    expect(logs).not.toContain(leaked);
    expect(logs).not.toContain("Invalid");
  });

  it("un error de Prisma ANTES de la subida (consulta de prendas) con el id de usuario y la foto personal → saneado en tryon.run; cuota devuelta como siempre", async () => {
    const { userId, jobId } = await jobInProgress();
    const photo = (await t.prisma.generatedImage.findUniqueOrThrow({ where: { id: jobId } })).sourcePhotoId!;
    overrideModel("wardrobeItem", { findMany: async () => { throw validation(`Invalid \`prisma.wardrobeItem.findMany()\` invocation: { where: { userId: "${userId}" } } photo "${photo}"`); } });
    await runBackground();
    holder.prisma = t.prisma;
    expect(await t.prisma.generatedImage.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: "FAILED" });
    expect(await usage(userId)).toEqual([]); // fallo antes de llamar al proveedor → unidad devuelta (sin cambios)
    const logs = allLogs();
    expect(logs).toContain("tryon.run");
    expect(logs).toContain("Fallo de base de datos");
    expect(logs).not.toContain(userId);
    expect(logs).not.toContain(photo);
  });

  it("un error que NO es de base de datos al guardar el resultado conserva su diagnóstico (no se convierte en «Fallo de base de datos»)", async () => {
    const { userId, jobId } = await jobInProgress();
    overrideModel("generatedImage", { updateMany: (orig, args) => (isResultSave(args) ? Promise.reject(new TypeError("Cannot read properties of undefined (reading 'publicId')")) : orig(...args)) });
    await runBackground();
    holder.prisma = t.prisma;
    expect(await t.prisma.generatedImage.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: "FAILED" });
    expect(cloud.deleted.some((id) => id.includes("/try-on/"))).toBe(true); // verificado sin referencia → limpiado
    expect(await usage(userId)).toMatchObject([{ success: false }]);
    const logs = allLogs();
    expect(logs).toContain("Cannot read properties of undefined (reading 'publicId')");
    expect(logs).not.toContain("Fallo de base de datos");
  });

  it("un error que NO es de base de datos conserva su diagnóstico completo en tryon.run (no se oculta)", async () => {
    const { userId, jobId } = await jobInProgress();
    net.fail = Object.assign(new Error("connect ECONNREFUSED al descargar la foto de referencia"), { code: "ECONNREFUSED" });
    await runBackground();
    expect(await t.prisma.generatedImage.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: "FAILED" });
    expect(await usage(userId)).toEqual([]); // antes de llamar al proveedor → devuelta
    const logs = allLogs();
    expect(logs).toContain("tryon.run");
    expect(logs).toContain("connect ECONNREFUSED al descargar la foto de referencia");
    expect(logs).not.toContain("Fallo de base de datos");
  });
});
