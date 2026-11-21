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
  await t.prisma.$executeRawUnsafe(`TRUNCATE "User" CASCADE`);
  holder.writes = []; admin.pages = { upload: [], authenticated: [] }; admin.calls = []; admin.mutations = []; admin.aborted = 0;
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { errSpy.mockRestore(); });

const NOW = new Date("2026-11-21T12:00:00Z");
const OLD = "2026-11-18T12:00:00Z"; // 3 días: supera el periodo de seguridad (24 h)
const RECENT = "2026-11-21T11:00:00Z"; // 1 hora
const res = (public_id: string, type: "upload" | "authenticated", created_at = OLD) => ({ public_id, type, created_at });
/** Reparte recursos en páginas encadenadas por cursor (`<tipo>-c<n>`). */
function paginate(type: "upload" | "authenticated", ...pages: unknown[][]) {
  admin.pages[type] = pages.map((resources, i) => ({ resources, ...(i < pages.length - 1 ? { next_cursor: `${type}-c${i + 1}` } : {}) }));
}
const detect = async (opts: Record<string, unknown> = {}) => (await import("@/services/media-reconcile.service")).detectOrphanMedia({ now: NOW, ...opts });
async function user(photos: string[] = []) {
  return t.prisma.user.create({ data: { email: `m${Math.random().toString(36).slice(2)}@q.com`, profile: { create: { photoPublicIds: photos } } } });
}
const item = (userId: string, imagePublicId: string | null) =>
  t.prisma.wardrobeItem.create({ data: { userId, name: "Prenda", category: "OTHER", imagePublicId, imageUrl: imagePublicId ? `https://res.cloudinary.com/demo/${imagePublicId}.jpg` : null } });
const generated = (userId: string, publicId: string | null, sourcePhotoId: string | null = null) =>
  t.prisma.generatedImage.create({ data: { userId, scenario: "x", pose: "y", status: publicId ? "COMPLETED" : "FAILED", publicId, sourcePhotoId } });
const counts = (r: Awaited<ReturnType<typeof detect>>) => r.byCategory;
const ZERO = { REFERENCED: 0, ORPHAN_CANDIDATE: 0, TOO_RECENT: 0, UNKNOWN: 0, INCOMPLETE: 0 };

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
    expect(r.byKind).toEqual({ wardrobe: 2, personal: 1, tryOn: 1, unknown: 0 });
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
      expect(counts(r)).toEqual({ ...ZERO, INCOMPLETE: 1, ORPHAN_CANDIDATE: 1 }); // try-on sí se pudo verificar
      expect(r.errors).toEqual([{ stage: "database", scope: "wardrobe", code: "P1001" }]);
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
