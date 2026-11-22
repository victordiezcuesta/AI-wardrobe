import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { startTestDb, type TestDb } from "../helpers/db";
import { prismaProxy, setTestEnv } from "../helpers/mock-prisma";

/**
 * Fase 19.7 — orquestador de punta a punta sobre PGlite (lease, detector, persistencia y ruta reales; Cloudinary
 * simulado, sin llamadas reales ni mutaciones). También el límite de las lecturas de PostgreSQL del detector (D3).
 * La cancelación REAL por statement_timeout y las carreras entre conexiones están en pg-concurrency.test.ts.
 * Con PGLiteSocketServer, un error de base de datos cierra la conexión de Prisma: tras cada error esperado, heal().
 */
const holder = vi.hoisted(() => ({ prisma: null as PrismaClient | null }));
const admin = vi.hoisted(() => ({ pages: { upload: [] as unknown[], authenticated: [] as unknown[] }, mutations: [] as string[] }));
vi.mock("@/lib/prisma", () => ({ prisma: prismaProxy(holder) }));
vi.mock("@/lib/cloudinary", () => {
  const mutation = (name: string) => async () => { admin.mutations.push(name); };
  return {
    APP_ROOT_PREFIX: "ai-wardrobe/",
    listAppResourcesPage: async (type: "upload" | "authenticated", cursor: string | undefined, signal: AbortSignal) => {
      const pages = admin.pages[type];
      const idx = cursor ? Number(cursor.replace(`${type}-c`, "")) : 0;
      if (idx >= pages.length) return { resources: [] };
      const p = pages[idx];
      if (p instanceof Error) throw p;
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
const heal = async () => { await t.prisma.$queryRawUnsafe("SELECT 1").catch(() => undefined); await t.prisma.$queryRawUnsafe("SELECT 1"); };
beforeEach(async () => {
  await heal();
  await t.prisma.$executeRawUnsafe(`UPDATE "MediaReconcileLock" SET "holderRunId" = NULL, "leaseExpiresAt" = NULL, "heartbeatAt" = NULL, "fencingToken" = 0`);
  await t.prisma.$executeRawUnsafe(`DELETE FROM "MediaAsset"`);
  await t.prisma.$executeRawUnsafe(`DELETE FROM "MediaReconcileRun"`);
  await t.prisma.$executeRawUnsafe(`TRUNCATE "User", "CatalogProduct" CASCADE`);
  admin.pages = { upload: [], authenticated: [] }; admin.mutations = [];
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { errSpy.mockRestore(); vi.useRealTimers(); });

const OLD = "2020-01-01T00:00:00Z"; // muy anterior al startedAt (reloj real de PostgreSQL) menos 24 h
const res = (public_id: string, type: "upload" | "authenticated", created_at = OLD) =>
  ({ public_id, type, created_at, asset_id: `a${Buffer.from(`${type}:${public_id}`).toString("hex").slice(-31)}`, version: 1, bytes: 10, format: "jpg", resource_type: "image" });
function paginate(type: "upload" | "authenticated", ...pages: unknown[][]) {
  admin.pages[type] = pages.map((resources, i) => ({ resources, ...(i < pages.length - 1 ? { next_cursor: `${type}-c${i + 1}` } : {}) }));
}
const newUser = () => t.prisma.user.create({ data: { email: `r${Math.random().toString(36).slice(2)}@q.com` } });
const runner = async () => (await import("@/services/media-reconcile-run.service")).mediaReconcileRunner;
const runs = () => t.prisma.mediaReconcileRun.findMany({ orderBy: { startedAt: "asc" } });
const lock = () => t.prisma.mediaReconcileLock.findFirstOrThrow();
const assets = () => t.prisma.mediaAsset.findMany({ orderBy: { publicId: "asc" } });
const logged = () => (errSpy.mock.calls as unknown[][]).flat().map(String).join("\n");
const call = async (auth?: string) => {
  const { GET } = await import("@/app/api/cron/media-reconcile/run/route");
  return GET(new Request("http://localhost:3000/api/cron/media-reconcile/run", { headers: auth ? { authorization: auth } : {} }));
};

/** Escenario: u con una prenda referenciada y otra huérfana; un try-on huérfano de un propietario inexistente. */
async function scenario() {
  const u = await newUser();
  const refd = `ai-wardrobe/${u.id}/wardrobe/ref`; const orphan = `ai-wardrobe/${u.id}/wardrobe/orphan`; const ghost = "ai-wardrobe/ghost-owner/try-on/g";
  await t.prisma.wardrobeItem.create({ data: { userId: u.id, name: "P", category: "OTHER", imagePublicId: refd } });
  paginate("upload", [res(refd, "upload"), res(orphan, "upload")]);
  paginate("authenticated", [res(ghost, "authenticated")]);
  return { u, refd, orphan, ghost, secrets: new RegExp(`${u.id}|ai-wardrobe/|ghost-owner|${res(orphan, "upload").asset_id}|https?://`) };
}

describe("orquestación de punta a punta", () => {
  it("detección completa → persistencia y cierre COMPLETED atómicos; lock libre; nada sensible en la ejecución ni en la respuesta", async () => {
    const s = await scenario();
    const r = await (await runner()).run();
    expect(r).toMatchObject({ outcome: "COMPLETED", finalized: true, errorCodes: [], persisted: { created: 2, ownerMissing: 1 } });
    const [run] = await runs();
    expect(run).toMatchObject({ status: "COMPLETED", complete: true, inventoryComplete: true, graceHours: 24, errorCodes: [] });
    const rows = await assets();
    expect(new Map(rows.map((a) => [a.publicId, [a.state, a.ownerMissing]]))).toEqual(new Map([[s.ghost, ["CANDIDATE", true]], [s.orphan, ["CANDIDATE", false]]]));
    // startedAt de PostgreSQL de la ejecución = primera observación = instante con el que clasificó el detector.
    expect(rows.every((a) => a.firstCandidateAt.getTime() === run!.startedAt.getTime() && a.firstCandidateRunId === run!.id)).toBe(true);
    expect((run!.summary as { report: { startedAt: string } }).report.startedAt).toBe(run!.startedAt.toISOString());
    expect(JSON.stringify(run!.summary)).not.toMatch(s.secrets);
    expect(await lock()).toMatchObject({ holderRunId: null, leaseExpiresAt: null });
    expect(JSON.stringify(r)).not.toMatch(s.secrets);
    expect(admin.mutations).toEqual([]);
    // Una segunda ejecución (el lock quedó libre) observa de nuevo sin crear nada.
    expect(await (await runner()).run()).toMatchObject({ outcome: "COMPLETED", persisted: { created: 0, observed: 2 } });
  });

  it("inventario incompleto → INCOMPLETE; MediaAsset sin cambios (ni CLEARED de las ausentes); lock libre", async () => {
    const s = await scenario();
    await (await runner()).run();
    const before = await assets();
    paginate("upload", [res(s.refd, "upload")]);
    admin.pages.authenticated = [{ resources: [], next_cursor: "authenticated-c1" }, new Error(`fallo con ${s.ghost}`)];
    const r = await (await runner()).run();
    expect(r).toMatchObject({ outcome: "INCOMPLETE", finalized: true, persisted: null, errorCodes: ["inventory/authenticated/CLOUDINARY_ERROR"] });
    expect(await assets()).toEqual(before); // `orphan` y `ghost` ya no aparecen, pero la ejecución incompleta no limpia nada
    const last = (await runs()).at(-1)!;
    expect(last).toMatchObject({ status: "INCOMPLETE", complete: false, inventoryComplete: false, errorCodes: ["inventory/authenticated/CLOUDINARY_ERROR"] });
    expect(await lock()).toMatchObject({ holderRunId: null });
    expect(JSON.stringify(r)).not.toMatch(s.secrets);
    expect(logged()).not.toMatch(s.secrets);
  });

  it("fallo a mitad de la persistencia (segundo lote) → rollback completo, ejecución FAILED, lock libre; el error no se filtra", async () => {
    const u = await newUser();
    const ids = Array.from({ length: 700 }, (_, i) => `ai-wardrobe/${u.id}/wardrobe/m${String(i).padStart(4, "0")}`);
    paginate("upload", ids.map((id) => res(id, "upload")));
    const victim = ids[650]!;
    await t.prisma.$executeRawUnsafe(`CREATE FUNCTION test_fail_asset() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW."publicId" = '${victim}' THEN RAISE EXCEPTION 'fallo provocado con ${victim}'; END IF; RETURN NEW; END $$`);
    await t.prisma.$executeRawUnsafe(`CREATE TRIGGER test_fail_asset BEFORE INSERT ON "MediaAsset" FOR EACH ROW EXECUTE FUNCTION test_fail_asset()`);
    let r;
    try { r = await (await runner()).run(); } finally {
      await heal();
      await t.prisma.$executeRawUnsafe(`DROP TRIGGER test_fail_asset ON "MediaAsset"`);
      await t.prisma.$executeRawUnsafe(`DROP FUNCTION test_fail_asset()`);
    }
    if (!r || r.outcome === "BUSY") throw new Error("se esperaba una ejecución");
    expect(r).toMatchObject({ outcome: "FAILED", persisted: null, finalized: true }); // release (con su único reintento si la conexión se cerró) la cierra
    expect(r.errorCodes).toHaveLength(1);
    expect(r.errorCodes[0]).toMatch(/^db\/(P\d{4}|DB_ERROR)$/);
    expect(await t.prisma.mediaAsset.count()).toBe(0); // ni el primer lote
    const [run] = await runs();
    expect(run).toMatchObject({ status: "FAILED", inventoryComplete: true, errorCodes: r.errorCodes });
    expect(await lock()).toMatchObject({ holderRunId: null });
    expect(JSON.stringify(r)).not.toMatch(/fallo provocado|ai-wardrobe\//);
    expect(logged()).not.toMatch(/fallo provocado|ai-wardrobe\//);
  }, 60_000);

  it("lease ocupado → BUSY sin crear otra ejecución ni tocar nada", async () => {
    await scenario();
    const { createMediaLease } = await import("@/services/media-lease.service");
    const held = await createMediaLease(t.prisma).acquire({ graceHours: 24, ttlMs: 60_000 });
    expect(held.status).toBe("ACQUIRED");
    const before = await runs();
    expect(await (await runner()).run()).toEqual({ outcome: "BUSY", reason: "LEASE_HELD" });
    expect(await runs()).toEqual(before);
    expect(await t.prisma.mediaAsset.count()).toBe(0);
  });
});

describe("D3: presupuesto efectivo de las lecturas de PostgreSQL del detector", () => {
  const detailed = async (opts: Record<string, unknown>) =>
    (await import("@/services/media-reconcile.service")).detectOrphanMediaDetailed({ now: new Date(), ...opts } as never);

  it("con presupuesto disponible, las lecturas acotadas dan EXACTAMENTE el mismo resultado que sin límite", async () => {
    const s = await scenario();
    const now = new Date();
    const plain = await detailed({ now });
    const bounded = await detailed({ now, budgetMs: 10_000, queryBudgetMs: 10_000 });
    expect(bounded.report.complete).toBe(true);
    expect({ ...bounded.report, durationMs: 0 }).toEqual({ ...plain.report, durationMs: 0 });
    expect(bounded.candidates).toEqual(plain.candidates);
    expect(new Set(bounded.candidates.map((c) => c.publicId))).toEqual(new Set([s.ghost, s.orphan]));
  });

  it("presupuesto agotado al terminar el inventario → las seis lecturas QUERY_TIMEOUT, ninguna se ejecuta y la detección NO es completa", async () => {
    await scenario();
    const auth = admin.pages.authenticated[0];
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-22T12:00:00Z"));
    // La última página del inventario «tarda» 10 s (reloj simulado): el inventario es completo, pero ya no queda tiempo.
    admin.pages.authenticated = [async () => { vi.setSystemTime(Date.now() + 10_000); return auth; }];
    const tx = vi.spyOn(t.prisma, "$transaction");
    try {
      const { report, candidates } = await detailed({ budgetMs: 5_000, queryBudgetMs: 1_000 });
      expect(report.inventoryStatus).toBe("COMPLETE");
      expect(report.complete).toBe(false);
      expect(candidates).toEqual([]);
      expect(report.byCategory.ORPHAN_CANDIDATE).toBe(0);
      expect(report.errors.map((e) => `${e.stage}/${e.scope}/${e.code}`).sort()).toEqual(
        ["owners", "personal", "sourcePhoto", "try-on", "urls", "wardrobe"].map((sc) => `database/${sc}/QUERY_TIMEOUT`));
      expect(tx).not.toHaveBeenCalled();
    } finally { tx.mockRestore(); }
  });

  it("una lectura que responde DESPUÉS del plazo no vale: QUERY_TIMEOUT y la detección no es completa", async () => {
    await scenario();
    const real = t.prisma.$transaction.bind(t.prisma);
    let n = 0;
    // La lectura de propietarios «se retrasa» 2 s más allá del plazo (reloj simulado) aunque PostgreSQL responda.
    const tx = vi.spyOn(t.prisma, "$transaction").mockImplementation((async (fn: never, o: never) => {
      const out = await (real as (f: unknown, o: unknown) => Promise<unknown>)(fn, o);
      if (++n === 5) vi.setSystemTime(Date.now() + 5_000);
      return out;
    }) as never);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-22T12:00:00Z"));
    try {
      const { report, candidates } = await detailed({ budgetMs: 1_000, queryBudgetMs: 1_000 });
      expect(report.complete).toBe(false);
      expect(candidates).toEqual([]);
      expect(report.errors.some((e) => e.stage === "database" && e.code === "QUERY_TIMEOUT")).toBe(true);
    } finally { tx.mockRestore(); }
  });

  it("las lecturas acotadas son de solo lectura en PostgreSQL y llevan statement_timeout local", async () => {
    await scenario();
    const seen: { ro: string; st: string }[] = [];
    const real = t.prisma.$transaction.bind(t.prisma);
    const tx = vi.spyOn(t.prisma, "$transaction").mockImplementation((async (fn: (c: unknown) => Promise<unknown>, o: never) =>
      (real as (f: unknown, o: unknown) => Promise<unknown>)(async (c: { $queryRawUnsafe: (q: string) => Promise<{ ro: string; st: string }[]> }) => {
        const out = await fn(c);
        seen.push((await c.$queryRawUnsafe(`SELECT current_setting('transaction_read_only') AS ro, current_setting('statement_timeout') AS st`))[0]!);
        return out;
      }, o)) as never);
    try {
      const { report } = await detailed({ budgetMs: 10_000, queryBudgetMs: 10_000 });
      expect(report.complete).toBe(true);
    } finally { tx.mockRestore(); }
    expect(seen).toHaveLength(10); // 5 lecturas de referencias/propietarios + 5 de URLs, cada una en su transacción
    for (const s of seen) { expect(s.ro).toBe("on"); expect(s.st).not.toBe("0"); }
    expect(await t.prisma.$queryRawUnsafe<{ st: string }[]>(`SELECT current_setting('statement_timeout') AS st`)).toEqual([{ st: "0" }]); // nada fuera de esas transacciones
  });

  it("queryBudgetMs inválido → TypeError antes de consultar nada", async () => {
    for (const q of [0, -1, 1.5, Number.NaN]) await expect(detailed({ queryBudgetMs: q })).rejects.toThrow(TypeError);
  });
});

describe("ruta /api/cron/media-reconcile/run y contrato del endpoint antiguo", () => {
  it("sin el secreto (o con otro) → 401 y no se crea ninguna ejecución", async () => {
    await scenario();
    for (const auth of [undefined, "Bearer otro", `Bearer ${CRON_SECRET}x`]) {
      const r = await call(auth);
      expect(r.status).toBe(401);
    }
    expect(await runs()).toEqual([]);
  });

  it("con el secreto → 200 con resultado agregado (sin runId, fencingToken ni identificadores); BUSY también 200", async () => {
    const s = await scenario();
    const r = await call(`Bearer ${CRON_SECRET}`);
    expect(r.status).toBe(200);
    const body = await r.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["errorCodes", "finalized", "outcome", "persisted", "report"]);
    expect(body).toMatchObject({ outcome: "COMPLETED", finalized: true, persisted: { created: 2 } });
    const [run] = await runs();
    const text = JSON.stringify(body);
    expect(text).not.toMatch(s.secrets);
    expect(text).not.toContain(run!.id);
    expect(text).not.toMatch(/"(fencingToken|runId|candidates|leaseExpiresAt)"/);
    const { createMediaLease } = await import("@/services/media-lease.service");
    await createMediaLease(t.prisma).acquire({ graceHours: 24, ttlMs: 60_000 });
    const busy = await call(`Bearer ${CRON_SECRET}`);
    expect(busy.status).toBe(200);
    expect(await busy.json()).toEqual({ outcome: "BUSY", reason: "LEASE_HELD" });
  });

  it("FAILED → 500 con códigos genéricos; error inesperado → respuesta genérica del handler", async () => {
    await scenario();
    const mod = await import("@/services/media-reconcile-run.service");
    const spy = vi.spyOn(mod.mediaReconcileRunner, "run").mockResolvedValueOnce({ outcome: "FAILED", finalized: true, report: null, persisted: null, errorCodes: ["persist/STALE_RUN"] });
    const r = await call(`Bearer ${CRON_SECRET}`);
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ outcome: "FAILED", finalized: true, errorCodes: ["persist/STALE_RUN"], persisted: null, report: null });
    spy.mockRejectedValueOnce(new Error("detalle interno ai-wardrobe/u/wardrobe/x"));
    const e = await call(`Bearer ${CRON_SECRET}`);
    expect(e.status).toBe(500);
    expect(await e.json()).toEqual({ error: { code: "INTERNAL", message: "Error interno" } });
    spy.mockRestore();
  });

  it("el endpoint antiguo sigue igual: solo lectura, mismo contrato agregado, sin lease ni ejecuciones", async () => {
    await scenario();
    const { GET } = await import("@/app/api/cron/media-reconcile/route");
    const r = await GET(new Request("http://localhost:3000/api/cron/media-reconcile", { headers: { authorization: `Bearer ${CRON_SECRET}` } }));
    expect(r.status).toBe(200);
    const body = await r.json() as Record<string, unknown>;
    const { detectOrphanMedia } = await import("@/services/media-reconcile.service");
    expect(Object.keys(body).sort()).toEqual(Object.keys(await detectOrphanMedia({ now: new Date() })).sort());
    expect(body).toMatchObject({ complete: true, byCategory: { ORPHAN_CANDIDATE: 2 } });
    expect(await runs()).toEqual([]);
    expect(await t.prisma.mediaAsset.count()).toBe(0);
    expect(await lock()).toMatchObject({ holderRunId: null, fencingToken: 0 });
  });
});

describe("retención DRY_RUN (19.8a) en la orquestación real", () => {
  /** Fila CLEARED de hace 60 días (eliminable por la regla de 30 d) con su ejecución terminada hace 400 días. */
  async function oldCleared() {
    const [r] = await t.prisma.$queryRawUnsafe<{ id: string }[]>(`INSERT INTO "MediaReconcileRun"
      ("id", "status", "fencingToken", "startedAt", "heartbeatAt", "finishedAt", "complete", "inventoryComplete", "graceHours", "updatedAt")
      VALUES (gen_random_uuid()::text, 'COMPLETED', 1, now() - interval '401 days', now() - interval '401 days', now() - interval '400 days', true, true, 24, now())
      RETURNING "id"`);
    await t.prisma.$executeRawUnsafe(`INSERT INTO "MediaAsset" ("id", "publicId", "delivery", "kind", "ownerUserId", "assetId", "resourceCreatedAt",
        "state", "firstCandidateAt", "lastCandidateAt", "firstCandidateRunId", "lastCandidateRunId", "sightings", "ownerMissing", "createdAt", "updatedAt")
      VALUES ('viejo', 'ai-wardrobe/antiguo/wardrobe/v', 'UPLOAD', 'WARDROBE', 'antiguo', 'as-v', now() - interval '400 days',
        'CLEARED', now() - interval '60 days', now() - interval '60 days', '${r!.id}', '${r!.id}', 1, false, now(), now())`);
  }
  const summaryOf = async (outcome: string) => ((await runs()).filter((r) => r.status === outcome).at(-1)!.summary as { retention?: Record<string, unknown> });

  it("COMPLETED: los recuentos DRY_RUN se guardan en el summary; NADA se borra; la respuesta HTTP mantiene sus claves", async () => {
    await oldCleared();
    await scenario();
    const r = await call(`Bearer ${CRON_SECRET}`);
    expect(r.status).toBe(200);
    expect(Object.keys(await r.json() as object).sort()).toEqual(["errorCodes", "finalized", "outcome", "persisted", "report"]);
    const s = await summaryOf("COMPLETED");
    expect(s.retention).toMatchObject({ mode: "DRY_RUN", status: "DONE", assets: { eligible: 1, byRule: { CLEARED: 1 } }, errorCodes: [] });
    expect(JSON.stringify(s.retention)).not.toMatch(/ai-wardrobe|antiguo|viejo/);
    expect(await t.prisma.mediaAsset.findUnique({ where: { id: "viejo" } })).not.toBeNull(); // DRY_RUN: no se borra
    expect(await t.prisma.mediaReconcileRun.count()).toBe(2);
  });

  it("detección INCOMPLETE → los recuentos de retención se conservan en el summary del cierre", async () => {
    await oldCleared();
    await scenario();
    admin.pages.authenticated = [new Error("fallo")];
    expect(await (await runner()).run()).toMatchObject({ outcome: "INCOMPLETE", finalized: true });
    expect((await summaryOf("INCOMPLETE")).retention).toMatchObject({ mode: "DRY_RUN", status: "DONE", assets: { eligible: 1 } });
    expect(await t.prisma.mediaAsset.findUnique({ where: { id: "viejo" } })).not.toBeNull();
  });
});
