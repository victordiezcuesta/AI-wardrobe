import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "../helpers/db";
import { listMigrations } from "../helpers/migrations";

/**
 * Fases 19.2.2 y 19.2.3 — esquema de persistencia de la reconciliación de medios (migración 0002). Solo modelo de datos:
 * el detector todavía no escribe aquí. PostgreSQL real (PGlite) con TODAS las migraciones aplicadas en orden.
 * Las restricciones CHECK y las FK que deben fallar se prueban con SQL directo sobre PGlite (mensaje exacto de
 * PostgreSQL); los valores por defecto, la unicidad y el ciclo del lease, a través de Prisma, como los usará el servicio.
 *
 * Limitación del entorno de prueba: con PGLiteSocketServer, un error de base de datos recibido por la conexión de Prisma
 * cierra esa conexión y la siguiente consulta falla con «Connection terminated». Por eso el SQL que debe fallar va directo
 * a PGlite, y tras cada error esperado de Prisma se «cura» la conexión (el pool de pg descarta la muerta y abre otra).
 */
const MIGRATION = "0002_media_reconcile_persistence";
const LOCK = "media-reconcile";
let t: TestDb;
beforeAll(async () => { t = await startTestDb(); }, 60_000);
afterAll(async () => { await t?.stop(); });
/** Consume una conexión de Prisma cerrada por un error anterior: la siguiente consulta usa una conexión nueva. */
const heal = async () => { await t.prisma.$queryRawUnsafe("SELECT 1").catch(() => undefined); await t.prisma.$queryRawUnsafe("SELECT 1"); };
/** Espera un error de Prisma (código o mensaje) y deja la conexión utilizable. */
async function expectPrismaError(p: Promise<unknown>, match: Record<string, unknown> | RegExp) {
  if (match instanceof RegExp) await expect(p).rejects.toThrow(match); else await expect(p).rejects.toMatchObject(match);
  await heal();
}
beforeEach(async () => {
  await t.db.exec(`DELETE FROM "MediaAsset";
    UPDATE "MediaReconcileLock" SET "holderRunId" = NULL, "leaseExpiresAt" = NULL, "heartbeatAt" = NULL, "fencingToken" = 0;
    DELETE FROM "MediaReconcileRun"; TRUNCATE "User" CASCADE;`);
  await heal();
});

/** SQL directo sobre PGlite (sin pasar por la conexión de Prisma). */
const sql = (q: string, params: unknown[] = []) => t.db.query(q, params);
/** El SQL debe fallar por la restricción indicada (o por una de ellas). */
const violates = (q: string, params: unknown[], constraint: string | string[]) =>
  expect(sql(q, params)).rejects.toThrow(new RegExp(`constraint "(${([] as string[]).concat(constraint).join("|")})"`));

let token = 1_000_000; // muy por encima de los tokens de las adquisiciones (que empiezan en 1)
/** Ejecución válida (por defecto RUNNING) con un fencingToken nuevo que no es el del lock. */
async function run(fields: Record<string, unknown> = {}) {
  return t.prisma.mediaReconcileRun.create({ data: { fencingToken: ++token, graceHours: 24, ...fields } });
}

/**
 * Adquisición como la hará el servicio: en una transacción, se bloquea la fila del lock, se crea la ejecución con el
 * token siguiente y, en la MISMA sentencia, se sube el token y se fijan dueño, expiración y heartbeat (hora de la BD).
 */
async function acquire() {
  return t.prisma.$transaction(async (tx) => {
    const [lock] = await tx.$queryRaw<{ fencingToken: number }[]>`SELECT "fencingToken" FROM "MediaReconcileLock" WHERE "name" = ${LOCK} FOR UPDATE`;
    const next = lock!.fencingToken + 1;
    const r = await tx.mediaReconcileRun.create({ data: { fencingToken: next, graceHours: 24 } });
    const n = await tx.$executeRaw`UPDATE "MediaReconcileLock" SET "fencingToken" = ${next}, "holderRunId" = ${r.id},
      "leaseExpiresAt" = now() + interval '6 minutes', "heartbeatAt" = now(), "updatedAt" = now() WHERE "name" = ${LOCK}`;
    expect(n).toBe(1);
    return r;
  });
}
const release = () => sql(`UPDATE "MediaReconcileLock" SET "holderRunId" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = now() WHERE "name" = $1`, [LOCK]);
const lockRow = () => t.prisma.mediaReconcileLock.findUniqueOrThrow({ where: { name: LOCK } });

const H = 3_600_000;
const BASE = new Date("2026-11-20T00:00:00Z");
/** INSERT de un MediaAsset con valores válidos por defecto (columnas sobrescribibles). */
function insertAsset(cols: Record<string, unknown>) {
  const row: Record<string, unknown> = {
    id: `a${Math.random().toString(36).slice(2)}`, publicId: "ai-wardrobe/cmowner/wardrobe/x", delivery: "UPLOAD", kind: "WARDROBE",
    ownerUserId: "cmowner", assetId: "opaque-ID", resourceCreatedAt: BASE, firstCandidateAt: BASE, lastCandidateAt: BASE,
    updatedAt: BASE, ...cols,
  };
  const keys = Object.keys(row);
  return { q: `INSERT INTO "MediaAsset" (${keys.map((k) => `"${k}"`).join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})`, params: Object.values(row) };
}

describe("migraciones", () => {
  it("la base de datos de prueba aplica 0001_init y después 0002, junto con cualquier otra disponible, en orden", () => {
    expect(t.migrations).toEqual(listMigrations().map((m) => m.name));
    const i1 = t.migrations.indexOf("0001_init");
    const i2 = t.migrations.indexOf(MIGRATION);
    expect(i1).toBe(0);
    expect(i2).toBeGreaterThan(i1);
  });

  it("0002 solo añade: no altera ni elimina nada de 0001", () => {
    const text = readFileSync(path.join(process.cwd(), "prisma", "migrations", MIGRATION, "migration.sql"), "utf8");
    const altered = [...text.matchAll(/ALTER TABLE "([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(altered)).toEqual(new Set(["MediaReconcileLock", "MediaReconcileRun", "MediaAsset"]));
    // Ninguna sentencia destructiva (`ON DELETE RESTRICT` de las FK no lo es).
    expect(text).not.toMatch(/^\s*(DROP|TRUNCATE|DELETE\s+FROM|UPDATE\s)|\b(DROP|RENAME)\s+(TABLE|COLUMN|CONSTRAINT|INDEX|TYPE|TO)\b/im);
  });

  it("crea las tablas, los índices y las claves foráneas previstos", async () => {
    const { rows } = await sql(`SELECT indexname::text AS indexname FROM pg_indexes WHERE tablename IN ('MediaReconcileLock','MediaReconcileRun','MediaAsset') ORDER BY 1`);
    expect((rows as { indexname: string }[]).map((r) => r.indexname)).toEqual([
      "MediaAsset_delivery_publicId_key", "MediaAsset_firstCandidateRunId_idx", "MediaAsset_lastCandidateRunId_idx",
      "MediaAsset_ownerUserId_idx", "MediaAsset_pkey", "MediaAsset_state_lastCandidateAt_idx",
      "MediaReconcileLock_pkey",
      "MediaReconcileRun_fencingToken_key", "MediaReconcileRun_id_fencingToken_key", "MediaReconcileRun_kind_startedAt_idx",
      "MediaReconcileRun_pkey", "MediaReconcileRun_status_heartbeatAt_idx",
    ]);
    const fks = await sql(`SELECT conname::text AS conname, confdeltype::text AS confdeltype, confupdtype::text AS confupdtype, cardinality(conkey) AS cols
      FROM pg_constraint WHERE contype = 'f' AND conrelid::regclass::text IN ('"MediaReconcileLock"','"MediaAsset"') ORDER BY 1`);
    // r = RESTRICT, c = CASCADE. La del lock es COMPUESTA (holderRunId, fencingToken) y RESTRICT también al actualizar.
    expect(fks.rows).toEqual([
      { conname: "MediaAsset_firstCandidateRunId_fkey", confdeltype: "r", confupdtype: "c", cols: 1 },
      { conname: "MediaAsset_lastCandidateRunId_fkey", confdeltype: "r", confupdtype: "c", cols: 1 },
      { conname: "MediaReconcileLock_holderRunId_fencingToken_fkey", confdeltype: "r", confupdtype: "r", cols: 2 },
    ]);
    const userFk = await sql(`SELECT 1 FROM pg_constraint WHERE contype = 'f' AND conrelid::regclass::text = '"MediaAsset"' AND confrelid::regclass::text = '"User"'`);
    expect(userFk.rows).toEqual([]); // sin FK a User (ownerUserId)
  });
});

describe("MediaReconcileLock: fila única", () => {
  it("la migración crea UNA fila 'media-reconcile' libre y con fencingToken 0", async () => {
    const rows = await t.prisma.mediaReconcileLock.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: LOCK, fencingToken: 0, holderRunId: null, leaseExpiresAt: null, heartbeatAt: null });
  });

  it("la siembra es idempotente: reejecutarla no duplica la fila ni reinicia su fencingToken", async () => {
    await sql(`UPDATE "MediaReconcileLock" SET "fencingToken" = 7 WHERE "name" = $1`, [LOCK]);
    const text = readFileSync(path.join(process.cwd(), "prisma", "migrations", MIGRATION, "migration.sql"), "utf8");
    const seed = text.slice(text.indexOf("-- SeedLock"));
    expect(seed).toMatch(/ON CONFLICT \("name"\) DO NOTHING/);
    await t.db.exec(seed); await t.db.exec(seed);
    const rows = await t.prisma.mediaReconcileLock.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fencingToken).toBe(7);
  });

  it.each([
    ["otro nombre (no hay un segundo lock)", `INSERT INTO "MediaReconcileLock" ("name", "updatedAt") VALUES ('otro', now())`, "MediaReconcileLock_name_check"],
    ["nombre vacío", `INSERT INTO "MediaReconcileLock" ("name", "updatedAt") VALUES ('', now())`, "MediaReconcileLock_name_check"],
    ["fencingToken negativo", `UPDATE "MediaReconcileLock" SET "fencingToken" = -1`, "MediaReconcileLock_fencingToken_check"],
  ])("CHECK: %s → rechazado", async (_n, q, c) => { await violates(q, [], c); });
});

describe("MediaReconcileLock: lease y fencing token (I1)", () => {
  it("adquirir: el dueño es la ejecución creada y comparte su fencingToken", async () => {
    const r = await acquire();
    const l = await lockRow();
    expect(r.fencingToken).toBe(1);
    expect(l).toMatchObject({ holderRunId: r.id, fencingToken: r.fencingToken });
    expect(l.leaseExpiresAt!.getTime()).toBeGreaterThan(l.heartbeatAt!.getTime());
  });

  it("no se puede borrar la ejecución dueña de un lease activo (RESTRICT)", async () => {
    const r = await acquire();
    await expectPrismaError(t.prisma.mediaReconcileRun.delete({ where: { id: r.id } }), { code: "P2003" });
    await violates(`DELETE FROM "MediaReconcileRun" WHERE "id" = $1`, [r.id], "MediaReconcileLock_holderRunId_fencingToken_fkey");
    expect((await lockRow()).holderRunId).toBe(r.id);
  });

  it.each([
    ["el fencingToken", `UPDATE "MediaReconcileRun" SET "fencingToken" = "fencingToken" + 100 WHERE "id" = $1`],
    ["el fencingToken a uno menor", `UPDATE "MediaReconcileRun" SET "fencingToken" = 999 WHERE "id" = $1`],
    ["el id", `UPDATE "MediaReconcileRun" SET "id" = 'otro-id' WHERE "id" = $1`],
  ])("ON UPDATE RESTRICT: no se puede cambiar %s de la ejecución dueña; el lock queda intacto", async (_n, q) => {
    const r = await acquire();
    const before = await lockRow();
    await violates(q, [r.id], "MediaReconcileLock_holderRunId_fencingToken_fkey");
    expect(await lockRow()).toEqual(before);
    expect(await t.prisma.mediaReconcileRun.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ fencingToken: r.fencingToken });
  });

  it("ON UPDATE RESTRICT también a través de Prisma: el cambio del token falla y nada se propaga al lock", async () => {
    const r = await acquire();
    const before = await lockRow();
    await expectPrismaError(t.prisma.mediaReconcileRun.update({ where: { id: r.id }, data: { fencingToken: r.fencingToken + 100 } }), { code: "P2003" });
    expect(await lockRow()).toEqual(before);
  });

  it("liberado el lease, la FK compuesta ya no protege esa ejecución: su id y su token pueden cambiar sin tocar el lock", async () => {
    const r = await acquire();
    await release();
    const before = await lockRow();
    await sql(`UPDATE "MediaReconcileRun" SET "fencingToken" = 999 WHERE "id" = $1`, [r.id]);
    await sql(`UPDATE "MediaReconcileRun" SET "id" = 'renombrada' WHERE "id" = $1`, [r.id]);
    expect(await t.prisma.mediaReconcileRun.findUniqueOrThrow({ where: { id: "renombrada" } })).toMatchObject({ fencingToken: 999 });
    expect(await lockRow()).toEqual(before);
  });

  it("no se puede fijar un dueño inexistente", async () => {
    await violates(`UPDATE "MediaReconcileLock" SET "holderRunId" = 'no-existe', "leaseExpiresAt" = now() + interval '1 minute', "heartbeatAt" = now()`, [],
      "MediaReconcileLock_holderRunId_fencingToken_fkey");
  });

  it("no se puede asociar un fencingToken distinto al de la ejecución dueña", async () => {
    const other = await run(); // token 1_000_001: no es el del lock (0)
    await violates(`UPDATE "MediaReconcileLock" SET "holderRunId" = $1, "leaseExpiresAt" = now() + interval '1 minute', "heartbeatAt" = now()`, [other.id],
      "MediaReconcileLock_holderRunId_fencingToken_fkey");
    const r = await acquire();
    // Subir el token sin cambiar de dueño (una adquisición a medias) tampoco es posible.
    await violates(`UPDATE "MediaReconcileLock" SET "fencingToken" = "fencingToken" + 1`, [], "MediaReconcileLock_holderRunId_fencingToken_fkey");
    // Ni devolver el lease a una ejecución antigua con el token actual.
    await release();
    const r2 = await acquire();
    await violates(`UPDATE "MediaReconcileLock" SET "holderRunId" = $1`, [r.id], "MediaReconcileLock_holderRunId_fencingToken_fkey");
    expect((await lockRow()).holderRunId).toBe(r2.id);
  });

  it.each([
    ["sin dueño y con expiración futura", `UPDATE "MediaReconcileLock" SET "leaseExpiresAt" = now() + interval '5 minutes', "heartbeatAt" = now()`],
    ["sin dueño y con expiración pasada", `UPDATE "MediaReconcileLock" SET "leaseExpiresAt" = now() - interval '5 minutes'`],
  ])("CHECK: lease %s → rechazado", async (_n, q) => { await violates(q, [], "MediaReconcileLock_lease_check"); });

  it("CHECK: con dueño, debe haber expiración y heartbeat, y el heartbeat no puede ser posterior a la expiración", async () => {
    const r = await acquire();
    await violates(`UPDATE "MediaReconcileLock" SET "leaseExpiresAt" = NULL`, [], "MediaReconcileLock_lease_check");
    await violates(`UPDATE "MediaReconcileLock" SET "heartbeatAt" = NULL`, [], "MediaReconcileLock_lease_check");
    await violates(`UPDATE "MediaReconcileLock" SET "heartbeatAt" = "leaseExpiresAt" + interval '1 second'`, [], "MediaReconcileLock_lease_check");
    expect((await lockRow()).holderRunId).toBe(r.id);
  });

  it("liberar deja dueño y expiración a NULL (el último heartbeat puede quedar) y entonces la ejecución sí se puede borrar", async () => {
    const r = await acquire();
    await release();
    const l = await lockRow();
    expect(l).toMatchObject({ holderRunId: null, leaseExpiresAt: null, fencingToken: r.fencingToken });
    expect(l.heartbeatAt).toBeInstanceOf(Date);
    await t.prisma.mediaReconcileRun.delete({ where: { id: r.id } });
  });

  it("tras liberar, una nueva adquisición obtiene un dueño nuevo y un token mayor", async () => {
    const r1 = await acquire();
    await release();
    const r2 = await acquire();
    expect(r2.id).not.toBe(r1.id);
    expect(r2.fencingToken).toBe(r1.fencingToken + 1);
    expect(await lockRow()).toMatchObject({ holderRunId: r2.id, fencingToken: r2.fencingToken });
  });

  it("dos ejecuciones no pueden tener el mismo token: una adquisición con un token ya usado falla entera", async () => {
    const r1 = await acquire();
    await release();
    await sql(`UPDATE "MediaReconcileLock" SET "fencingToken" = $1 - 1`, [r1.fencingToken]); // simula un reinicio del contador
    await expectPrismaError(acquire(), { code: "P2002" });
    expect(await lockRow()).toMatchObject({ holderRunId: null, fencingToken: r1.fencingToken - 1 }); // la transacción no dejó nada
  });
});

describe("MediaReconcileRun", () => {
  it("valores por defecto: DETECT, RUNNING, no completa, sin errores; fechas de inicio y heartbeat", async () => {
    const r = await run();
    expect(r).toMatchObject({ kind: "DETECT", status: "RUNNING", inventoryComplete: false, complete: false, errorCodes: [], finishedAt: null, summary: null, codeVersion: null });
    expect(r.startedAt).toBeInstanceOf(Date);
    expect(r.heartbeatAt).toBeInstanceOf(Date);
  });

  it("fencingToken único: dos ejecuciones no pueden compartirlo", async () => {
    const r = await run();
    await expectPrismaError(t.prisma.mediaReconcileRun.create({ data: { fencingToken: r.fencingToken, graceHours: 24 } }), { code: "P2002" });
  });

  it("estados finales válidos y resumen agregado en JSON", async () => {
    const done = await run();
    const r = await t.prisma.mediaReconcileRun.update({ where: { id: done.id }, data: { status: "COMPLETED", complete: true, inventoryComplete: true, finishedAt: new Date(Date.now() + 1000), summary: { byCategory: { ORPHAN_CANDIDATE: 2 } }, errorCodes: [], codeVersion: "6401bfd" } });
    expect(r.summary).toEqual({ byCategory: { ORPHAN_CANDIDATE: 2 } });
    const inc = await run();
    await t.prisma.mediaReconcileRun.update({ where: { id: inc.id }, data: { status: "INCOMPLETE", finishedAt: new Date(Date.now() + 1000), errorCodes: ["inventory/upload/TIME_BUDGET"] } });
    for (const status of ["FAILED", "ABANDONED"] as const) {
      const x = await run();
      await t.prisma.mediaReconcileRun.update({ where: { id: x.id }, data: { status, finishedAt: new Date(Date.now() + 1000) } });
    }
  });

  const R = `INSERT INTO "MediaReconcileRun" ("id", "fencingToken", "graceHours", "status", "complete", "inventoryComplete", "finishedAt", "startedAt", "heartbeatAt", "codeVersion", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())`;
  const r = (over: Partial<{ token: number; grace: number; status: string; complete: boolean; inv: boolean; finished: Date | null; heartbeat: Date; code: string | null }>) =>
    [`r${Math.random().toString(36).slice(2)}`, over.token ?? ++token, over.grace ?? 24, over.status ?? "RUNNING", over.complete ?? false, over.inv ?? false,
      "finished" in over ? over.finished : null, BASE, over.heartbeat ?? BASE, "code" in over ? over.code : null];
  const later = new Date(BASE.getTime() + H);

  it.each([
    ["fencingToken 0", { token: 0 }, "MediaReconcileRun_fencingToken_check"],
    ["graceHours por debajo de 1 h", { grace: 0.5 }, "MediaReconcileRun_graceHours_check"],
    ["graceHours NaN", { grace: Number.NaN }, "MediaReconcileRun_graceHours_check"],
    ["graceHours infinito", { grace: Number.POSITIVE_INFINITY }, "MediaReconcileRun_graceHours_check"],
    ["RUNNING con fecha de fin", { finished: later }, "MediaReconcileRun_finished_check"],
    ["terminada sin fecha de fin", { status: "FAILED" }, "MediaReconcileRun_finished_check"],
    ["fin antes del inicio", { status: "FAILED", finished: new Date(BASE.getTime() - H) }, "MediaReconcileRun_finished_check"],
    ["heartbeat antes del inicio", { heartbeat: new Date(BASE.getTime() - 1) }, "MediaReconcileRun_finished_check"],
    ["heartbeat posterior al fin", { status: "FAILED", finished: later, heartbeat: new Date(later.getTime() + 1) }, "MediaReconcileRun_finished_check"],
    ["COMPLETED sin complete", { status: "COMPLETED", finished: later, inv: true }, "MediaReconcileRun_complete_check"],
    ["complete sin COMPLETED", { status: "INCOMPLETE", finished: later, complete: true, inv: true }, "MediaReconcileRun_complete_check"],
    ["completa sin inventario completo", { status: "COMPLETED", finished: later, complete: true, inv: false }, "MediaReconcileRun_complete_check"],
    ["codeVersion vacío", { code: "" }, "MediaReconcileRun_codeVersion_check"],
  ])("CHECK: %s → rechazado", async (_n, over, c) => { await violates(R, r(over), c); });

  it("heartbeat igual al fin: válido", async () => {
    await sql(R, r({ status: "FAILED", finished: later, heartbeat: later }));
  });

  it("CHECK: más de 64 códigos de error → rechazado", async () => {
    const x = await run();
    await violates(`UPDATE "MediaReconcileRun" SET "errorCodes" = $1 WHERE "id" = $2`, [Array.from({ length: 65 }, (_, i) => `E${i}`), x.id], "MediaReconcileRun_errorCodes_check");
  });
});

describe("MediaAsset", () => {
  let first: { id: string }, last: { id: string };
  beforeEach(async () => { first = await run(); last = await run(); });
  const at = (over: Record<string, unknown>) => insertAsset({ firstCandidateRunId: first.id, lastCandidateRunId: first.id, ...over });

  it("valores por defecto y conservación EXACTA de assetId (sin normalizar; igualdad sensible a mayúsculas y a NFC/NFD)", async () => {
    const ids = ["AbC", "abc", "é", "é", "id-😀", "a".repeat(128)];
    for (const [i, assetId] of ids.entries()) {
      await t.prisma.mediaAsset.create({ data: {
        publicId: `ai-wardrobe/cmowner/wardrobe/x${i}`, delivery: "UPLOAD", kind: "WARDROBE", ownerUserId: "cmowner", assetId,
        resourceCreatedAt: BASE, firstCandidateAt: BASE, lastCandidateAt: BASE, firstCandidateRunId: first.id, lastCandidateRunId: first.id,
      } });
    }
    const rows = await t.prisma.mediaAsset.findMany({ orderBy: { publicId: "asc" } });
    expect(rows.map((r) => r.assetId)).toEqual(ids);
    expect(rows[0]).toMatchObject({ state: "CANDIDATE", sightings: 1, ownerMissing: false, rowVersion: 0, version: null, bytes: null, format: null });
    for (const v of ["AbC", "abc", "é", "é"]) {
      expect((await t.prisma.mediaAsset.findMany({ where: { assetId: v } })).map((r) => r.assetId)).toEqual([v]);
    }
  });

  it("(delivery, publicId) es único", async () => {
    const data = { publicId: "ai-wardrobe/cmowner/personal/p", delivery: "AUTHENTICATED" as const, kind: "PERSONAL" as const, ownerUserId: "cmowner", assetId: "x",
      resourceCreatedAt: BASE, firstCandidateAt: BASE, lastCandidateAt: BASE, firstCandidateRunId: first.id, lastCandidateRunId: first.id };
    await t.prisma.mediaAsset.create({ data });
    await expectPrismaError(t.prisma.mediaAsset.create({ data: { ...data, assetId: "otro" } }), { code: "P2002" });
    expect(await t.prisma.mediaAsset.count()).toBe(1);
  });

  it.each([
    ["WARDROBE en wardrobe/ con UPLOAD", "ai-wardrobe/cmowner/wardrobe/x", "WARDROBE", "UPLOAD"],
    ["PERSONAL en personal/ con AUTHENTICATED", "ai-wardrobe/cmowner/personal/x", "PERSONAL", "AUTHENTICATED"],
    ["TRY_ON en try-on/ con AUTHENTICATED", "ai-wardrobe/cmowner/try-on/x", "TRY_ON", "AUTHENTICATED"],
  ])("combinación válida: %s", async (_n, publicId, kind, delivery) => {
    const { q, params } = at({ publicId, kind, delivery });
    await sql(q, params);
    expect(await t.prisma.mediaAsset.count()).toBe(1);
  });

  it.each([
    ["propietario cuid", "cmabcdefghijklmnopqrstuvw", "x"],
    ["propietario de 64 caracteres", "a".repeat(64), "x"],
    ["propietario con guiones y guiones bajos internos", "u-1_a", "x"],
    ["propietario que empieza por guion", "-abc", "x"],
    ["nombre con puntos, espacios y no ASCII", "cmowner", "foto final.v2 ñ😀"],
  ])("ruta válida: %s", async (_n, owner, name) => {
    const { q, params } = at({ publicId: `ai-wardrobe/${owner}/wardrobe/${name}`, ownerUserId: owner });
    await sql(q, params);
    expect(await t.prisma.mediaAsset.count()).toBe(1);
  });

  it("ownerUserId es obligatorio (NOT NULL)", async () => {
    const { q, params } = at({ ownerUserId: null });
    await expect(sql(q, params)).rejects.toThrow(/null value in column "ownerUserId"/);
  });

  it("las ejecuciones referenciadas no se pueden borrar (RESTRICT); deben existir", async () => {
    const { q, params } = at({});
    await sql(q, params);
    await expectPrismaError(t.prisma.mediaReconcileRun.delete({ where: { id: first.id } }), { code: "P2003" });
    const bad = insertAsset({ publicId: "ai-wardrobe/cmowner/wardrobe/y", firstCandidateRunId: "no-existe", lastCandidateRunId: "no-existe" });
    await expect(sql(bad.q, bad.params)).rejects.toThrow(/MediaAsset_firstCandidateRunId_fkey|MediaAsset_lastCandidateRunId_fkey/);
  });

  it("sin FK a User: borrar la cuenta no borra ni bloquea el registro (se limpiará explícitamente en otra fase)", async () => {
    const u = await t.prisma.user.create({ data: { email: `m${Math.random().toString(36).slice(2)}@q.com` } });
    const { q, params } = at({ publicId: `ai-wardrobe/${u.id}/wardrobe/x`, ownerUserId: u.id });
    await sql(q, params);
    await t.prisma.user.delete({ where: { id: u.id } });
    expect(await t.prisma.mediaAsset.count({ where: { ownerUserId: u.id } })).toBe(1);
  });

  it("CONFIRMED válido: dos ejecuciones distintas separadas al menos 1 h", async () => {
    const { q, params } = at({ state: "CONFIRMED", sightings: 2, lastCandidateRunId: last.id, lastCandidateAt: new Date(BASE.getTime() + 2 * H) });
    await sql(q, params);
    expect(await t.prisma.mediaAsset.count({ where: { state: "CONFIRMED" } })).toBe(1);
  });

  const SEG: Record<string, string> = { WARDROBE: "wardrobe", PERSONAL: "personal", TRY_ON: "try-on" };
  const DEL: Record<string, string> = { WARDROBE: "UPLOAD", PERSONAL: "AUTHENTICATED", TRY_ON: "AUTHENTICATED" };
  const kindMismatch = Object.keys(SEG).flatMap((kind) => Object.entries(SEG).filter(([k]) => k !== kind).map(([, seg]) =>
    [`kind ${kind} con carpeta ${seg}/`, () => ({ kind, delivery: DEL[kind], publicId: `ai-wardrobe/cmowner/${seg}/x` }), "MediaAsset_kind_check"] as const));
  const deliveryMismatch = Object.keys(SEG).map((kind) =>
    [`kind ${kind} con entrega ${DEL[kind] === "UPLOAD" ? "AUTHENTICATED" : "UPLOAD"}`, () => ({ kind, delivery: DEL[kind] === "UPLOAD" ? "AUTHENTICATED" : "UPLOAD", publicId: `ai-wardrobe/cmowner/${SEG[kind]}/x` }), "MediaAsset_delivery_check"] as const);

  const cases: (readonly [string, () => Record<string, unknown>, string | string[]])[] = [
    // assetId (M6): longitud y caracteres prohibidos
    ["assetId vacío", () => ({ assetId: "" }), "MediaAsset_assetId_check"],
    ["assetId de 129", () => ({ assetId: "a".repeat(129) }), "MediaAsset_assetId_check"],
    ...[["espacio inicial", " x"], ["espacio intermedio", "a b"], ["tabulador", "a\tb"], ["salto de línea", "a\nb"], ["DEL", "a\u007Fb"],
      ["control C1", "a\u0085b"], ["espacio sin ruptura", "a\u00A0b"], ["guion discrecional", "a\u00ADb"], ["ancho cero", "a\u200Bb"],
      ["marca bidi", "a\u200Fb"], ["separador de línea", "a\u2028b"], ["espacio ideográfico", "a\u3000b"], ["BOM", "\uFEFFab"]]
      .map(([n, v]) => [`assetId con ${n}`, () => ({ assetId: v }), "MediaAsset_assetId_check"] as const),
    // Estructura de la ruta (formato exacto de APP_PATH)
    ["publicId fuera de ai-wardrobe/", () => ({ publicId: "otra-app/cmowner/wardrobe/x" }), "MediaAsset_publicId_check"],
    ["prefijo con mayúsculas", () => ({ publicId: "Ai-wardrobe/cmowner/wardrobe/x" }), "MediaAsset_publicId_check"],
    ["nombre anidado", () => ({ publicId: "ai-wardrobe/cmowner/wardrobe/sub/x" }), "MediaAsset_publicId_check"],
    ["sin nombre", () => ({ publicId: "ai-wardrobe/cmowner/wardrobe/" }), "MediaAsset_publicId_check"],
    ["sin carpeta de tipo", () => ({ publicId: "ai-wardrobe/cmowner/wardrobe" }), "MediaAsset_publicId_check"],
    ["propietario vacío", () => ({ publicId: "ai-wardrobe//wardrobe/x", ownerUserId: "" }), "MediaAsset_publicId_check"],
    ["propietario que empieza por _", () => ({ publicId: "ai-wardrobe/_quarantine/wardrobe/x", ownerUserId: "_quarantine" }), "MediaAsset_publicId_check"],
    ["propietario de 65 caracteres", () => ({ publicId: `ai-wardrobe/${"a".repeat(65)}/wardrobe/x`, ownerUserId: "a".repeat(65) }), "MediaAsset_publicId_check"],
    ["propietario con punto", () => ({ publicId: "ai-wardrobe/cm.owner/wardrobe/x", ownerUserId: "cm.owner" }), "MediaAsset_publicId_check"],
    ["ruta de cuarentena", () => ({ publicId: "ai-wardrobe/cmowner/_quarantine/wardrobe/x" }), ["MediaAsset_kind_check", "MediaAsset_publicId_check"]],
    ["publicId de más de 1024", () => ({ publicId: `ai-wardrobe/cmowner/wardrobe/${"x".repeat(1024)}` }), "MediaAsset_publicId_check"],
    // Propietario exacto (no prefijo)
    ["ownerUserId distinto del de la ruta", () => ({ ownerUserId: "cmotro" }), "MediaAsset_ownerUserId_check"],
    ["ownerUserId que es solo un prefijo", () => ({ ownerUserId: "cmown" }), "MediaAsset_ownerUserId_check"],
    ["ownerUserId que abarca más segmentos", () => ({ ownerUserId: "cmowner/wardrobe" }), "MediaAsset_ownerUserId_check"],
    // Tipo y entrega frente a la ruta
    ...kindMismatch,
    ...deliveryMismatch,
    // Metadatos y contadores
    ["version 0", () => ({ version: 0 }), "MediaAsset_metadata_check"],
    ["bytes negativos", () => ({ bytes: -1 }), "MediaAsset_metadata_check"],
    ["format vacío", () => ({ format: "" }), "MediaAsset_metadata_check"],
    ["sightings 0", () => ({ sightings: 0 }), "MediaAsset_counters_check"],
    ["rowVersion negativo", () => ({ rowVersion: -1 }), "MediaAsset_counters_check"],
    ["última observación antes de la primera", () => ({ lastCandidateAt: new Date(BASE.getTime() - 1) }), "MediaAsset_counters_check"],
    ["1 observación con dos ejecuciones distintas", () => ({ lastCandidateRunId: last.id, lastCandidateAt: new Date(BASE.getTime() + 2 * H) }), "MediaAsset_sightings_runs_check"],
    ["2 observaciones en la misma ejecución", () => ({ sightings: 2 }), "MediaAsset_sightings_runs_check"],
    ["CONFIRMED con una sola observación", () => ({ state: "CONFIRMED" }), "MediaAsset_confirmed_check"],
    ["CONFIRMED con observaciones separadas menos de 1 h", () => ({ state: "CONFIRMED", sightings: 2, lastCandidateRunId: last.id, lastCandidateAt: new Date(BASE.getTime() + 30 * 60_000) }), "MediaAsset_confirmed_check"],
  ];
  it.each(cases)("CHECK: %s → rechazado", async (_n, over, c) => {
    const { q, params } = at(over());
    await violates(q, params, c);
  });
});
