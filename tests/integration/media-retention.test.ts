import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestDb, type TestDb } from "../helpers/db";
import { setTestEnv } from "../helpers/mock-prisma";

/**
 * Fase 19.8a — retención DRY_RUN sobre PGlite (SQL real, restricciones reales, reloj de PostgreSQL). Las filas se
 * colocan respecto a clock_timestamp() con ±1 minuto alrededor de cada límite. El cliente GLOBAL de Prisma lanza: la
 * retención solo usa la transacción de withLease. La concurrencia real está en pg-concurrency.test.ts.
 */
vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy({}, { get() { throw new Error("uso del cliente global de Prisma"); } }),
}));

type Retention = typeof import("@/services/media-retention.service");
type LeaseMod = typeof import("@/services/media-lease.service");
let t: TestDb; let R: Retention; let L: LeaseMod;
beforeAll(async () => {
  setTestEnv(); t = await startTestDb();
  R = await import("@/services/media-retention.service");
  L = await import("@/services/media-lease.service");
}, 60_000);
afterAll(async () => { await t?.stop(); });
const heal = async () => { await t.prisma.$queryRawUnsafe("SELECT 1").catch(() => undefined); await t.prisma.$queryRawUnsafe("SELECT 1"); };
beforeEach(async () => {
  await heal();
  await t.prisma.$executeRawUnsafe(`UPDATE "MediaReconcileLock" SET "holderRunId" = NULL, "leaseExpiresAt" = NULL, "heartbeatAt" = NULL, "fencingToken" = 0`);
  await t.prisma.$executeRawUnsafe(`DELETE FROM "MediaAsset"`);
  await t.prisma.$executeRawUnsafe(`DELETE FROM "MediaReconcileRun"`);
});

const D = 86_400_000; const MIN = 60_000;
const NOW = `(clock_timestamp() AT TIME ZONE 'UTC')`;
const ago = (ms: number) => `(${NOW} - (${ms}::float8 * interval '1 millisecond'))`;
/** Ejecución terminal (o RUNNING) con su token; terminada hace `finishedAgo` ms. */
async function run(status: "COMPLETED" | "INCOMPLETE" | "FAILED" | "ABANDONED", finishedAgo: number, graceHours = 24) {
  // Token siguiente según la base de datos (también cuenta los de acquire): el orden de inserción es el orden de token.
  const tok = `(SELECT GREATEST(COALESCE(MAX("fencingToken"), 0), (SELECT "fencingToken" FROM "MediaReconcileLock")) + 1 FROM "MediaReconcileRun")`;
  const [r] = await t.prisma.$queryRawUnsafe<{ id: string }[]>(`INSERT INTO "MediaReconcileRun"
    ("id", "status", "fencingToken", "startedAt", "heartbeatAt", "finishedAt", "complete", "inventoryComplete", "graceHours", "updatedAt")
    VALUES (gen_random_uuid()::text, '${status}', ${tok}, ${ago(finishedAgo + 3_600_000)}, ${ago(finishedAgo + 3_600_000)}, ${ago(finishedAgo)},
      ${status === "COMPLETED"}, ${status === "COMPLETED"}, ${graceHours}, ${NOW}) RETURNING "id"`);
  return r!.id;
}
/** Fila de MediaAsset (wardrobe/UPLOAD). Con dos ejecuciones distintas: sightings 2 y primera observación 2 h antes. */
async function asset(name: string, state: "CANDIDATE" | "CONFIRMED" | "CLEARED", ownerMissing: boolean, lastAgo: number, lastRun: string,
  o: { firstRun?: string; updatedAgo?: number; owner?: string } = {}) {
  const firstRun = o.firstRun ?? lastRun; const two = firstRun !== lastRun;
  const owner = o.owner ?? "owner1";
  await t.prisma.$executeRawUnsafe(`INSERT INTO "MediaAsset" ("id", "publicId", "delivery", "kind", "ownerUserId", "assetId", "resourceCreatedAt",
      "state", "firstCandidateAt", "lastCandidateAt", "firstCandidateRunId", "lastCandidateRunId", "sightings", "ownerMissing", "createdAt", "updatedAt")
    VALUES (gen_random_uuid()::text, 'ai-wardrobe/${owner}/wardrobe/${name}', 'UPLOAD', 'WARDROBE', '${owner}', 'as-${name}', ${ago(400 * D)},
      '${state}', ${two ? ago(lastAgo + 2 * 3_600_000) : ago(lastAgo)}, ${ago(lastAgo)}, '${firstRun}', '${lastRun}', ${two ? 2 : 1}, ${ownerMissing},
      ${ago(lastAgo)}, ${o.updatedAgo === undefined ? NOW : ago(o.updatedAgo)})`);
}
const leaseSvc = () => L.createMediaLease(t.prisma);
async function acquire(svc = leaseSvc()) {
  const r = await svc.acquire({ graceHours: 24, ttlMs: 360_000 });
  if (r.status !== "ACQUIRED") throw new Error("no adquirió");
  return r.lease;
}
async function retain(o: { graceHours?: number; budgetMs?: number; lease?: Awaited<ReturnType<typeof acquire>>; svc?: Parameters<Retention["createMediaRetention"]>[0]["lease"] } = {}) {
  const svc = o.svc ?? leaseSvc();
  const lease = o.lease ?? await acquire(svc as ReturnType<typeof leaseSvc>);
  return R.createMediaRetention({ lease: svc }).run(lease, { budgetMs: o.budgetMs ?? 1_000_000, ttlMs: 360_000, graceHours: o.graceHours ?? 24 });
}
const snapshot = async () => ({
  assets: await t.prisma.mediaAsset.findMany({ orderBy: { publicId: "asc" } }),
  runs: await t.prisma.mediaReconcileRun.findMany({ where: { status: { not: "RUNNING" } }, orderBy: { fencingToken: "asc" } }),
});

describe("MediaAsset: límites justo antes y después de cada regla", () => {
  it("CLEARED 30 d; CLEARED+ownerMissing 14 d (el suelo prevalece sobre 7 d); activos+ownerMissing 30 d; activos 180 d", async () => {
    const r1 = await run("COMPLETED", 400 * D); const r2 = await run("COMPLETED", 400 * D);
    const cases: [string, "CANDIDATE" | "CONFIRMED" | "CLEARED", boolean, number][] = [
      ["c", "CLEARED", false, 30 * D], ["com", "CLEARED", true, 14 * D],
      ["aom", "CANDIDATE", true, 30 * D], ["fom", "CONFIRMED", true, 30 * D],
      ["a", "CANDIDATE", false, 180 * D], ["f", "CONFIRMED", false, 180 * D],
    ];
    for (const [n, state, om, cutoff] of cases) {
      const o = state === "CONFIRMED" ? { firstRun: r1 } : {};
      await asset(`${n}-antes`, state, om, cutoff - MIN, r2, o); // aún no
      await asset(`${n}-despues`, state, om, cutoff + MIN, r2, o); // ya sí
    }
    await asset("com-8d", "CLEARED", true, 8 * D, r2); // con la regla de 7 d sería eliminable; el suelo de 14 d lo impide
    const res = await retain();
    expect(res).toMatchObject({ mode: "DRY_RUN", status: "DONE", errorCodes: [] });
    expect(res.assets).toMatchObject({ eligible: 6, complete: true, byRule: { CLEARED: 1, CLEARED_OWNER_MISSING: 1, ACTIVE_OWNER_MISSING: 2, ACTIVE: 2 } });
  });

  it("suelo con el MAYOR graceHours: el de la última ejecución observadora (72 h → 21 d) o el actual (96 h → 28 d)", async () => {
    const g72 = await run("COMPLETED", 400 * D, 72); const g24 = await run("COMPLETED", 400 * D, 24);
    await asset("r-20d", "CLEARED", true, 21 * D - MIN, g72);
    await asset("r-22d", "CLEARED", true, 21 * D + MIN, g72);
    await asset("c-27d", "CLEARED", true, 28 * D - MIN, g24);
    await asset("c-29d", "CLEARED", true, 28 * D + MIN, g24);
    // GRACE_HOURS actual 24: solo r-22d (21 d por la ejecución), c-27d y c-29d (14 d).
    expect((await retain({ graceHours: 24 })).assets.byRule.CLEARED_OWNER_MISSING).toBe(3);
    await t.prisma.$executeRawUnsafe(`UPDATE "MediaReconcileLock" SET "holderRunId" = NULL, "leaseExpiresAt" = NULL`);
    // GRACE_HOURS actual 96 → 28 d para todas: solo c-29d.
    expect((await retain({ graceHours: 96 })).assets.byRule.CLEARED_OWNER_MISSING).toBe(1);
  });

  it("usa lastCandidateAt, nunca updatedAt", async () => {
    const r1 = await run("COMPLETED", 400 * D);
    await asset("viejo-tocado-hoy", "CLEARED", false, 31 * D, r1, { updatedAgo: 0 }); // eliminable aunque se actualizó ahora
    await asset("reciente-sin-tocar", "CLEARED", false, 1 * D, r1, { updatedAgo: 400 * D }); // no, aunque updatedAt sea antiguo
    expect((await retain()).assets).toMatchObject({ eligible: 1, byRule: { CLEARED: 1 } });
  });
});

describe("MediaReconcileRun", () => {
  /** 14 ejecuciones recientes (tokens altos) por estado: ocupan el «conservar 14». */
  const fillers = async () => { for (const s of ["COMPLETED", "INCOMPLETE", "FAILED", "ABANDONED"] as const) for (let i = 0; i < 14; i++) await run(s, 1 * D); };

  it("COMPLETED 90 d; INCOMPLETE/FAILED/ABANDONED 30 d (sin suelo de gracia, C5); justo antes y después", async () => {
    await run("COMPLETED", 90 * D - MIN); await run("COMPLETED", 90 * D + MIN);
    for (const s of ["INCOMPLETE", "FAILED", "ABANDONED"] as const) { await run(s, 30 * D - MIN); await run(s, 30 * D + MIN); }
    await run("FAILED", 30 * D + MIN, 200); // 7 × 200 h ≈ 58 d: el suelo de gracia NO se aplica a ejecuciones
    await fillers();
    const res = await retain();
    expect(res.runs).toMatchObject({ eligible: 5, complete: true, byStatus: { COMPLETED: 1, INCOMPLETE: 1, FAILED: 2, ABANDONED: 1 } });
  });

  it("conserva las 14 más recientes de cada estado POR fencingToken (no por finishedAt)", async () => {
    // 16 COMPLETED antiguas: los tokens bajos (1, 2) terminaron hace 95 d; los altos, hace más (100–113 d).
    await run("COMPLETED", 95 * D); await run("COMPLETED", 95 * D);
    for (let i = 0; i < 14; i++) await run("COMPLETED", (100 + i) * D);
    // Por token se conservan 3..16 y son eliminables 1 y 2. (Por finishedAt se conservarían 1 y 2 y caerían dos de las altas.)
    expect((await retain()).runs).toMatchObject({ eligible: 2, byStatus: { COMPLETED: 2 } });
    await t.prisma.$executeRawUnsafe(`UPDATE "MediaReconcileLock" SET "holderRunId" = NULL, "leaseExpiresAt" = NULL`);
    await t.prisma.$executeRawUnsafe(`UPDATE "MediaReconcileRun" SET "finishedAt" = ${ago(50 * D)} WHERE "fencingToken" IN (1, 2)`);
    expect((await retain()).runs.eligible).toBe(0); // 1 y 2 ya no son antiguas; las 14 de token alto se conservan
  });

  it("nunca: referenciadas por MediaAsset (primera o última observación), RUNNING ni la dueña del lock; la fila del lock no cambia de dueño ni token", async () => {
    const refFirst = await run("COMPLETED", 200 * D); const refLast = await run("COMPLETED", 200 * D); await run("COMPLETED", 200 * D); // la 3.ª, libre
    await fillers();
    const recent = await run("COMPLETED", 1 * D);
    await asset("x", "CONFIRMED", false, 1 * D, recent, { firstRun: refFirst });
    await asset("y", "CANDIDATE", false, 1 * D, refLast);
    const svc = leaseSvc(); const lease = await acquire(svc);
    const before = await t.prisma.mediaReconcileLock.findFirstOrThrow();
    const res = await retain({ svc, lease });
    expect(res.runs).toMatchObject({ eligible: 1, byStatus: { COMPLETED: 1 } });
    const after = await t.prisma.mediaReconcileLock.findFirstOrThrow();
    expect(after).toMatchObject({ name: "media-reconcile", holderRunId: lease.runId, fencingToken: before.fencingToken });
    expect(await t.prisma.mediaReconcileRun.findUniqueOrThrow({ where: { id: lease.runId } })).toMatchObject({ status: "RUNNING" });
  });
});

describe("lotes, DRY_RUN y lease", () => {
  async function bulk(n: number) {
    const r1 = await run("COMPLETED", 400 * D);
    await t.prisma.$executeRawUnsafe(`INSERT INTO "MediaAsset" ("id", "publicId", "delivery", "kind", "ownerUserId", "assetId", "resourceCreatedAt",
        "state", "firstCandidateAt", "lastCandidateAt", "firstCandidateRunId", "lastCandidateRunId", "sightings", "ownerMissing", "createdAt", "updatedAt")
      SELECT gen_random_uuid()::text, 'ai-wardrobe/o' || (i % 7) || '/wardrobe/b' || lpad(i::text, 5, '0'), 'UPLOAD', 'WARDROBE', 'o' || (i % 7),
        'as' || i, ${ago(400 * D)}, 'CLEARED', ${ago(60 * D)}, ${ago(60 * D)}, '${r1}', '${r1}', 1, false, ${NOW}, ${NOW}
      FROM generate_series(1, ${n}) AS i`);
  }

  it("lotes de 200: 450 elegibles → 3 lotes; 2100 → 10 lotes (2000) y PARTIAL", async () => {
    await bulk(450);
    expect((await retain()).assets).toMatchObject({ eligible: 450, batches: 3, complete: true });
    await t.prisma.$executeRawUnsafe(`DELETE FROM "MediaAsset"`);
    await t.prisma.$executeRawUnsafe(`UPDATE "MediaReconcileLock" SET "holderRunId" = NULL, "leaseExpiresAt" = NULL`);
    await bulk(2100);
    const res = await retain();
    expect(res).toMatchObject({ status: "PARTIAL", assets: { eligible: 2000, batches: 10, complete: false } });
  }, 60_000);

  it("exactamente 200 elegibles → 2 lotes (el segundo vacío), 200 en total y complete: true", async () => {
    await bulk(200);
    const res = await retain();
    expect(res).toMatchObject({ status: "DONE", assets: { eligible: 200, batches: 2, complete: true } });
  });

  it("DRY_RUN: ni una fila de MediaAsset ni de ejecuciones terminadas cambia; la ejecución en curso solo renueva su latido", async () => {
    await bulk(250);
    for (let i = 0; i < 16; i++) await run("ABANDONED", 40 * D);
    const before = await snapshot();
    const svc = leaseSvc(); const lease = await acquire(svc);
    const runBefore = await t.prisma.mediaReconcileRun.findUniqueOrThrow({ where: { id: lease.runId } });
    const res = await retain({ svc, lease });
    expect(res).toMatchObject({ status: "DONE", assets: { eligible: 250 }, runs: { eligible: 2 } });
    expect(await snapshot()).toEqual(before);
    const runAfter = await t.prisma.mediaReconcileRun.findUniqueOrThrow({ where: { id: lease.runId } });
    const { heartbeatAt: _h1, updatedAt: _u1, ...rb } = runBefore; const { heartbeatAt: _h2, updatedAt: _u2, ...ra } = runAfter;
    expect(ra).toEqual(rb);
  });

  it("la renovación del lease en DRY_RUN es PERSISTENTE (transacción confirmada, no un rollback)", async () => {
    await bulk(10);
    const svc = leaseSvc(); const lease = await acquire(svc);
    await t.prisma.$executeRawUnsafe(`UPDATE "MediaReconcileLock" SET "leaseExpiresAt" = ${NOW} + interval '20 seconds'`);
    await retain({ svc, lease });
    const [row] = await t.prisma.$queryRawUnsafe<{ left: number }[]>(
      `SELECT EXTRACT(EPOCH FROM ("leaseExpiresAt" - ${NOW}))::float8 AS "left" FROM "MediaReconcileLock"`);
    expect(row!.left).toBeGreaterThan(340); // renovado a ~360 s y visible desde otra transacción
  });

  it("cada lote fija statement_timeout 5 s y lock_timeout 2 s, solo dentro de su transacción", async () => {
    await bulk(5);
    const svc = leaseSvc(); const lease = await acquire(svc);
    const seen: { st: string; lt: string }[] = [];
    const spy = {
      withLease: ((l: never, fn: (tx: never) => Promise<unknown>, o: never) => svc.withLease(l, async (tx) => {
        const v = await fn(tx as never);
        seen.push((await tx.$queryRawUnsafe<{ st: string; lt: string }[]>(`SELECT current_setting('statement_timeout') AS st, current_setting('lock_timeout') AS lt`))[0]!);
        return v;
      }, o)) as never,
    };
    await R.createMediaRetention({ lease: spy }).run(lease, { budgetMs: 1_000_000, ttlMs: 360_000, graceHours: 24 });
    expect(seen).toEqual([{ st: "5s", lt: "2s" }, { st: "5s", lt: "2s" }]);
    expect(await t.prisma.$queryRawUnsafe(`SELECT current_setting('statement_timeout') AS st`)).toEqual([{ st: "0" }]);
  });

  it("lease perdido ENTRE lotes (otra ejecución lo adquiere) → LEASE_LOST y no se ejecuta ningún lote más", async () => {
    await bulk(450);
    const svc = leaseSvc(); const lease = await acquire(svc);
    let n = 0;
    const wrapped = {
      withLease: (async (...a: Parameters<typeof svc.withLease>) => {
        const r = await svc.withLease(...a);
        if (++n === 1) { // tras el primer lote: caduca y otra ejecución adquiere
          await t.prisma.$executeRawUnsafe(`UPDATE "MediaReconcileLock" SET "heartbeatAt" = ${NOW} - interval '2 seconds', "leaseExpiresAt" = ${NOW} - interval '1 second'`);
          await acquire(leaseSvc());
        }
        return r;
      }) as never,
    };
    const res = await R.createMediaRetention({ lease: wrapped }).run(lease, { budgetMs: 1_000_000, ttlMs: 360_000, graceHours: 24 });
    expect(res).toMatchObject({ status: "LEASE_LOST", errorCodes: ["retention/LEASE_LOST"], assets: { batches: 1, eligible: 200 } });
    expect(n).toBe(2);
    expect(await t.prisma.mediaReconcileRun.findUniqueOrThrow({ where: { id: lease.runId } })).toMatchObject({ status: "ABANDONED" });
  });

  it("lease ajeno (otro token) → LEASE_LOST sin ejecutar ninguna selección", async () => {
    await bulk(5);
    const svc = leaseSvc(); const lease = await acquire(svc);
    const res = await retain({ svc, lease: { ...lease, fencingToken: lease.fencingToken + 1 } });
    expect(res).toMatchObject({ status: "LEASE_LOST", assets: { batches: 0, eligible: 0 } });
  });
});

describe("withLease: maxWaitMs y timeoutMs (C2)", () => {
  it("valores fuera de rango → INVALID_ARGUMENT antes de abrir nada", async () => {
    const svc = leaseSvc(); const lease = await acquire(svc);
    for (const o of [{ maxWaitMs: 0 }, { maxWaitMs: 10_001 }, { maxWaitMs: 1.5 }, { timeoutMs: 0 }, { timeoutMs: 30_001 }]) {
      await expect(svc.withLease(lease, async () => 1, o)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }
    expect(await svc.withLease(lease, async () => 7)).toMatchObject({ ok: true, value: 7 }); // sin opciones: como antes
  });

  it("timeoutMs acota la transacción: una operación más larga se deshace (y su renovación también)", async () => {
    const svc = leaseSvc(); const lease = await acquire(svc);
    const exp0 = (await t.prisma.mediaReconcileLock.findFirstOrThrow()).leaseExpiresAt!;
    const t0 = Date.now();
    await expect(svc.withLease(lease, async () => { await new Promise((r) => setTimeout(r, 600)); return 1; }, { timeoutMs: 150 })).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(5_000);
    await heal();
    expect((await t.prisma.mediaReconcileLock.findFirstOrThrow()).leaseExpiresAt).toEqual(exp0);
  });

  it("maxWaitMs acota la espera para empezar: con la única conexión ocupada, falla en ~maxWaitMs", async () => {
    const svc = leaseSvc(); const lease = await acquire(svc);
    let release!: () => void; const busy = new Promise<void>((r) => { release = r; });
    const holder = t.prisma.$transaction(async () => { await busy; }, { timeout: 10_000, maxWait: 5_000 }); // PGlite: max 1 conexión
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    await expect(svc.withLease(lease, async () => 1, { maxWaitMs: 200 })).rejects.toMatchObject({ code: "P2028" });
    expect(Date.now() - t0).toBeLessThan(2_000);
    release(); await holder;
  });
});
