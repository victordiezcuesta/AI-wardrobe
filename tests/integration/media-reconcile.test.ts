import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { startTestDb, type TestDb } from "../helpers/db";
import { setTestEnv } from "../helpers/mock-prisma";

/**
 * Detector de imágenes huérfanas (fase 18.1): SOLO LECTURA. Servicio REAL contra PostgreSQL (PGlite) con la Admin API
 * de Cloudinary simulada (sin llamadas reales). Se comprueba la clasificación, la paginación, los inventarios
 * incompletos, que el informe no expone identificadores y que no se ejecuta ninguna escritura ni borrado.
 */
const holder = vi.hoisted(() => ({ prisma: null as PrismaClient | null, writes: [] as string[] }));
/** Inventario simulado por tipo de entrega: páginas en orden; cada elemento es una página o un error a lanzar. */
const admin = vi.hoisted(() => ({
  pages: { upload: [] as unknown[], authenticated: [] as unknown[] },
  calls: [] as { type: string; cursor?: string }[],
  mutations: [] as string[],
  aborted: 0,
}));
/** Páginas especiales: «HANG» espera hasta que se aborte (cancelable); «IGNORE» nunca termina ni atiende el aborto. */
const HANG = vi.hoisted(() => ({ hang: true })); const IGNORE = vi.hoisted(() => ({ ignore: true }));

const WRITE_METHODS = /^(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)$/;
const RAW_WRITES = /^\$(executeRaw|executeRawUnsafe|transaction|queryRaw|queryRawUnsafe)$/;
/** Cliente que delega en PGlite y registra cualquier intento de escritura (o SQL en bruto) en `holder.writes`. */
vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy({}, {
    get(_t, prop) {
      const client = holder.prisma as unknown as Record<string | symbol, unknown>;
      const v = client[prop];
      if (typeof prop === "string" && RAW_WRITES.test(prop)) holder.writes.push(prop);
      if (typeof v === "function") return (v as (...a: unknown[]) => unknown).bind(client);
      if (v && typeof v === "object" && typeof prop === "string" && !prop.startsWith("$")) {
        return new Proxy(v as Record<string, unknown>, {
          get(d, m) {
            const fn = d[m as string];
            if (typeof m === "string" && WRITE_METHODS.test(m)) holder.writes.push(`${prop}.${m}`);
            return typeof fn === "function" ? (fn as (...a: unknown[]) => unknown).bind(d) : fn;
          },
        });
      }
      return v;
    },
  }),
}));
/** Toda la librería de Cloudinary simulada: lo que no sea el listado de solo lectura queda registrado como mutación. */
vi.mock("@/lib/cloudinary", () => {
  const mutation = (name: string) => async () => { admin.mutations.push(name); };
  return {
    APP_ROOT_PREFIX: "ai-wardrobe/",
    listAppResourcesPage: async (type: "upload" | "authenticated", cursor: string | undefined, signal: AbortSignal) => {
      admin.calls.push({ type, cursor });
      const pages = admin.pages[type];
      const idx = cursor ? Number(cursor.replace(`${type}-c`, "")) : 0;
      if (idx >= pages.length) return { resources: [] };
      const p = pages[idx];
      if (p instanceof Error) throw p;
      if (p === IGNORE) return new Promise(() => undefined);
      if (p === HANG) return new Promise((_r, reject) => signal.addEventListener("abort", () => { admin.aborted++; reject(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })); }));
      if (typeof p === "function") return (p as (s: AbortSignal) => Promise<unknown>)(signal);
      return p;
    },
    uploadBuffer: mutation("uploadBuffer"), uploadCrop: mutation("uploadCrop"), uploadPrivate: mutation("uploadPrivate"),
    deleteImage: mutation("deleteImage"), deleteImages: mutation("deleteImages"), deletePrivateImages: mutation("deletePrivateImages"),
    deleteAllUserAssets: mutation("deleteAllUserAssets"),
  };
});

let t: TestDb;
let errSpy: ReturnType<typeof vi.spyOn>;
const CRON_SECRET = ["cron", "prueba", "0123456789abcdef"].join("-"); // ficticio (sin literal: regla de higiene)
beforeAll(async () => { setTestEnv(); process.env.CRON_SECRET = CRON_SECRET; t = await startTestDb(); holder.prisma = t.prisma; }, 60_000);
afterAll(async () => { await t?.stop(); });
beforeEach(async () => {
  await t.prisma.$executeRawUnsafe(`TRUNCATE "User", "CatalogProduct" CASCADE`);
  holder.writes = []; admin.pages = { upload: [], authenticated: [] }; admin.calls = []; admin.mutations = []; admin.aborted = 0;
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { errSpy.mockRestore(); });

const NOW = new Date("2026-11-21T12:00:00Z");
const OLD = "2026-11-18T12:00:00Z"; // 3 días: supera el periodo de seguridad (24 h)
const RECENT = "2026-11-21T11:00:00Z"; // 1 hora
/** Recurso como lo devuelve la Admin API (con los metadatos completos; `asset_id` estable y distinto por recurso). */
const res = (public_id: string, type: "upload" | "authenticated", created_at = OLD) =>
  ({ public_id, type, created_at, asset_id: `a${Buffer.from(`${type}:${public_id}`).toString("hex").slice(-31)}`, version: 1732190000, bytes: 12345, format: "jpg", resource_type: "image" });
/** Reparte recursos en páginas encadenadas por cursor (`<tipo>-c<n>`). */
function paginate(type: "upload" | "authenticated", ...pages: unknown[][]) {
  admin.pages[type] = pages.map((resources, i) => ({ resources, ...(i < pages.length - 1 ? { next_cursor: `${type}-c${i + 1}` } : {}) }));
}
const detect = async (opts: Record<string, unknown> = {}) => (await import("@/services/media-reconcile.service")).detectOrphanMedia({ now: NOW, ...opts });
async function user(photos: string[] = []) {
  return t.prisma.user.create({ data: { email: `m${Math.random().toString(36).slice(2)}@q.com`, profile: { create: { photoPublicIds: photos } } } });
}
const item = (userId: string, imagePublicId: string | null) =>
  t.prisma.wardrobeItem.create({ data: { userId, name: "Prenda", category: "OTHER", imagePublicId, imageUrl: imagePublicId ? `https://res.cloudinary.com/demo/image/upload/v1/${imagePublicId}` : null } });
const generated = (userId: string, publicId: string | null, sourcePhotoId: string | null = null) =>
  t.prisma.generatedImage.create({ data: { userId, scenario: "x", pose: "y", status: publicId ? "COMPLETED" : "FAILED", publicId, sourcePhotoId } });
const counts = (r: Awaited<ReturnType<typeof detect>>) => r.byCategory;
const ZERO = { REFERENCED: 0, ORPHAN_CANDIDATE: 0, TOO_RECENT: 0, UNKNOWN: 0, INCOMPLETE: 0, QUARANTINED: 0 };

describe("clasificación", () => {
  it("prenda referenciada, compartida por varias prendas, foto personal y resultado de try-on → REFERENCED", async () => {
    const u = await user();
    const ph = `ai-wardrobe/${u.id}/personal/p1`;
    await t.prisma.userProfile.update({ where: { userId: u.id }, data: { photoPublicIds: [ph] } });
    const w = `ai-wardrobe/${u.id}/wardrobe/w1`; const shared = `ai-wardrobe/${u.id}/wardrobe/shared`; const g = `ai-wardrobe/${u.id}/try-on/g1`;
    await item(u.id, w); await item(u.id, shared); await item(u.id, shared); await item(u.id, shared); await generated(u.id, g, ph);
    paginate("upload", [res(w, "upload"), res(shared, "upload")]);
    paginate("authenticated", [res(ph, "authenticated"), res(g, "authenticated")]);
    const r = await detect();
    expect(r.complete).toBe(true);
    expect(counts(r)).toEqual({ ...ZERO, REFERENCED: 4 });
    expect(r.byKind).toEqual({ wardrobe: 2, personal: 1, tryOn: 1, unknown: 0, quarantine: 0 });
    expect(r.resourcesExamined).toBe(4);
    expect(r.brokenReferences).toEqual({ total: 0, wardrobe: 0, personal: 0, tryOn: 0 });
  });

  it("sin referencia: antigua → ORPHAN_CANDIDATE; reciente → TOO_RECENT (por cada tipo)", async () => {
    const u = await user();
    paginate("upload", [res(`ai-wardrobe/${u.id}/wardrobe/old`, "upload"), res(`ai-wardrobe/${u.id}/wardrobe/new`, "upload", RECENT)]);
    paginate("authenticated", [
      res(`ai-wardrobe/${u.id}/personal/old`, "authenticated"), res(`ai-wardrobe/${u.id}/try-on/old`, "authenticated"),
      res(`ai-wardrobe/${u.id}/try-on/new`, "authenticated", RECENT),
    ]);
    const r = await detect();
    expect(counts(r)).toEqual({ ...ZERO, ORPHAN_CANDIDATE: 3, TOO_RECENT: 2 });
    expect(r.orphanDetail).toEqual({ ownerMissing: 0, personalCitedOnlyBySourcePhoto: 0 });
  });

  it("el periodo de seguridad se respeta exactamente (justo por debajo → TOO_RECENT; por encima → candidata)", async () => {
    const u = await user();
    const at = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
    paginate("upload", [res(`ai-wardrobe/${u.id}/wardrobe/a`, "upload", at(24 * 3_600_000 - 1000)), res(`ai-wardrobe/${u.id}/wardrobe/b`, "upload", at(24 * 3_600_000 + 1000))]);
    expect(counts(await detect())).toEqual({ ...ZERO, ORPHAN_CANDIDATE: 1, TOO_RECENT: 1 });
  });

  it("imagen de un usuario que ya no existe → ORPHAN_CANDIDATE con ownerMissing", async () => {
    paginate("authenticated", [res("ai-wardrobe/cmusuarioborrado0000000000/personal/p", "authenticated")]);
    const r = await detect();
    expect(counts(r)).toEqual({ ...ZERO, ORPHAN_CANDIDATE: 1 });
    expect(r.orphanDetail.ownerMissing).toBe(1);
  });

  it("foto personal fuera del perfil pero citada por sourcePhotoId → sigue siendo candidata (solo se informa)", async () => {
    const u = await user();
    const ph = `ai-wardrobe/${u.id}/personal/retirada`;
    await generated(u.id, null, ph);
    paginate("authenticated", [res(ph, "authenticated")]);
    const r = await detect();
    expect(counts(r)).toEqual({ ...ZERO, ORPHAN_CANDIDATE: 1 });
    expect(r.orphanDetail.personalCitedOnlyBySourcePhoto).toBe(1);
  });

  it("una referencia en OTRA tabla no cuenta: la imagen de prenda solo la referencia WardrobeItem", async () => {
    const u = await user();
    const w = `ai-wardrobe/${u.id}/wardrobe/w`;
    await t.prisma.userProfile.update({ where: { userId: u.id }, data: { photoPublicIds: [w] } }); // referencia en la tabla equivocada
    paginate("upload", [res(w, "upload")]);
    expect(counts(await detect())).toEqual({ ...ZERO, ORPHAN_CANDIDATE: 1 });
  });

  it("rutas desconocidas → UNKNOWN (carpeta extra, tipo inventado, anidada, sin propietario)", async () => {
    const u = await user();
    paginate("upload", [
      res(`ai-wardrobe/${u.id}/otros/x`, "upload"), res(`ai-wardrobe/${u.id}/wardrobe/sub/x`, "upload"),
      res("ai-wardrobe/x", "upload"), res(`ai-wardrobe/${u.id}/wardrobe/`, "upload"), res("otra-app/u/wardrobe/x", "upload"),
      { created_at: OLD }, // sin public_id
    ]);
    const r = await detect();
    expect(counts(r)).toEqual({ ...ZERO, UNKNOWN: 6 });
    expect(r.byKind.unknown).toBe(6);
  });

  it("tipo de entrega incorrecto → UNKNOWN (privada en carpeta pública y viceversa, o recurso de otro tipo en la página)", async () => {
    const u = await user();
    paginate("upload", [res(`ai-wardrobe/${u.id}/personal/p`, "upload"), res(`ai-wardrobe/${u.id}/try-on/g`, "upload")]);
    paginate("authenticated", [res(`ai-wardrobe/${u.id}/wardrobe/w`, "authenticated"), res(`ai-wardrobe/${u.id}/personal/q`, "upload")]);
    expect(counts(await detect())).toEqual({ ...ZERO, UNKNOWN: 4 });
  });

  it("fecha de creación ausente o no válida → INCOMPLETE (nunca candidata)", async () => {
    const u = await user();
    paginate("upload", [{ public_id: `ai-wardrobe/${u.id}/wardrobe/a`, type: "upload" }, res(`ai-wardrobe/${u.id}/wardrobe/b`, "upload", "no-es-fecha")]);
    expect(counts(await detect())).toEqual({ ...ZERO, INCOMPLETE: 2 });
  });

  it("inventario vacío → completo y todo a cero", async () => {
    const r = await detect();
    expect(r.complete).toBe(true);
    expect(r.resourcesExamined).toBe(0);
    expect(counts(r)).toEqual(ZERO);
    expect(r.pages).toEqual({ upload: 1, authenticated: 1 });
    expect(r.brokenReferences).toEqual({ total: 0, wardrobe: 0, personal: 0, tryOn: 0 });
  });
});

describe("referencias rotas", () => {
  it("referencias sin imagen en Cloudinary se cuentan por tipo; las URL y referencias fuera del prefijo no", async () => {
    const u = await user();
    await t.prisma.userProfile.update({ where: { userId: u.id }, data: { photoPublicIds: [`ai-wardrobe/${u.id}/personal/gone`, `ai-wardrobe/${u.id}/personal/ok`] } });
    await item(u.id, `ai-wardrobe/${u.id}/wardrobe/gone`); await item(u.id, `ai-wardrobe/${u.id}/wardrobe/gone`); // compartida: 1 rota
    await item(u.id, "demo/sample"); // fuera del prefijo (dato heredado o de ejemplo)
    await item(u.id, null);
    await generated(u.id, `ai-wardrobe/${u.id}/try-on/gone`);
    paginate("authenticated", [res(`ai-wardrobe/${u.id}/personal/ok`, "authenticated")]);
    const r = await detect();
    expect(r.brokenReferences).toEqual({ total: 3, wardrobe: 1, personal: 1, tryOn: 1 });
    expect(r.referencesOutsidePrefix).toBe(1);
    expect(counts(r)).toEqual({ ...ZERO, REFERENCED: 1 });
  });

  it("con el inventario de un tipo incompleto no se afirma ninguna referencia rota de ese tipo", async () => {
    const u = await user([`ai-wardrobe/cmotro0000000000000000000/personal/x`]); // referencia privada sin imagen
    await item(u.id, `ai-wardrobe/${u.id}/wardrobe/w`);
    admin.pages.upload = [{ resources: [], next_cursor: "upload-c1" }, new Error("fallo")];
    const r = await detect();
    expect(r.brokenReferences.wardrobe).toBeNull();
    expect(r.brokenReferences.total).toBeNull();
    expect(r.brokenReferences.personal).toBe(1); // el inventario privado sí está completo
    expect(r.referencesOutsidePrefix).toBe(0); // conocido: no depende del inventario
  });
});

describe("paginación e inventarios incompletos", () => {
  it("sigue next_cursor por varias páginas en cada tipo de entrega y examina todo", async () => {
    const u = await user();
    const w = (n: number) => res(`ai-wardrobe/${u.id}/wardrobe/w${n}`, "upload");
    paginate("upload", [w(1), w(2)], [w(3)], [w(4), w(5)]);
    paginate("authenticated", [res(`ai-wardrobe/${u.id}/try-on/a`, "authenticated")], [res(`ai-wardrobe/${u.id}/try-on/b`, "authenticated")]);
    const r = await detect();
    expect(r.complete).toBe(true);
    expect(r.pages).toEqual({ upload: 3, authenticated: 2 });
    expect(r.resourcesExamined).toBe(7);
    expect(admin.calls).toEqual([
      { type: "upload", cursor: undefined }, { type: "upload", cursor: "upload-c1" }, { type: "upload", cursor: "upload-c2" },
      { type: "authenticated", cursor: undefined }, { type: "authenticated", cursor: "authenticated-c1" },
    ]);
  });

  it("error de la API a mitad de paginación → inventario incompleto; lo ya leído se clasifica, pero el informe NO es completo", async () => {
    const u = await user();
    admin.pages.upload = [{ resources: [res(`ai-wardrobe/${u.id}/wardrobe/w1`, "upload")], next_cursor: "upload-c1" }, Object.assign(new Error(`límite para ai-wardrobe/${u.id}`), { http_code: 420 })];
    paginate("authenticated", [res(`ai-wardrobe/${u.id}/try-on/a`, "authenticated")]);
    const r = await detect();
    expect(r.complete).toBe(false);
    expect(r.inventoryComplete).toEqual({ upload: false, authenticated: true });
    expect(r.pages).toEqual({ upload: 1, authenticated: 1 });
    expect(r.errors).toEqual([{ stage: "inventory", scope: "upload", code: "CLOUDINARY_420" }]);
    expect(r.resourcesExamined).toBe(2);
    expect(r.inventoryStatus).toBe("INCOMPLETE");
    expect(counts(r)).toEqual({ ...ZERO, INCOMPLETE: 2 }); // lo leído no justifica nada: ni el público parcial ni el privado completo
    expect(r.candidatesWithheld).toBe(2);
    expect(JSON.stringify(r)).not.toContain(u.id); // el mensaje del proveedor no llega al informe
  });

  it.each([
    ["sin lista de recursos", { next_cursor: "x" }, "MALFORMED_PAGE"],
    ["recursos que no son una lista", { resources: "basura" }, "MALFORMED_PAGE"],
    ["respuesta nula", null, "MALFORMED_PAGE"],
    ["cursor que no es texto", { resources: [], next_cursor: 7 }, "BAD_CURSOR"],
  ])("respuesta incompleta o malformada (%s) → inventario incompleto", async (_n, page, code) => {
    admin.pages.upload = [page];
    const r = await detect();
    expect(r.complete).toBe(false);
    expect(r.inventoryComplete.upload).toBe(false);
    expect(r.errors).toContainEqual({ stage: "inventory", scope: "upload", code });
  });

  it("cursor repetido (bucle) → se detiene e informa incompleto", async () => {
    admin.pages.upload = [{ resources: [], next_cursor: "upload-c1" }, { resources: [], next_cursor: "upload-c1" }];
    const r = await detect();
    expect(r.inventoryComplete.upload).toBe(false);
    expect(r.errors).toContainEqual({ stage: "inventory", scope: "upload", code: "BAD_CURSOR" });
  });

  it("límite de páginas por tipo → incompleto (nunca se presenta como completo)", async () => {
    paginate("upload", [], [], [], []);
    const r = await detect({ maxPagesPerType: 2 });
    expect(r.pages.upload).toBe(2);
    expect(r.inventoryComplete.upload).toBe(false);
    expect(r.errors).toContainEqual({ stage: "inventory", scope: "upload", code: "PAGE_LIMIT" });
  });

  it("presupuesto de tiempo agotado → incompleto", async () => {
    paginate("upload", [], []);
    const r = await detect({ budgetMs: -1 });
    expect(r.complete).toBe(false);
    expect(r.errors).toEqual(expect.arrayContaining([{ stage: "inventory", scope: "upload", code: "TIME_BUDGET" }]));
  });

  it("fallo al consultar una fuente de verdad → sus recursos quedan INCOMPLETE (nunca candidatos) y el informe es incompleto", async () => {
    const u = await user();
    paginate("upload", [res(`ai-wardrobe/${u.id}/wardrobe/w`, "upload")]);
    paginate("authenticated", [res(`ai-wardrobe/${u.id}/try-on/g`, "authenticated")]);
    const real = t.prisma;
    holder.prisma = new Proxy(real, {
      get(target, prop) {
        if (prop === "wardrobeItem") return { findMany: async () => { throw Object.assign(new Error(`Invalid query ai-wardrobe/${u.id}`), { code: "P1001", name: "PrismaClientKnownRequestError" }); } };
        const v = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as PrismaClient;
    try {
      const r = await detect();
      expect(r.complete).toBe(false);
      // la prenda no se pudo verificar; el try-on tampoco puede salir candidato: sin URLs no se sabe si alguna lo usa (19.1)
      expect(counts(r)).toEqual({ ...ZERO, INCOMPLETE: 2 });
      // la misma tabla también alimenta las referencias por URL: las dos consultas quedan registradas como fallidas
      expect(r.errors).toEqual([{ stage: "database", scope: "wardrobe", code: "P1001" }, { stage: "database", scope: "urls", code: "P1001" }]);
      expect(r.urlReferences).toBeNull();
      expect(r.brokenReferences.wardrobe).toBeNull();
      expect(r.referencesOutsidePrefix).toBeNull(); // una fuente sin consultar: recuento desconocido, no 0
    } finally { holder.prisma = real; }
  });

  it("fallo al comprobar si los propietarios existen → los no referenciados quedan INCOMPLETE", async () => {
    const u = await user();
    paginate("upload", [res(`ai-wardrobe/${u.id}/wardrobe/w`, "upload")]);
    const real = t.prisma;
    holder.prisma = new Proxy(real, {
      get(target, prop) {
        if (prop === "user") return { findMany: async () => { throw new Error("caída"); } };
        const v = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as PrismaClient;
    try {
      const r = await detect();
      expect(counts(r)).toEqual({ ...ZERO, INCOMPLETE: 1 });
      expect(r.complete).toBe(false);
    } finally { holder.prisma = real; }
  });
});

describe("seguridad: solo lectura e informe sin datos personales", () => {
  it("no ejecuta ninguna escritura en PostgreSQL ni ninguna mutación en Cloudinary; no cambia ninguna fila", async () => {
    const u = await user([]);
    const ph = `ai-wardrobe/${u.id}/personal/p`;
    await t.prisma.userProfile.update({ where: { userId: u.id }, data: { photoPublicIds: [ph] } });
    await item(u.id, `ai-wardrobe/${u.id}/wardrobe/w`); await generated(u.id, `ai-wardrobe/${u.id}/try-on/gone`);
    paginate("upload", [res(`ai-wardrobe/${u.id}/wardrobe/w`, "upload"), res(`ai-wardrobe/${u.id}/wardrobe/huerfana`, "upload")]);
    paginate("authenticated", [res(ph, "authenticated"), res(`ai-wardrobe/${u.id}/try-on/huerfana`, "authenticated")]);
    const snapshot = async () => JSON.stringify(await Promise.all([
      t.prisma.user.findMany({ orderBy: { id: "asc" } }), t.prisma.userProfile.findMany({ orderBy: { userId: "asc" } }),
      t.prisma.wardrobeItem.findMany({ orderBy: { id: "asc" } }), t.prisma.generatedImage.findMany({ orderBy: { id: "asc" } }),
    ]));
    const before = await snapshot();
    holder.writes = [];
    const r = await detect();
    expect(r.byCategory.ORPHAN_CANDIDATE).toBe(2);
    expect(holder.writes).toEqual([]); // ni create/update/delete ni SQL en bruto ni transacciones
    expect(admin.mutations).toEqual([]); // ni subidas ni borrados en Cloudinary
    expect(admin.calls.every((c) => c.type === "upload" || c.type === "authenticated")).toBe(true);
    expect(await snapshot()).toBe(before);
  });

  it("el informe y los logs no contienen publicId, userId ni URLs", async () => {
    const u = await user();
    await item(u.id, `ai-wardrobe/${u.id}/wardrobe/gone`);
    admin.pages.upload = [{ resources: [res(`ai-wardrobe/${u.id}/wardrobe/huerfana`, "upload")], next_cursor: "upload-c1" }, Object.assign(new Error(`fallo en ai-wardrobe/${u.id}/wardrobe/x https://res.cloudinary.com/demo`), { http_code: 500 })];
    paginate("authenticated", [res(`ai-wardrobe/${u.id}/try-on/huerfana`, "authenticated")]);
    const r = await detect();
    const out = JSON.stringify(r) + (errSpy.mock.calls as unknown[][]).flat().map(String).join("\n");
    expect(errSpy).toHaveBeenCalled(); // el inventario incompleto se registra…
    for (const s of [u.id, "ai-wardrobe/", "huerfana", "gone", "https://", "res.cloudinary.com"]) expect(out).not.toContain(s); // …sin datos
  });

  it("dos ejecuciones simultáneas: sin bloqueo necesario (solo lectura), mismos resultados y ninguna escritura", async () => {
    const u = await user();
    await item(u.id, `ai-wardrobe/${u.id}/wardrobe/w`);
    paginate("upload", [res(`ai-wardrobe/${u.id}/wardrobe/w`, "upload")], [res(`ai-wardrobe/${u.id}/wardrobe/o`, "upload")]);
    const [a, b] = await Promise.all([detect(), detect()]);
    const strip = (x: typeof a) => ({ ...x, durationMs: 0 });
    expect(strip(a)).toEqual(strip(b));
    expect(a.byCategory).toEqual({ ...ZERO, REFERENCED: 1, ORPHAN_CANDIDATE: 1 });
    expect(holder.writes).toEqual([]);
    expect(admin.mutations).toEqual([]);
  });
});

describe("H1: tiempo máximo por página (presupuesto global)", () => {
  it("una página colgada se aborta al agotarse el presupuesto → TIME_BUDGET, incompleto y sin esperar al proveedor", async () => {
    const u = await user();
    admin.pages.upload = [HANG];
    paginate("authenticated", [res(`ai-wardrobe/${u.id}/try-on/g`, "authenticated")]);
    const t0 = Date.now();
    const r = await detect({ budgetMs: 150 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(admin.aborted).toBe(1); // la petición recibió la cancelación
    expect(r.complete).toBe(false);
    expect(r.inventoryComplete).toEqual({ upload: false, authenticated: false }); // el presupuesto es global: ya no queda para el privado
    expect(r.errors).toEqual([{ stage: "inventory", scope: "upload", code: "TIME_BUDGET" }, { stage: "inventory", scope: "authenticated", code: "TIME_BUDGET" }]);
    expect(r.pages).toEqual({ upload: 0, authenticated: 0 });
    expect(r.brokenReferences.total).toBeNull();
  });

  it("colgada en la 2.ª página privada: lo público queda completo, lo privado incompleto; las rotas privadas no se afirman", async () => {
    const u = await user();
    await generated(u.id, `ai-wardrobe/${u.id}/try-on/gone`);
    paginate("upload", [res(`ai-wardrobe/${u.id}/wardrobe/w`, "upload")]);
    admin.pages.authenticated = [{ resources: [res(`ai-wardrobe/${u.id}/try-on/a`, "authenticated")], next_cursor: "authenticated-c1" }, HANG];
    const r = await detect({ budgetMs: 300 });
    expect(r.inventoryComplete).toEqual({ upload: true, authenticated: false });
    expect(r.complete).toBe(false);
    expect(r.errors).toEqual([{ stage: "inventory", scope: "authenticated", code: "TIME_BUDGET" }]);
    expect(r.brokenReferences).toEqual({ total: null, wardrobe: 0, personal: null, tryOn: null });
    expect(r.resourcesExamined).toBe(2); // lo leído se clasifica, pero el informe es parcial
  });

  it("aunque la petición no atienda la cancelación, el detector deja de esperarla y entrega el informe incompleto", async () => {
    admin.pages.upload = [IGNORE];
    const r = await detect({ budgetMs: 100 });
    expect(r.complete).toBe(false);
    expect(r.errors[0]).toEqual({ stage: "inventory", scope: "upload", code: "TIME_BUDGET" });
  });

  it("una respuesta que llega DESPUÉS del plazo se descarta (no se cuenta ni completa el inventario)", async () => {
    const u = await user();
    admin.pages.upload = [async () => { await new Promise((r) => setTimeout(r, 300)); return { resources: [res(`ai-wardrobe/${u.id}/wardrobe/w`, "upload")] }; }];
    const r = await detect({ budgetMs: 80 });
    await new Promise((r) => setTimeout(r, 350)); // la respuesta tardía llega y no altera nada
    expect(r.inventoryComplete.upload).toBe(false);
    expect(r.resourcesExamined).toBe(0);
    expect(r.pages.upload).toBe(0);
  });

  it("cada página recibe el tiempo RESTANTE del presupuesto, no uno nuevo", async () => {
    const slow = (ms: number, more: boolean) => async () => { await new Promise((r) => setTimeout(r, ms)); return { resources: [], ...(more ? { next_cursor: `upload-c${admin.calls.length}` } : {}) }; };
    admin.pages.upload = [slow(120, true), slow(120, true), slow(120, false)]; // cada una cabe sola; las tres juntas, no
    const r = await detect({ budgetMs: 300 });
    expect(r.inventoryComplete.upload).toBe(false);
    expect(r.pages.upload).toBe(2);
    expect(r.errors).toContainEqual({ stage: "inventory", scope: "upload", code: "TIME_BUDGET" });
  });

  it("el presupuesto por defecto deja al menos 60 s de reserva dentro de maxDuration", async () => {
    const { DEFAULT_BUDGET_MS } = await import("@/services/media-reconcile.service");
    const { maxDuration } = await import("@/app/api/cron/media-reconcile/route");
    expect(maxDuration * 1000 - DEFAULT_BUDGET_MS).toBeGreaterThanOrEqual(60_000);
  });
});

describe("H2: referencesOutsidePrefix", () => {
  it("se cuenta aunque el inventario esté incompleto (solo depende de PostgreSQL)", async () => {
    const u = await user(["demo/heredada-perfil"]);
    await item(u.id, "demo/heredada"); await item(u.id, "demo/heredada"); // compartida: cuenta una vez
    await generated(u.id, "otra/carpeta/g");
    admin.pages.upload = [new Error("caída")];
    const r = await detect();
    expect(r.complete).toBe(false);
    expect(r.brokenReferences.wardrobe).toBeNull();
    expect(r.referencesOutsidePrefix).toBe(3);
  });

  it.each(["wardrobeItem", "userProfile", "generatedImage"])("si falla la consulta de %s → null (nunca 0)", async (model) => {
    const u = await user(["demo/x"]);
    const real = t.prisma;
    holder.prisma = new Proxy(real, {
      get(target, prop) {
        if (prop === model) return { findMany: async (a: { where?: { sourcePhotoId?: unknown } }) => {
          if (model === "generatedImage" && a?.where?.sourcePhotoId) return []; // solo falla la consulta de publicId
          throw new Error("caída");
        } };
        const v = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as PrismaClient;
    try {
      const r = await detect();
      expect(r.referencesOutsidePrefix).toBeNull();
      expect(r.complete).toBe(false);
    } finally { holder.prisma = real; void u; }
  });
});

describe("endpoint /api/cron/media-reconcile", () => {
  const call = async (auth?: string, url = "http://localhost:3000/api/cron/media-reconcile") => {
    const { GET } = await import("@/app/api/cron/media-reconcile/route");
    return GET(new Request(url, { headers: auth ? { authorization: auth } : {} }));
  };

  it.each([
    ["sin cabecera", undefined],
    ["secreto incorrecto", "Bearer otro-secreto-de-prueba-01234"],
    ["sin Bearer", CRON_SECRET],
    ["Bearer vacío", "Bearer "],
  ])("%s → 401 y no consulta nada", async (_n, auth) => {
    const r = await call(auth);
    expect(r.status).toBe(401);
    expect(admin.calls).toEqual([]);
    expect(holder.writes).toEqual([]);
  });

  it("con CRON_SECRET → 200 con el informe agregado; los parámetros de la URL se ignoran (prefijo fijo)", async () => {
    const u = await user();
    paginate("upload", [res(`ai-wardrobe/${u.id}/wardrobe/o`, "upload")]);
    const r = await call(`Bearer ${CRON_SECRET}`, "http://localhost:3000/api/cron/media-reconcile?prefix=otra-app/&type=private&graceMs=0");
    expect(r.status).toBe(200);
    const body = await r.json() as Record<string, unknown>;
    expect(body).toMatchObject({ complete: true, resourcesExamined: 1, graceHours: 24, byCategory: { ORPHAN_CANDIDATE: 1 } });
    expect(JSON.stringify(body)).not.toContain(u.id);
    expect(admin.calls.map((c) => c.type)).toEqual(["upload", "authenticated"]);
  });
});

// ───────────────────────────── Fase 19.1: endurecimiento ─────────────────────────────

const url = (id: string, type = "upload", extra = "") => `https://res.cloudinary.com/demo/image/${type}/${extra}v1/${id}`;

describe("19.1 referencias por URL", () => {
  it("una URL propia (normal, transformada, versionada, con extensión o privada) protege su recurso aunque no haya publicId", async () => {
    const u = await user();
    const ids = ["w-img", "w-thumb", "w-ext", "g-url", "avatar", "cat", "shop"].map((n) => `ai-wardrobe/${u.id}/wardrobe/${n}`);
    const priv = `ai-wardrobe/${u.id}/try-on/g`;
    await t.prisma.wardrobeItem.create({ data: { userId: u.id, name: "Heredada", category: "OTHER", imageUrl: url(ids[0]!), thumbUrl: url(ids[1]!, "upload", "c_fill,g_auto,h_600,w_480/") } });
    await t.prisma.wardrobeItem.create({ data: { userId: u.id, name: "Heredada 2", category: "OTHER", imageUrl: `${url(ids[2]!)}.jpg` } });
    await t.prisma.generatedImage.create({ data: { userId: u.id, scenario: "x", pose: "y", status: "COMPLETED", imageUrl: url(ids[3]!) } });
    await t.prisma.generatedImage.create({ data: { userId: u.id, scenario: "x", pose: "y", status: "COMPLETED", imageUrl: `https://api.cloudinary.com/v1_1/demo/image/download?public_id=${encodeURIComponent(priv)}&type=authenticated` } });
    await t.prisma.user.update({ where: { id: u.id }, data: { image: url(ids[4]!) } });
    await t.prisma.catalogProduct.create({ data: { id: `c${Math.random().toString(36).slice(2)}`, provider: "p", feedId: "f", externalId: "e", store: "s", name: "n", category: "OTHER", priceCents: 1, imageUrl: url(ids[5]!), url: "https://tienda.example/p" } });
    const rec = await t.prisma.shoppingRecommendation.create({ data: { userId: u.id, batchId: "b", gapLabel: "g", gapReason: "r", searchQuery: "q" } });
    await t.prisma.shoppingProduct.create({ data: { recommendationId: rec.id, provider: "p", externalId: "e", name: "n", store: "s", url: "https://tienda.example/p", imageUrl: url(ids[6]!) } });
    paginate("upload", ids.map((id) => res(id, "upload")));
    paginate("authenticated", [res(priv, "authenticated")]);
    const r = await detect();
    expect(r.complete).toBe(true);
    expect(counts(r)).toEqual({ ...ZERO, REFERENCED: 8 });
    expect(r.protection.referencedByUrlOnly).toBe(8);
    expect(r.urlReferences).toEqual({ scanned: 8, own: 8, ownOutsidePrefix: 0, external: 0, ambiguous: 0 });
  });

  it("URLs externas (otra cuenta con la misma ruta, tiendas, avatares) no protegen nada", async () => {
    const u = await user();
    const id = `ai-wardrobe/${u.id}/wardrobe/w`;
    await t.prisma.wardrobeItem.create({ data: { userId: u.id, name: "x", category: "OTHER", imageUrl: `https://res.cloudinary.com/otra-cuenta/image/upload/v1/${id}` } });
    await t.prisma.user.update({ where: { id: u.id }, data: { image: "https://lh3.googleusercontent.com/a/x=s96-c" } });
    await t.prisma.catalogProduct.create({ data: { id: `c${Math.random().toString(36).slice(2)}`, provider: "p", feedId: "f", externalId: "e2", store: "s", name: "n", category: "OTHER", priceCents: 1, imageUrl: "https://cdn.tienda.example/a.jpg", url: "https://tienda.example/p" } });
    paginate("upload", [res(id, "upload")]);
    const r = await detect();
    expect(counts(r)).toEqual({ ...ZERO, ORPHAN_CANDIDATE: 1 });
    expect(r.urlReferences).toEqual({ scanned: 3, own: 0, ownOutsidePrefix: 0, external: 3, ambiguous: 0 }); // D5: el catálogo se lee entero
  });

  it("URL propia ambigua con propietario → lo NO referenciado de ese propietario queda INCOMPLETE; el resto de usuarios no se ve afectado", async () => {
    const a = await user(); const b = await user();
    await t.prisma.wardrobeItem.create({ data: { userId: a.id, name: "x", category: "OTHER", imageUrl: `https://res.cloudinary.com/demo/image/upload/carpeta-rara/ai-wardrobe/${a.id}/wardrobe/x` } });
    const refd = `ai-wardrobe/${a.id}/wardrobe/ref`;
    await item(a.id, refd);
    paginate("upload", [res(`ai-wardrobe/${a.id}/wardrobe/o`, "upload"), res(refd, "upload"), res(`ai-wardrobe/${b.id}/wardrobe/o`, "upload")]);
    const r = await detect();
    expect(counts(r)).toEqual({ ...ZERO, REFERENCED: 1, INCOMPLETE: 1, ORPHAN_CANDIDATE: 1 });
    expect(r.protection.ambiguousUrl).toBe(1);
    expect(r.urlReferences?.ambiguous).toBe(1);
    expect(r.complete).toBe(true); // la ambigüedad protege, no es un error
  });

  it("URL ambigua sin propietario identificable → nada sin referencia puede salir candidato", async () => {
    const a = await user(); const b = await user();
    await t.prisma.user.update({ where: { id: a.id }, data: { image: "https://img.example.com/ai-wardrobe/_quarantine/wardrobe/x" } });
    paginate("upload", [res(`ai-wardrobe/${a.id}/wardrobe/o`, "upload"), res(`ai-wardrobe/${b.id}/wardrobe/o`, "upload")]);
    const r = await detect();
    expect(counts(r)).toEqual({ ...ZERO, INCOMPLETE: 2 });
    expect(r.protection.ambiguousUrl).toBe(2);
  });

  it("si falla la lectura de URLs → nada sin publicId sale candidato y el informe es incompleto", async () => {
    const u = await user();
    paginate("upload", [res(`ai-wardrobe/${u.id}/wardrobe/o`, "upload")]);
    const real = t.prisma;
    holder.prisma = new Proxy(real, {
      get(target, prop) {
        if (prop === "catalogProduct") return { findMany: async () => { throw new Error("caída"); } };
        const v = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as PrismaClient;
    try {
      const r = await detect();
      expect(counts(r)).toEqual({ ...ZERO, INCOMPLETE: 1 });
      expect(r.urlReferences).toBeNull();
      expect(r.errors).toEqual([{ stage: "database", scope: "urls", code: "DB_ERROR" }]);
      expect(r.complete).toBe(false);
    } finally { holder.prisma = real; }
  });

  it("los campos históricos no se modifican y el informe no contiene las URLs", async () => {
    const u = await user();
    const id = `ai-wardrobe/${u.id}/wardrobe/w`;
    const row = await t.prisma.wardrobeItem.create({ data: { userId: u.id, name: "x", category: "OTHER", imageUrl: url(id), thumbUrl: url(id) } });
    paginate("upload", [res(id, "upload")]);
    const r = await detect();
    expect(await t.prisma.wardrobeItem.findUnique({ where: { id: row.id } })).toEqual(row);
    expect(holder.writes).toEqual([]);
    expect(JSON.stringify(r)).not.toMatch(/https?:|ai-wardrobe\//);
  });
});

describe("19.1 inventario incompleto: nada avanza como candidato", () => {
  it("una página recibida con cursor y la siguiente sin llegar → INCOMPLETE; ningún ORPHAN_CANDIDATE en NINGÚN tipo", async () => {
    const u = await user();
    paginate("authenticated", [res(`ai-wardrobe/${u.id}/try-on/a`, "authenticated")]); // completo
    admin.pages.upload = [{ resources: [res(`ai-wardrobe/${u.id}/wardrobe/a`, "upload")], next_cursor: "upload-c1" }, new Error("x")];
    const r = await detect();
    expect(r.inventoryStatus).toBe("INCOMPLETE");
    expect(r.inventoryComplete).toEqual({ upload: false, authenticated: true });
    expect(r.byCategory.ORPHAN_CANDIDATE).toBe(0);
    expect(r.candidatesWithheld).toBe(2);
  });

  it("recursos recientes y referenciados se siguen clasificando igual; solo se retienen los que habrían sido candidatos", async () => {
    const u = await user();
    const refd = `ai-wardrobe/${u.id}/wardrobe/r`;
    await item(u.id, refd);
    admin.pages.upload = [{ resources: [res(refd, "upload"), res(`ai-wardrobe/${u.id}/wardrobe/n`, "upload", RECENT), res(`ai-wardrobe/${u.id}/wardrobe/o`, "upload")], next_cursor: "upload-c1" }, new Error("x")];
    const r = await detect();
    expect(counts(r)).toEqual({ ...ZERO, REFERENCED: 1, TOO_RECENT: 1, INCOMPLETE: 1 });
    expect(r.candidatesWithheld).toBe(1);
  });

  it.each([
    ["recurso sin public_id", { created_at: OLD }, "MALFORMED_RESOURCE"],
    ["recurso que no es un objeto", "basura", "MALFORMED_RESOURCE"],
    ["type que no es texto", { public_id: "ai-wardrobe/u/wardrobe/x", type: 3 }, "MALFORMED_RESOURCE"],
    ["otro tipo de entrega", { public_id: "ai-wardrobe/u/wardrobe/x", type: "private" }, "UNEXPECTED_RESOURCE"],
    ["no es una imagen", { public_id: "ai-wardrobe/u/wardrobe/x", type: "upload", resource_type: "video" }, "UNEXPECTED_RESOURCE"],
    ["fuera del prefijo pedido", { public_id: "otra-app/u/wardrobe/x", type: "upload" }, "UNEXPECTED_RESOURCE"],
  ])("página bien recibida pero con un %s → inventario incompleto (una sola vez por código) y sin candidatos", async (_n, bad, code) => {
    const u = await user();
    paginate("upload", [bad, res(`ai-wardrobe/${u.id}/wardrobe/o`, "upload"), bad]);
    const r = await detect();
    expect(r.inventoryComplete.upload).toBe(false);
    expect(r.errors).toEqual([{ stage: "inventory", scope: "upload", code }]);
    expect(counts(r)).toEqual({ ...ZERO, UNKNOWN: 2, INCOMPLETE: 1 });
    expect(r.candidatesWithheld).toBe(1);
  });
});

describe("19.1 metadatos de Cloudinary", () => {
  it("respuesta completa: se cuentan todos los metadatos", async () => {
    const u = await user();
    paginate("upload", [res(`ai-wardrobe/${u.id}/wardrobe/a`, "upload"), res(`ai-wardrobe/${u.id}/wardrobe/b`, "upload")]);
    const r = await detect();
    expect(r.metadata).toEqual({ assetId: 2, version: 2, createdAt: 2, bytes: 2, format: 2 });
    expect(counts(r)).toEqual({ ...ZERO, ORPHAN_CANDIDATE: 2 });
  });

  it("sin asset_id → INCOMPLETE; version/bytes/format inválidos solo quedan en null (son informativos)", async () => {
    const u = await user();
    const { asset_id: _drop, ...noAsset } = res(`ai-wardrobe/${u.id}/wardrobe/a`, "upload");
    const weird = { ...res(`ai-wardrobe/${u.id}/wardrobe/b`, "upload"), version: "7", bytes: -1, format: "" };
    paginate("upload", [noAsset, weird]);
    const r = await detect();
    expect(r.metadata).toEqual({ assetId: 1, version: 1, createdAt: 2, bytes: 1, format: 1 });
    expect(counts(r)).toEqual({ ...ZERO, INCOMPLETE: 1, ORPHAN_CANDIDATE: 1 });
    expect(r.protection.missingMetadata).toBe(1);
  });

  it("normalizeResource conserva los valores tal cual y no inventa los ausentes", async () => {
    const { normalizeResource } = await import("@/services/media-reconcile.service");
    const full = { public_id: "ai-wardrobe/u/wardrobe/x", asset_id: "0123456789abcdef0123456789abcdef", version: 17, created_at: OLD, bytes: 0, format: "webp", resource_type: "image", type: "upload" };
    expect(normalizeResource(full, "upload")).toEqual({ ok: true, item: { publicId: full.public_id, delivery: "upload", assetId: full.asset_id, version: 17, createdAt: new Date(OLD), bytes: 0, format: "webp", resourceType: "image", type: "upload" } });
    expect(normalizeResource({ public_id: "ai-wardrobe/u/wardrobe/x" }, "authenticated")).toEqual({ ok: true, item: { publicId: "ai-wardrobe/u/wardrobe/x", delivery: "authenticated", assetId: null, version: null, createdAt: null, bytes: null, format: null, resourceType: null, type: null } });
    expect(normalizeResource({ ...full, version: 1.5, bytes: "3", asset_id: "", created_at: "x" }, "upload")).toMatchObject({ ok: true, item: { version: null, bytes: null, assetId: null, createdAt: null } });
    expect(normalizeResource(null, "upload")).toEqual({ ok: false, code: "MALFORMED_RESOURCE" });
    expect(normalizeResource([full], "upload")).toEqual({ ok: false, code: "MALFORMED_RESOURCE" });
    expect(normalizeResource({ ...full, public_id: "" }, "upload")).toEqual({ ok: false, code: "MALFORMED_RESOURCE" });
    expect(normalizeResource({ ...full, resource_type: 1 }, "upload")).toEqual({ ok: false, code: "MALFORMED_RESOURCE" });
    expect(normalizeResource(full, "authenticated")).toEqual({ ok: false, code: "UNEXPECTED_RESOURCE" });
  });
});

describe("19.1 cuarentena (solo reconocimiento)", () => {
  it("ai-wardrobe/<userId>/_quarantine/<tipo>/<nombre> → QUARANTINED, nunca huérfana aunque sea antigua y sin referencia", async () => {
    const u = await user();
    const q = (k: string) => `ai-wardrobe/${u.id}/_quarantine/${k}/x`;
    paginate("upload", [res(q("wardrobe"), "upload")]);
    paginate("authenticated", [res(q("personal"), "authenticated"), res(q("try-on"), "authenticated"), res(q("wardrobe"), "authenticated")]);
    const r = await detect();
    expect(counts(r)).toEqual({ ...ZERO, QUARANTINED: 4 });
    expect(r.quarantine).toEqual({ wardrobe: 2, personal: 1, tryOn: 1, publicDelivery: 1 });
    expect(r.byKind).toEqual({ wardrobe: 0, personal: 0, tryOn: 0, unknown: 0, quarantine: 4 });
    expect(r.complete).toBe(true);
  });

  it("rutas de cuarentena mal formadas o carpetas reservadas como propietario → UNKNOWN (nunca candidatas)", async () => {
    const u = await user();
    paginate("upload", [
      res(`ai-wardrobe/${u.id}/_quarantine/otros/x`, "upload"), res(`ai-wardrobe/${u.id}/_quarantine/wardrobe/sub/x`, "upload"),
      res(`ai-wardrobe/${u.id}/_quarantine/x`, "upload"), res("ai-wardrobe/_quarantine/wardrobe/x", "upload"), res("ai-wardrobe/_x/wardrobe/y", "upload"),
    ]);
    expect(counts(await detect())).toEqual({ ...ZERO, UNKNOWN: 5 });
  });
});

describe("19.1 periodo de gracia mínimo", () => {
  it("effectiveGraceMs: por defecto 24 h; nunca menos de 1 h; valores no numéricos → por defecto", async () => {
    const { effectiveGraceMs, MIN_GRACE_MS, DEFAULT_GRACE_MS } = await import("@/services/media-reconcile.service");
    expect(DEFAULT_GRACE_MS).toBe(24 * 3_600_000);
    expect(MIN_GRACE_MS).toBe(3_600_000);
    expect(effectiveGraceMs()).toBe(DEFAULT_GRACE_MS);
    for (const g of [0, -1, 1000, 3_599_999]) expect(effectiveGraceMs(g)).toBe(MIN_GRACE_MS);
    for (const g of [Number.NaN, Number.POSITIVE_INFINITY]) expect(effectiveGraceMs(g)).toBe(DEFAULT_GRACE_MS);
    expect(effectiveGraceMs(48 * 3_600_000)).toBe(48 * 3_600_000);
  });

  it("graceMs: 0 no hace candidato un recurso de 30 min; sí uno de 2 h", async () => {
    const u = await user();
    const at = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
    paginate("upload", [res(`ai-wardrobe/${u.id}/wardrobe/a`, "upload", at(30 * 60_000)), res(`ai-wardrobe/${u.id}/wardrobe/b`, "upload", at(2 * 3_600_000))]);
    const r = await detect({ graceMs: 0 });
    expect(r.graceHours).toBe(1);
    expect(counts(r)).toEqual({ ...ZERO, TOO_RECENT: 1, ORPHAN_CANDIDATE: 1 });
  });
});

describe("19.1 cuota de la Admin API", () => {
  it("se toma de la ÚLTIMA respuesta correcta (campos rate_limit_* del SDK; reset_at como Date o texto)", async () => {
    admin.pages.upload = [{ resources: [], next_cursor: "upload-c1", rate_limit_allowed: 500, rate_limit_remaining: 499, rate_limit_reset_at: new Date("2026-11-21T13:00:00Z") }, { resources: [], rate_limit_allowed: 500, rate_limit_remaining: 498, rate_limit_reset_at: "2026-11-21T13:00:00Z" }];
    admin.pages.authenticated = [{ resources: [], rate_limit_allowed: 500, rate_limit_remaining: 497, rate_limit_reset_at: new Date("2026-11-21T13:00:00Z") }];
    const r = await detect();
    expect(r.rateLimit).toEqual({ allowed: 500, remaining: 497, resetAt: "2026-11-21T13:00:00.000Z" });
  });

  it("sin esos campos → null; valores inválidos → null por campo (no se inventan); un error posterior no la borra", async () => {
    expect((await detect()).rateLimit).toBeNull();
    admin.pages.upload = [{ resources: [], next_cursor: "upload-c1", rate_limit_allowed: Number.NaN, rate_limit_remaining: 10, rate_limit_reset_at: "no-es-fecha" }, Object.assign(new Error("x"), { http_code: 420 })];
    const r = await detect();
    expect(r.rateLimit).toEqual({ allowed: null, remaining: 10, resetAt: null });
    expect(r.errors).toContainEqual({ stage: "inventory", scope: "upload", code: "CLOUDINARY_420" });
  });
});

// ───────────────────────────── Fase 19.1.2: regresiones D1–D5 ─────────────────────────────

describe("19.1.2 D1: URL problemática guardada en la base de datos", () => {
  it.each([
    ["res: barras codificadas + % roto en el query", (o: string) => `https://res.cloudinary.com/demo/image/upload/ai-wardrobe%2F${o}%2Fwardrobe%2Fx?_a=%ZZ`],
    ["CDN: barras codificadas + % roto", (o: string) => `https://cdn.example.com/ai-wardrobe%2F${o}%2Fwardrobe%2Fx?_a=%ZZ`],
    ["api: public_id con % roto", (o: string) => `https://api.cloudinary.com/v1_1/demo/image/download?public_id=ai-wardrobe%2F${o}%2Fwardrobe%2Fx%ZZ`],
  ])("%s en WardrobeItem.imageUrl → el recurso posiblemente referenciado NO es candidato; otro usuario no se ve afectado", async (_n, make) => {
    const a = await user(); const b = await user();
    await t.prisma.wardrobeItem.create({ data: { userId: a.id, name: "Heredada", category: "OTHER", imageUrl: make(a.id) } });
    paginate("upload", [res(`ai-wardrobe/${a.id}/wardrobe/x`, "upload"), res(`ai-wardrobe/${b.id}/wardrobe/x`, "upload")]);
    const r = await detect();
    expect(r.complete).toBe(true);
    expect(counts(r)).toEqual({ ...ZERO, INCOMPLETE: 1, ORPHAN_CANDIDATE: 1 });
    expect(r.protection.ambiguousUrl).toBe(1);
    expect(r.urlReferences).toMatchObject({ ambiguous: 1, external: 0, ownOutsidePrefix: 0 });
  });

  it("URL de nuestra cuenta no interpretable y sin indicios → protección global (ningún candidato)", async () => {
    const a = await user(); const b = await user();
    await t.prisma.user.update({ where: { id: a.id }, data: { image: "https://res.cloudinary.com/demo/video/upload/sample?_a=%ZZ" } });
    paginate("upload", [res(`ai-wardrobe/${a.id}/wardrobe/x`, "upload"), res(`ai-wardrobe/${b.id}/wardrobe/x`, "upload")]);
    const r = await detect();
    expect(counts(r)).toEqual({ ...ZERO, INCOMPLETE: 2 });
  });

  it("con protección global, lo referenciado sigue REFERENCED y la cuarentena sigue QUARANTINED", async () => {
    const u = await user();
    const refd = `ai-wardrobe/${u.id}/wardrobe/r`;
    await item(u.id, refd);
    await t.prisma.user.update({ where: { id: u.id }, data: { image: "https://img.example.com/ai-wardrobe/_x/y" } });
    paginate("upload", [res(refd, "upload"), res(`ai-wardrobe/${u.id}/wardrobe/o`, "upload")]);
    paginate("authenticated", [res(`ai-wardrobe/${u.id}/_quarantine/personal/q`, "authenticated")]);
    const r = await detect();
    expect(counts(r)).toEqual({ ...ZERO, REFERENCED: 1, INCOMPLETE: 1, QUARANTINED: 1 });
  });
});

describe("19.1.2 D2: created_at estricto (ISO 8601 UTC con Z)", () => {
  it.each([
    ["1"], ["0"], ["2026"], ["Nov 1"], ["2026-11-18T12:00:00"], [" 2026-11-18T12:00:00Z"], ["2026-11-18T12:00:00Z "],
    ["2026-02-30T12:00:00Z"], ["2026-13-01T00:00:00Z"], ["2026-11-18T24:00:00Z"], ["2026-11-18T12:60:00Z"], ["2026-11-18T12:00:60Z"],
    ["2026-11-18T12:00:00+00:00"], ["2026-11-18 12:00:00Z"], ["2026-11-18"], ["0050-01-01T00:00:00Z"], ["2026-11-18T12:00:00.Z"],
  ])("%j → INCOMPLETE (nunca candidato)", async (createdAt) => {
    const u = await user();
    paginate("upload", [{ ...res(`ai-wardrobe/${u.id}/wardrobe/a`, "upload"), created_at: createdAt }]);
    const r = await detect();
    expect(counts(r)).toEqual({ ...ZERO, INCOMPLETE: 1 });
    expect(r.protection.missingMetadata).toBe(1);
  });

  it.each([["2026-11-18T12:00:00Z"], ["2026-11-18T12:00:00.123Z"], ["2026-11-18T12:00:00.1Z"], ["2024-02-29T23:59:59.999999Z"]])("%j válido → se acepta", async (createdAt) => {
    const u = await user();
    paginate("upload", [{ ...res(`ai-wardrobe/${u.id}/wardrobe/a`, "upload"), created_at: createdAt }]);
    expect(counts(await detect())).toEqual({ ...ZERO, ORPHAN_CANDIDATE: 1 });
  });

  it("parseUtcTimestamp conserva los milisegundos y rechaza lo que new Date() aceptaría", async () => {
    const { parseUtcTimestamp } = await import("@/services/media-reconcile.service");
    expect(parseUtcTimestamp("2026-11-18T12:00:00.123Z")?.toISOString()).toBe("2026-11-18T12:00:00.123Z");
    expect(parseUtcTimestamp("2026-11-18T12:00:00Z")?.toISOString()).toBe("2026-11-18T12:00:00.000Z");
    for (const v of ["1", "Nov 1", "2026", 1732190000, null, undefined, new Date()]) expect(parseUtcTimestamp(v)).toBeNull();
  });
});

describe("19.1.2 D3: metadatos obligatorios", () => {
  it.each([
    ["sin type", { type: undefined }],
    ["sin resource_type", { resource_type: undefined }],
    ["sin ninguno de los dos", { type: undefined, resource_type: undefined }],
    ["asset_id vacío", { asset_id: "" }],
    ["asset_id con espacio inicial", { asset_id: " 0123456789abcdef0123456789abcdef" }],
    ["asset_id de 129 caracteres", { asset_id: "a".repeat(129) }],
    ["asset_id que no es texto", { asset_id: 123 }],
  ])("%s → INCOMPLETE (nunca se rellena con lo pedido al endpoint)", async (_n, patch) => {
    const u = await user();
    paginate("upload", [{ ...res(`ai-wardrobe/${u.id}/wardrobe/a`, "upload"), ...patch }]);
    const r = await detect();
    expect(counts(r)).toEqual({ ...ZERO, INCOMPLETE: 1 });
    expect(r.protection.missingMetadata).toBe(1);
  });

  it("normalizeResource deja type y resource_type en null cuando no vienen", async () => {
    const { normalizeResource } = await import("@/services/media-reconcile.service");
    const n = normalizeResource({ public_id: "ai-wardrobe/u/wardrobe/x", asset_id: "0123456789abcdef0123456789abcdef", created_at: OLD }, "upload");
    expect(n).toMatchObject({ ok: true, item: { type: null, resourceType: null, delivery: "upload" } });
  });
});

describe("19.1.2 D4: varios propietarios en una URL ambigua", () => {
  it("se protegen los recursos no referenciados de TODOS los propietarios mencionados", async () => {
    const a = await user(); const b = await user(); const c = await user();
    await t.prisma.user.update({ where: { id: c.id }, data: { image: `https://img.example.com/ai-wardrobe/${a.id}/x?also=ai-wardrobe/${b.id}/y` } });
    paginate("upload", [a, b, c].map((x) => res(`ai-wardrobe/${x.id}/wardrobe/o`, "upload")));
    const r = await detect();
    expect(counts(r)).toEqual({ ...ZERO, INCOMPLETE: 2, ORPHAN_CANDIDATE: 1 });
    expect(r.protection.ambiguousUrl).toBe(2);
  });
});

describe("19.1.2 D5: compras y catálogo se leen sin filtro de texto", () => {
  it.each([
    ["host codificado", (id: string) => `https://res.cloudin%61ry.com/demo/image/upload/v1/${id}`, "REFERENCED"],
    ["host en mayúsculas", (id: string) => `https://RES.CLOUDINARY.COM/demo/image/upload/v1/${id}`, "REFERENCED"],
    ["carpeta codificada en un CDN", (id: string) => `https://cdn.tienda.example/${id.replace("ai-wardrobe", "ai%2Dwardrobe")}`, "INCOMPLETE"],
  ])("%s en CatalogProduct y ShoppingProduct → protege el recurso", async (_n, make, category) => {
    const u = await user();
    const ids = [`ai-wardrobe/${u.id}/wardrobe/cat`, `ai-wardrobe/${u.id}/wardrobe/shop`];
    await t.prisma.catalogProduct.create({ data: { id: `c${Math.random().toString(36).slice(2)}`, provider: "p", feedId: "f", externalId: "e", store: "s", name: "n", category: "OTHER", priceCents: 1, imageUrl: make(ids[0]!), url: "https://tienda.example/p" } });
    const rec = await t.prisma.shoppingRecommendation.create({ data: { userId: u.id, batchId: "b", gapLabel: "g", gapReason: "r", searchQuery: "q" } });
    await t.prisma.shoppingProduct.create({ data: { recommendationId: rec.id, provider: "p", externalId: "e", name: "n", store: "s", url: "https://tienda.example/p", imageUrl: make(ids[1]!) } });
    paginate("upload", ids.map((id) => res(id, "upload")));
    const r = await detect();
    expect(r.byCategory.ORPHAN_CANDIDATE).toBe(0);
    expect(r.byCategory[category as "REFERENCED" | "INCOMPLETE"]).toBe(2);
  });
});

describe("19.1.2 huecos de la auditoría", () => {
  it("solo falla la consulta informativa sourcePhoto → inventario COMPLETE, informe NO completo y candidatos retenidos", async () => {
    const u = await user();
    paginate("upload", [res(`ai-wardrobe/${u.id}/wardrobe/o`, "upload")]);
    const real = t.prisma;
    holder.prisma = new Proxy(real, {
      get(target, prop) {
        if (prop === "generatedImage") return { findMany: async (a: { where?: { sourcePhotoId?: unknown } }) => {
          if (a?.where?.sourcePhotoId) throw new Error("caída");
          return real.generatedImage.findMany(a as never);
        } };
        const v = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as PrismaClient;
    try {
      const r = await detect();
      expect(r.inventoryStatus).toBe("COMPLETE");
      expect(r.complete).toBe(false);
      expect(r.errors).toEqual([{ stage: "database", scope: "sourcePhoto", code: "DB_ERROR" }]);
      expect(counts(r)).toEqual({ ...ZERO, INCOMPLETE: 1 });
      expect(r.candidatesWithheld).toBe(1);
    } finally { holder.prisma = real; }
  });
});

// ───────────────────────────── Fase 19.1.4: N1 y cobertura adicional ─────────────────────────────

describe("19.1.4 cobertura adicional del detector", () => {
  it("N1 de extremo a extremo: byte UTF-8 inválido junto a caracteres codificados en WardrobeItem.imageUrl → su propietario queda protegido", async () => {
    const a = await user(); const b = await user();
    await t.prisma.wardrobeItem.create({ data: { userId: a.id, name: "x", category: "OTHER", imageUrl: `https://cdn.example.com/ai-wardrob%65%2F${a.id}%2F%FF/x` } });
    paginate("upload", [res(`ai-wardrobe/${a.id}/wardrobe/o`, "upload"), res(`ai-wardrobe/${b.id}/wardrobe/o`, "upload")]);
    const r = await detect();
    expect(counts(r)).toEqual({ ...ZERO, INCOMPLETE: 1, ORPHAN_CANDIDATE: 1 });
    expect(r.protection.ambiguousUrl).toBe(1);
  });

  it("N1: mención con byte inválido sin propietario acotable → protección global (ningún candidato)", async () => {
    const a = await user(); const b = await user();
    await t.prisma.user.update({ where: { id: a.id }, data: { image: "https://cdn.example.com/ai-wardrobe%2F%FFcmowner/x" } });
    paginate("upload", [res(`ai-wardrobe/${a.id}/wardrobe/o`, "upload"), res(`ai-wardrobe/${b.id}/wardrobe/o`, "upload")]);
    expect(counts(await detect())).toEqual({ ...ZERO, INCOMPLETE: 2 });
  });

  it("una referencia EXACTA por URL prevalece sobre la protección global", async () => {
    const u = await user();
    const exact = `ai-wardrobe/${u.id}/wardrobe/exacta`;
    await t.prisma.wardrobeItem.create({ data: { userId: u.id, name: "Heredada", category: "OTHER", imageUrl: `https://res.cloudinary.com/demo/image/upload/v1/${exact}` } });
    await t.prisma.user.update({ where: { id: u.id }, data: { image: "https://img.example.com/ai-wardrobe/_x/y" } }); // global
    paginate("upload", [res(exact, "upload"), res(`ai-wardrobe/${u.id}/wardrobe/otra`, "upload")]);
    const r = await detect();
    expect(counts(r)).toEqual({ ...ZERO, REFERENCED: 1, INCOMPLETE: 1 });
    expect(r.protection).toMatchObject({ referencedByUrlOnly: 1, ambiguousUrl: 1 });
  });

  it("un indicio de propietario SOLO en el fragmento protege a ese propietario (y no a otros)", async () => {
    const a = await user(); const b = await user();
    await t.prisma.user.update({ where: { id: b.id }, data: { image: `https://img.example.com/foto.jpg#ai-wardrobe/${a.id}/x` } });
    paginate("upload", [res(`ai-wardrobe/${a.id}/wardrobe/o`, "upload"), res(`ai-wardrobe/${b.id}/wardrobe/o`, "upload")]);
    const r = await detect();
    expect(counts(r)).toEqual({ ...ZERO, INCOMPLETE: 1, ORPHAN_CANDIDATE: 1 });
    expect(r.protection.ambiguousUrl).toBe(1);
  });

  it.each([
    ["usuario:contraseña", (id: string) => `https://ai-wardrobe:${id}@img.example.com/foto.jpg`],
    ["usuario con barra codificada", (id: string) => `https://ai-wardrobe%2F${id}@img.example.com/foto.jpg`],
  ])("un indicio de propietario SOLO en las credenciales (%s) protege a ese propietario", async (_n, make) => {
    const a = await user(); const b = await user();
    await t.prisma.user.update({ where: { id: b.id }, data: { image: make(a.id) } });
    paginate("upload", [res(`ai-wardrobe/${a.id}/wardrobe/o`, "upload"), res(`ai-wardrobe/${b.id}/wardrobe/o`, "upload")]);
    const r = await detect();
    expect(counts(r)).toEqual({ ...ZERO, INCOMPLETE: 1, ORPHAN_CANDIDATE: 1 });
  });

  it("fallo aislado de ShoppingProduct → ningún candidato; URLs desconocidas; inventario COMPLETE pero informe no completo", async () => {
    const u = await user();
    const refd = `ai-wardrobe/${u.id}/wardrobe/r`;
    await item(u.id, refd);
    paginate("upload", [res(refd, "upload"), res(`ai-wardrobe/${u.id}/wardrobe/o`, "upload")]);
    const real = t.prisma;
    holder.prisma = new Proxy(real, {
      get(target, prop) {
        if (prop === "shoppingProduct") return { findMany: async () => { throw new Error("caída"); } };
        const v = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as PrismaClient;
    try {
      const r = await detect();
      expect(counts(r)).toEqual({ ...ZERO, REFERENCED: 1, INCOMPLETE: 1 });
      expect(r.byCategory.ORPHAN_CANDIDATE).toBe(0);
      expect(r.urlReferences).toBeNull();
      expect(r.errors).toEqual([{ stage: "database", scope: "urls", code: "DB_ERROR" }]);
      expect(r.inventoryStatus).toBe("COMPLETE");
      expect(r.complete).toBe(false);
      expect(r.candidatesWithheld).toBe(0); // quedó INCOMPLETE antes (URLs desconocidas): no es un contador exhaustivo
    } finally { holder.prisma = real; }
  });
});

// ───────────────────────────── Fase 19.1.6: I1 y M1 ─────────────────────────────

describe("19.1.6 I1 y M1 en el detector", () => {
  it("URL exacta con A en la ruta y B en las credenciales (WardrobeItem.imageUrl) → A y B protegidos; C sigue candidato", async () => {
    const a = await user(); const b = await user(); const c = await user();
    await t.prisma.wardrobeItem.create({ data: { userId: a.id, name: "x", category: "OTHER", imageUrl: `https://ai-wardrobe:${b.id}@res.cloudinary.com/demo/image/upload/v1/ai-wardrobe/${a.id}/wardrobe/x` } });
    paginate("upload", [res(`ai-wardrobe/${a.id}/wardrobe/x`, "upload"), res(`ai-wardrobe/${b.id}/wardrobe/o`, "upload"), res(`ai-wardrobe/${c.id}/wardrobe/o`, "upload")]);
    const r = await detect();
    expect(counts(r)).toEqual({ ...ZERO, INCOMPLETE: 2, ORPHAN_CANDIDATE: 1 });
    expect(r.protection).toMatchObject({ referencedByUrlOnly: 0, ambiguousUrl: 2 });
    expect(r.urlReferences).toMatchObject({ own: 0, ambiguous: 1 });
  });

  it("descarga exacta con A en public_id y B en el fragmento (GeneratedImage.imageUrl) → A y B protegidos; C sigue candidato", async () => {
    const a = await user(); const b = await user(); const c = await user();
    await t.prisma.generatedImage.create({ data: { userId: a.id, scenario: "x", pose: "y", status: "COMPLETED", imageUrl: `https://api.cloudinary.com/v1_1/demo/image/download?public_id=ai-wardrobe%2F${a.id}%2Ftry-on%2Fg&type=authenticated#ai-wardrobe/${b.id}/y` } });
    paginate("authenticated", [res(`ai-wardrobe/${a.id}/try-on/g`, "authenticated"), res(`ai-wardrobe/${b.id}/try-on/o`, "authenticated"), res(`ai-wardrobe/${c.id}/try-on/o`, "authenticated")]);
    const r = await detect();
    expect(counts(r)).toEqual({ ...ZERO, INCOMPLETE: 2, ORPHAN_CANDIDATE: 1 });
    expect(r.protection.ambiguousUrl).toBe(2);
  });

  it("M1: propietario truncado por un byte inválido → protección global (no solo el prefijo)", async () => {
    const a = await user(); const b = await user();
    // Mención de `a` con un byte inválido pegado: el propietario completo no es identificable.
    await t.prisma.user.update({ where: { id: b.id }, data: { image: `https://cdn.example.com/ai-wardrobe/${a.id}%FF/wardrobe/x` } });
    paginate("upload", [res(`ai-wardrobe/${a.id}/wardrobe/o`, "upload"), res(`ai-wardrobe/${b.id}/wardrobe/o`, "upload")]);
    const r = await detect();
    expect(counts(r)).toEqual({ ...ZERO, INCOMPLETE: 2 });
    expect(r.protection.ambiguousUrl).toBe(2);
  });

  it("M1: propietario completo seguido de un separador → protección específica (el otro usuario sigue candidato)", async () => {
    const a = await user(); const b = await user();
    await t.prisma.user.update({ where: { id: b.id }, data: { image: `https://cdn.example.com/ai-wardrobe/${a.id}/%FF/x` } });
    paginate("upload", [res(`ai-wardrobe/${a.id}/wardrobe/o`, "upload"), res(`ai-wardrobe/${b.id}/wardrobe/o`, "upload")]);
    expect(counts(await detect())).toEqual({ ...ZERO, INCOMPLETE: 1, ORPHAN_CANDIDATE: 1 });
  });
});

// ───────────────────────────── Fase 19.2.0: asset_id opaco ─────────────────────────────

describe("19.2.0 asset_id como identificador opaco", () => {
  it.each([
    ["hexadecimal de 32 en minúscula", "0123456789abcdef0123456789abcdef"],
    ["hexadecimal en mayúsculas", "0123456789ABCDEF0123456789ABCDEF"],
    ["corto", "abc"],
    ["33 caracteres", "0123456789abcdef0123456789abcdef0"],
    ["UUID con guiones", "123e4567-e89b-12d3-a456-426614174000"],
    ["con prefijo y separadores", "asset:v2/AbC_123.x"],
    ["letras no ASCII", "ÄßЖ漢字"],
    ["exactamente 128 caracteres", "a".repeat(128)],
    ["par surrogate válido (emoji)", "id-😀"],
  ])("válido (%s) → se acepta tal cual y el recurso puede ser candidato", async (_n, assetId) => {
    const u = await user();
    paginate("upload", [{ ...res(`ai-wardrobe/${u.id}/wardrobe/a`, "upload"), asset_id: assetId }]);
    const r = await detect();
    expect(counts(r)).toEqual({ ...ZERO, ORPHAN_CANDIDATE: 1 });
    expect(r.metadata.assetId).toBe(1);
  });

  it.each([
    ["vacío", ""],
    ["129 caracteres", "a".repeat(129)],
    ["solo espacios", "   "],
    ["espacio inicial", " abc"],
    ["espacio final", "abc "],
    ["espacio intermedio", "ab c"],
    ["tabulador", "ab\tc"],
    ["salto de línea", "abc\n"],
    ["NUL", "ab\u0000c"],
    ["DEL", "ab\u007Fc"],
    ["control C1", "ab\u0085c"],
    ["espacio sin ruptura", "ab\u00A0c"],
    ["carácter de ancho cero", "ab\u200Bc"],
    ["BOM", "\uFEFFabc"],
    ["surrogate suelto", "ab\uD800c"],
    ["número", 123],
    ["null", null],
    ["objeto", { id: "abc" }],
    ["lista", ["abc"]],
  ])("inválido (%s) → INCOMPLETE (nunca candidato)", async (_n, assetId) => {
    const u = await user();
    paginate("upload", [{ ...res(`ai-wardrobe/${u.id}/wardrobe/a`, "upload"), asset_id: assetId }]);
    const r = await detect();
    expect(counts(r)).toEqual({ ...ZERO, INCOMPLETE: 1 });
    expect(r.protection.missingMetadata).toBe(1);
    expect(r.metadata.assetId).toBe(0);
  });

  it("parseOpaqueAssetId no normaliza ni transforma: devuelve exactamente el mismo valor; la igualdad es exacta", async () => {
    const { parseOpaqueAssetId, MAX_ASSET_ID_LENGTH, normalizeResource } = await import("@/services/media-reconcile.service");
    expect(MAX_ASSET_ID_LENGTH).toBe(128);
    for (const v of ["AbC", "abc", "ÄßЖ", "a".repeat(128), "x-y_z.1:2/3"]) expect(parseOpaqueAssetId(v)).toBe(v);
    expect(parseOpaqueAssetId("AbC")).not.toBe(parseOpaqueAssetId("abc")); // sin pasar a minúsculas
    // Formas Unicode distintas (NFC y NFD) se conservan distintas: no se normaliza.
    expect(parseOpaqueAssetId("\u00E9")).toBe("\u00E9");
    expect(parseOpaqueAssetId("e\u0301")).toBe("e\u0301");
    expect(parseOpaqueAssetId("\u00E9")).not.toBe(parseOpaqueAssetId("e\u0301"));
    const n = normalizeResource({ public_id: "ai-wardrobe/u/wardrobe/x", asset_id: "Mixed-Case_ID", created_at: OLD, type: "upload", resource_type: "image" }, "upload");
    expect(n).toMatchObject({ ok: true, item: { assetId: "Mixed-Case_ID" } });
  });
});
