import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { startTestDb, type TestDb } from "../helpers/db";
import { setTestEnv } from "../helpers/mock-prisma";

/**
 * Fase 19.6.3 — persistencia del ciclo de vida de MediaAsset (PGlite: lógica, restricciones reales y atomicidad con
 * finishWith). Las carreras reales con el borrado de cuentas están en pg-concurrency.test.ts (PostgreSQL local).
 * Las ejecuciones se crean con un startedAt elegido (en el pasado) para simular el paso del tiempo sin esperar.
 * Con PGLiteSocketServer, un error de base de datos cierra la conexión de Prisma: tras cada error esperado, heal().
 */
/** Cualquier uso del cliente GLOBAL queda registrado: el servicio solo puede usar la transacción que recibe. */
const globalUse = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy({}, { get(_t, prop) { globalUse.calls.push(String(prop)); throw new Error("uso del cliente global de Prisma"); } }),
}));

type Svc = typeof import("@/services/media-asset.service");
type Lease = typeof import("@/services/media-lease.service");
let t: TestDb;
let svc: Svc;
let lease: ReturnType<Lease["createMediaLease"]>;
beforeAll(async () => {
  setTestEnv(); t = await startTestDb();
  svc = await import("@/services/media-asset.service");
  lease = (await import("@/services/media-lease.service")).createMediaLease(t.prisma);
}, 60_000);
afterAll(async () => { await t?.stop(); });
const heal = async () => { await t.prisma.$queryRawUnsafe("SELECT 1").catch(() => undefined); await t.prisma.$queryRawUnsafe("SELECT 1"); };
let token = 0;
beforeEach(async () => {
  await heal();
  await t.prisma.$executeRawUnsafe(`UPDATE "MediaReconcileLock" SET "holderRunId" = NULL, "leaseExpiresAt" = NULL, "heartbeatAt" = NULL, "fencingToken" = 0`);
  await t.prisma.$executeRawUnsafe(`DELETE FROM "MediaAsset"`);
  await t.prisma.$executeRawUnsafe(`DELETE FROM "MediaReconcileRun"`);
  await t.prisma.$executeRawUnsafe(`TRUNCATE "User" CASCADE`);
  token = 0; globalUse.calls = [];
});

const H = 3_600_000;
const BASE = new Date(Math.floor((Date.now() - 30 * 24 * H) / 1000) * 1000); // en el pasado: el lease sigue vigente
const at = (hours: number) => new Date(BASE.getTime() + hours * H);

/** Ejecución RUNNING con el startedAt elegido y el lease (vigente) a su nombre, como la deja acquire. */
async function newRun(startedAt: Date, graceHours = 24) {
  const tok = ++token;
  const [r] = await t.prisma.$queryRaw<{ id: string }[]>`INSERT INTO "MediaReconcileRun" ("id", "fencingToken", "startedAt", "heartbeatAt", "graceHours", "updatedAt")
    VALUES (gen_random_uuid()::text, ${tok}, ${startedAt.toISOString()}::timestamptz AT TIME ZONE 'UTC', ${startedAt.toISOString()}::timestamptz AT TIME ZONE 'UTC', ${graceHours}, now()) RETURNING "id"`;
  const [l] = await t.prisma.$queryRaw<{ leaseExpiresAt: Date }[]>`UPDATE "MediaReconcileLock" SET "fencingToken" = ${tok}, "holderRunId" = ${r!.id},
    "heartbeatAt" = ${startedAt.toISOString()}::timestamptz AT TIME ZONE 'UTC', "leaseExpiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') + interval '1 hour'
    WHERE "name" = 'media-reconcile' RETURNING "leaseExpiresAt"`;
  return { runId: r!.id, fencingToken: tok, leaseExpiresAt: l!.leaseExpiresAt, startedAt };
}
type Cand = import("@/services/media-reconcile.service").MediaCandidate;
const cand = (owner: string, name: string, over: Partial<Cand> = {}): Cand => ({
  publicId: `ai-wardrobe/${owner}/wardrobe/${name}`, delivery: "upload", kind: "wardrobe", ownerUserId: owner, ownerMissing: false,
  assetId: `as-${name}`, version: 3, bytes: 100, format: "jpg", resourceCreatedAt: at(-120), ...over,
});
const detection = (cands: Cand[], report: Record<string, unknown> = {}) => ({
  report: { complete: true, inventoryStatus: "COMPLETE", inventoryComplete: { upload: true, authenticated: true }, errors: [],
    byCategory: { ORPHAN_CANDIDATE: cands.length }, ...report } as never,
  candidates: cands,
});
/** Detección clasificada con `startedAt` (el detector lo copia en report.startedAt). */
const detectionAt = (startedAt: Date, cands: Cand[], report: Record<string, unknown> = {}) =>
  detection(cands, { startedAt: startedAt.toISOString(), ...report });
const DONE = { summary: { ok: 1 }, errorCodes: [] };
/** Ejecución completa: nueva ejecución + finishWith con la persistencia dentro. */
async function persistRun(startedAt: Date, cands: Cand[], graceHours = 24) {
  const l = await newRun(startedAt, graceHours);
  const r = await lease.finishWith(l, DONE, (tx) => svc.persistMediaCandidates(tx, { runId: l.runId, startedAt, detection: detectionAt(startedAt, cands) }));
  if (!r.ok) throw new Error(`finishWith: ${r.reason}`);
  return { runId: l.runId, summary: r.value };
}
const user = (id: string) => t.prisma.user.create({ data: { id, email: `${id}@q.com` } });
const asset = (publicId: string) => t.prisma.mediaAsset.findUniqueOrThrow({ where: { delivery_publicId: { delivery: "UPLOAD", publicId } } });
const runStatus = async (id: string) => (await t.prisma.mediaReconcileRun.findUniqueOrThrow({ where: { id } })).status;

describe("transiciones", () => {
  it("1. candidata nueva → CANDIDATE con primera y última observación = esta ejecución, sightings 1 y rowVersion 0", async () => {
    await user("u1");
    const c = cand("u1", "a", { version: null, bytes: 0, format: null });
    const { runId, summary } = await persistRun(at(0), [c]);
    expect(summary).toMatchObject({ created: 1, cleared: 0 });
    expect(await asset(c.publicId)).toMatchObject({
      state: "CANDIDATE", kind: "WARDROBE", ownerUserId: "u1", ownerMissing: false, assetId: "as-a", version: null, bytes: 0, format: null,
      resourceCreatedAt: c.resourceCreatedAt, firstCandidateAt: at(0), lastCandidateAt: at(0), firstCandidateRunId: runId,
      lastCandidateRunId: runId, sightings: 1, rowVersion: 0,
    });
    expect(await runStatus(runId)).toBe("COMPLETED");
  });

  it("2 y 14. la misma ejecución observa dos veces (también candidatas repetidas en la lista): sin cambios ni observaciones duplicadas", async () => {
    await user("u1");
    const c = cand("u1", "a");
    const l = await newRun(at(0));
    const r = await lease.finishWith(l, DONE, async (tx) => {
      const first = await svc.persistMediaCandidates(tx, { runId: l.runId, startedAt: at(0), detection: detectionAt(at(0), [c]) });
      const before = await tx.mediaAsset.findUniqueOrThrow({ where: { delivery_publicId: { delivery: "UPLOAD", publicId: c.publicId } } });
      const second = await svc.persistMediaCandidates(tx, { runId: l.runId, startedAt: at(0), detection: detectionAt(at(0), [c, { ...c }]) });
      const after = await tx.mediaAsset.findUniqueOrThrow({ where: { delivery_publicId: { delivery: "UPLOAD", publicId: c.publicId } } });
      return { first, second, before, after };
    });
    if (!r.ok) throw new Error("finishWith");
    expect(r.value.first.created).toBe(1);
    expect(r.value.second).toMatchObject({ created: 0, unchanged: 1, observed: 0 });
    expect(r.value.after).toEqual(r.value.before);
  });

  it("3 y 5. otra ejecución antes del plazo → sigue CANDIDATE, sightings 2, última observación actualizada", async () => {
    await user("u1");
    const c = cand("u1", "a");
    const r1 = await persistRun(at(0), [c]);
    const r2 = await persistRun(at(2), [{ ...c, version: 4, bytes: 200, format: "png" }]);
    expect(r2.summary).toMatchObject({ observed: 1, confirmed: 0 });
    expect(await asset(c.publicId)).toMatchObject({
      state: "CANDIDATE", sightings: 2, firstCandidateAt: at(0), lastCandidateAt: at(2), firstCandidateRunId: r1.runId,
      lastCandidateRunId: r2.runId, rowVersion: 1, version: 4, bytes: 200, format: "png",
    });
  });

  it("4. pasado el periodo de gracia (de la ejecución actual) desde la primera observación y con la primera COMPLETED → CONFIRMED", async () => {
    await user("u1");
    const c = cand("u1", "a");
    await persistRun(at(0), [c]);
    expect((await persistRun(at(23.9), [c])).summary.confirmed).toBe(0); // justo por debajo
    const r3 = await persistRun(at(24), [c]); // exactamente el plazo
    expect(r3.summary).toMatchObject({ confirmed: 1 });
    expect(await asset(c.publicId)).toMatchObject({ state: "CONFIRMED", sightings: 3, firstCandidateAt: at(0), lastCandidateAt: at(24) });
    // Con un periodo más largo en la ejecución actual, no se habría confirmado.
    await t.prisma.$executeRawUnsafe(`DELETE FROM "MediaAsset"`);
    await persistRun(at(30), [c]);
    expect((await persistRun(at(60), [c], 48)).summary.confirmed).toBe(0);
  });

  it("CONFIRMED observada de nuevo → sigue CONFIRMED, sightings + 1, última observación y metadatos actualizados", async () => {
    await user("u1");
    const c = cand("u1", "a");
    await persistRun(at(0), [c]); await persistRun(at(25), [c]);
    const r = await persistRun(at(30), [{ ...c, bytes: 999 }]);
    expect(r.summary).toMatchObject({ observed: 1, confirmed: 0 });
    expect(await asset(c.publicId)).toMatchObject({ state: "CONFIRMED", sightings: 3, lastCandidateAt: at(30), lastCandidateRunId: r.runId, bytes: 999, firstCandidateAt: at(0) });
  });

  it("6. si la primera ejecución del ciclo no terminó COMPLETED, no se confirma aunque pase el plazo", async () => {
    await user("u1");
    const c = cand("u1", "a");
    const l = await newRun(at(0)); // la fila se guarda en una transacción propia y la ejecución acaba ABANDONED
    await t.prisma.$transaction((tx) => svc.persistMediaCandidates(tx, { runId: l.runId, startedAt: at(0), detection: detectionAt(at(0), [c]) }));
    await t.prisma.$executeRaw`UPDATE "MediaReconcileRun" SET "status" = 'ABANDONED', "finishedAt" = "startedAt" WHERE "id" = ${l.runId}`;
    const r = await persistRun(at(48), [c]);
    expect(r.summary).toMatchObject({ observed: 1, confirmed: 0 });
    expect(await asset(c.publicId)).toMatchObject({ state: "CANDIDATE", sightings: 2 });
  });

  it("7. mismo publicId con otro assetId (también desde CONFIRMED) → activo nuevo: ciclo reiniciado y rowVersion + 1", async () => {
    await user("u1");
    const c = cand("u1", "a");
    await persistRun(at(0), [c]); await persistRun(at(25), [c]); // CONFIRMED, rowVersion 1
    const r = await persistRun(at(26), [{ ...c, assetId: "otro-asset", version: 9 }]);
    expect(r.summary).toMatchObject({ reset: 1 });
    expect(await asset(c.publicId)).toMatchObject({
      state: "CANDIDATE", assetId: "otro-asset", version: 9, sightings: 1, firstCandidateAt: at(26), lastCandidateAt: at(26),
      firstCandidateRunId: r.runId, lastCandidateRunId: r.runId, rowVersion: 2,
    });
  });

  it("8, 9 y 11. ausente de una detección completa → CLEARED (fila y fechas intactas); CLEARED ausente no cambia; si reaparece, ciclo nuevo", async () => {
    await user("u1");
    const a = cand("u1", "a"); const b = cand("u1", "b");
    await persistRun(at(0), [a, b]); await persistRun(at(25), [a, b]); // las dos CONFIRMED
    const r3 = await persistRun(at(26), [b]); // `a` ya no es candidata
    expect(r3.summary).toMatchObject({ cleared: 1 });
    const cleared = await asset(a.publicId);
    expect(cleared).toMatchObject({ state: "CLEARED", sightings: 2, firstCandidateAt: at(0), lastCandidateAt: at(25), rowVersion: 2 });
    const r4 = await persistRun(at(27), []); // `a` sigue CLEARED y ausente: no se toca; `b` pasa a CLEARED
    expect(r4.summary).toMatchObject({ cleared: 1 });
    expect(await asset(a.publicId)).toEqual(cleared);
    const r5 = await persistRun(at(28), [a]); // reaparece: ciclo nuevo sin antigüedad del anterior
    expect(r5.summary).toMatchObject({ reset: 1 });
    expect(await asset(a.publicId)).toMatchObject({ state: "CANDIDATE", sightings: 1, firstCandidateAt: at(28), firstCandidateRunId: r5.runId, rowVersion: 3, assetId: "as-a" });
    expect(await t.prisma.mediaAsset.count()).toBe(2); // nunca se borran filas
  });
});

describe("propietario revalidado en la misma transacción", () => {
  it("12. existe → ownerMissing false; el detector lo vio sin dueño y sigue sin dueño → ownerMissing true; borrado durante la ejecución → no se escribe nada", async () => {
    await user("vivo");
    const r = await persistRun(at(0), [
      cand("vivo", "a", { ownerMissing: true }), // el detector se equivocó o el usuario apareció: manda PostgreSQL
      cand("huerfano", "b", { ownerMissing: true }), // huérfana legítima
      cand("borrado", "c", { ownerMissing: false }), // existía al detectar; ya no
    ]);
    expect(r.summary).toMatchObject({ created: 2, ownerMissing: 1, skippedOwnerDeleted: 1 });
    expect((await asset(cand("vivo", "a").publicId)).ownerMissing).toBe(false);
    expect((await asset(cand("huerfano", "b").publicId)).ownerMissing).toBe(true);
    expect(await t.prisma.mediaAsset.count({ where: { ownerUserId: "borrado" } })).toBe(0);
  });

  it("si la consulta de propietarios falla, la transacción entera se deshace (nada se escribe y la ejecución sigue RUNNING)", async () => {
    await user("u1");
    const c = cand("u1", "a");
    await persistRun(at(0), [c]);
    const before = await asset(c.publicId);
    const l = await newRun(at(2));
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "User" RENAME TO "UserFueraDeServicio"`); // la lectura de propietarios falla
    let err: unknown;
    try {
      err = await lease.finishWith(l, DONE, (tx) => svc.persistMediaCandidates(tx, { runId: l.runId, startedAt: at(2), detection: detectionAt(at(2), [c, cand("u1", "b")]) }))
        .then(() => null, (e: unknown) => e);
    } finally {
      await heal();
      await t.prisma.$executeRawUnsafe(`ALTER TABLE "UserFueraDeServicio" RENAME TO "User"`);
    }
    expect(String(err)).toMatch(/User/); // el error de PostgreSQL se propaga, no se oculta
    expect(await asset(c.publicId)).toEqual(before);
    expect(await t.prisma.mediaAsset.count()).toBe(1);
    expect(await runStatus(l.runId)).toBe("RUNNING");
  });
});

describe("detecciones incompletas o incoherentes: nada se modifica", () => {
  it.each([
    ["complete false", { complete: false }],
    ["inventario INCOMPLETE", { inventoryStatus: "INCOMPLETE" }],
    ["un tipo de entrega incompleto", { inventoryComplete: { upload: true, authenticated: false } }],
    ["con errores", { errors: [{ stage: "database", scope: "urls", code: "DB_ERROR" }] }],
  ])("10. %s → INCOMPLETE_DETECTION antes de cualquier consulta; nada cambia", async (_n, report) => {
    await user("u1");
    const c = cand("u1", "a");
    await persistRun(at(0), [c]);
    const before = await asset(c.publicId);
    const l = await newRun(at(30));
    const calls: string[] = [];
    const err = await t.prisma.$transaction(async (tx) => {
      const spy = new Proxy(tx, { get(target, p) { calls.push(String(p)); return Reflect.get(target, p) as unknown; } });
      return svc.persistMediaCandidates(spy, { runId: l.runId, startedAt: at(30), detection: detectionAt(at(30), [], report) });
    }).then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ code: "INCOMPLETE_DETECTION" });
    expect(calls).toEqual([]);
    expect(await asset(c.publicId)).toEqual(before); // ni CLEARED, ni sightings, ni fechas
  });

  it.each([
    ["propietario distinto del de la ruta", { ownerUserId: "otro" }],
    ["entrega que no corresponde al tipo", { delivery: "authenticated" as const }],
    ["tipo distinto de la carpeta", { kind: "personal" as const }],
    ["assetId con espacio", { assetId: "con espacio" }],
    ["version 0", { version: 0 }],
    ["bytes fuera de INT4", { bytes: 2 ** 31 }],
    ["format demasiado largo", { format: "x".repeat(17) }],
    ["fecha inválida", { resourceCreatedAt: new Date(Number.NaN) }],
    ["ruta fuera del formato", { publicId: "ai-wardrobe/u1/wardrobe/a/b" }],
  ])("candidata inválida (%s) → INVALID_ARGUMENT y nada cambia", async (_n, over) => {
    await user("u1");
    const l = await newRun(at(0));
    const r = lease.finishWith(l, DONE, (tx) => svc.persistMediaCandidates(tx, { runId: l.runId, startedAt: at(0), detection: detectionAt(at(0), [cand("u1", "a", over)]) }));
    await expect(r).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(await t.prisma.mediaAsset.count()).toBe(0);
    expect(await runStatus(l.runId)).toBe("RUNNING");
  });

  it("la misma clave con datos distintos, recuento incoherente, ejecución ajena o startedAt distinto → error", async () => {
    await user("u1");
    const l = await newRun(at(0));
    const p = (input: Partial<Parameters<Svc["persistMediaCandidates"]>[1]>) =>
      t.prisma.$transaction((tx) => svc.persistMediaCandidates(tx, { runId: l.runId, startedAt: at(0), detection: detectionAt(at(0), []), ...input }));
    await expect(p({ detection: detectionAt(at(0), [cand("u1", "a"), cand("u1", "a", { assetId: "x" })]) })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(p({ detection: detectionAt(at(0), [cand("u1", "a")], { byCategory: { ORPHAN_CANDIDATE: 2 } }) })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(p({ startedAt: at(1), detection: detectionAt(at(1), []) })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" }); // ≠ startedAt de la ejecución
    await expect(p({ runId: "otra-ejecucion" })).rejects.toMatchObject({ code: "RUN_NOT_ACTIVE" });
    await newRun(at(1)); // el lease pasa a otra ejecución
    await expect(p({})).rejects.toMatchObject({ code: "RUN_NOT_ACTIVE" });
    expect(await t.prisma.mediaAsset.count()).toBe(0);
  });

  it("una ejecución anterior a la última observación no puede avanzar el ciclo (STALE_RUN)", async () => {
    await user("u1");
    const c = cand("u1", "a");
    await persistRun(at(10), [c]);
    const l = await newRun(at(5));
    await expect(lease.finishWith(l, DONE, (tx) => svc.persistMediaCandidates(tx, { runId: l.runId, startedAt: at(5), detection: detectionAt(at(5), [c]) })))
      .rejects.toMatchObject({ code: "STALE_RUN" });
    expect(await asset(c.publicId)).toMatchObject({ sightings: 1, lastCandidateAt: at(10) });
  });
});

describe("correcciones de la auditoría (M1, M2, B1, B2)", () => {
  /** Persistencia en una transacción propia (sin finishWith): el servicio debe validar el lease por sí mismo. */
  const direct = (runId: string, startedAt: Date, cands: Cand[], d = detectionAt(startedAt, cands)) =>
    t.prisma.$transaction((tx) => svc.persistMediaCandidates(tx, { runId, startedAt, detection: d }));

  it("M1. lease caducado (aunque el lock siga apuntando a la ejecución RUNNING) → RUN_NOT_ACTIVE y nada se escribe", async () => {
    await user("u1");
    const l = await newRun(at(0));
    await t.prisma.$executeRawUnsafe(`UPDATE "MediaReconcileLock" SET "leaseExpiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second'`);
    await expect(direct(l.runId, at(0), [cand("u1", "a")])).rejects.toMatchObject({ code: "RUN_NOT_ACTIVE" });
    expect(await t.prisma.mediaAsset.count()).toBe(0);
  });

  it("M1. lock libre, lease de otra ejecución o ejecución que ya no está RUNNING → RUN_NOT_ACTIVE", async () => {
    await user("u1");
    const l = await newRun(at(0));
    await t.prisma.$executeRawUnsafe(`UPDATE "MediaReconcileLock" SET "holderRunId" = NULL, "leaseExpiresAt" = NULL`);
    await expect(direct(l.runId, at(0), [cand("u1", "a")])).rejects.toMatchObject({ code: "RUN_NOT_ACTIVE" });
    const l2 = await newRun(at(1));
    await expect(direct(l.runId, at(0), [cand("u1", "a")])).rejects.toMatchObject({ code: "RUN_NOT_ACTIVE" }); // el lease es de l2
    await t.prisma.$executeRaw`UPDATE "MediaReconcileRun" SET "status" = 'FAILED', "finishedAt" = "startedAt" WHERE "id" = ${l2.runId}`;
    await expect(direct(l2.runId, at(1), [cand("u1", "a")])).rejects.toMatchObject({ code: "RUN_NOT_ACTIVE" });
    expect(await t.prisma.mediaAsset.count()).toBe(0);
    // El token del lock y el de la ejecución no pueden divergir: lo impide además la FK compuesta del esquema.
    await expect(t.prisma.$executeRawUnsafe(`UPDATE "MediaReconcileLock" SET "fencingToken" = "fencingToken" + 100`)).rejects.toThrow();
    await heal();
  });

  it("M1. dentro de finishWith la validación no añade esperas ni cambia el resultado (el lock ya es de esa transacción)", async () => {
    await user("u1");
    const t0 = Date.now();
    const r = await persistRun(at(0), [cand("u1", "a")]);
    expect(r.summary.created).toBe(1);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("M2. la detección debe ser de ESTE startedAt: coincide → se persiste; 1 ms distinto o ausente → INVALID_ARGUMENT sin ninguna consulta", async () => {
    await user("u1");
    const l = await newRun(at(0));
    for (const report of [{ startedAt: new Date(at(0).getTime() + 1).toISOString() }, { startedAt: undefined }, { startedAt: at(0).getTime() }]) {
      let calls = 0;
      const err = await t.prisma.$transaction(async (tx) => {
        const spy = new Proxy(tx, { get(target, p) { calls++; return Reflect.get(target, p) as unknown; } });
        return svc.persistMediaCandidates(spy, { runId: l.runId, startedAt: at(0), detection: detection([cand("u1", "a")], report) });
      }).then(() => null, (e: unknown) => e);
      expect(err).toMatchObject({ code: "INVALID_ARGUMENT" });
      expect(calls).toBe(0);
    }
    expect(await direct(l.runId, at(0), [cand("u1", "a")])).toMatchObject({ created: 1 });
  });

  it("B1. una ejecución anterior a la última observación no reinicia el ciclo (assetId distinto ni CLEARED) ni retrocede fechas", async () => {
    await user("u1");
    const a = cand("u1", "a"); const b = cand("u1", "b");
    await persistRun(at(10), [a, b]);
    await persistRun(at(12), [b]); // `a` → CLEARED (última observación: at(10))
    const before = await t.prisma.mediaAsset.findMany({ orderBy: { publicId: "asc" } });
    for (const cands of [[{ ...b, assetId: "otro" }], [a]]) { // b: cambio de assetId; a: reaparece tras CLEARED
      const l = await newRun(at(5));
      await expect(lease.finishWith(l, DONE, (tx) => svc.persistMediaCandidates(tx, { runId: l.runId, startedAt: at(5), detection: detectionAt(at(5), cands) })))
        .rejects.toMatchObject({ code: "STALE_RUN" });
      expect(await runStatus(l.runId)).toBe("RUNNING");
    }
    expect(await t.prisma.mediaAsset.findMany({ orderBy: { publicId: "asc" } })).toEqual(before);
  });

  it("B2. los tres tipos (wardrobe/UPLOAD, personal y try-on/AUTHENTICATED) se insertan, observan y limpian contra las restricciones reales", async () => {
    await user("u1");
    const w = cand("u1", "w");
    const p = cand("u1", "p", { publicId: "ai-wardrobe/u1/personal/p", delivery: "authenticated", kind: "personal" });
    const tr = cand("u1", "t", { publicId: "ai-wardrobe/u1/try-on/t", delivery: "authenticated", kind: "try-on" });
    const r1 = await persistRun(at(0), [tr, w, p]); // en desorden: se ordenan por entrega y publicId
    expect(r1.summary.created).toBe(3);
    const rows = async () => (await t.prisma.mediaAsset.findMany({ orderBy: { publicId: "asc" } }))
      .map((x) => ({ publicId: x.publicId, kind: x.kind, delivery: x.delivery, state: x.state, sightings: x.sightings }));
    expect(await rows()).toEqual([
      { publicId: p.publicId, kind: "PERSONAL", delivery: "AUTHENTICATED", state: "CANDIDATE", sightings: 1 },
      { publicId: tr.publicId, kind: "TRY_ON", delivery: "AUTHENTICATED", state: "CANDIDATE", sightings: 1 },
      { publicId: w.publicId, kind: "WARDROBE", delivery: "UPLOAD", state: "CANDIDATE", sightings: 1 },
    ]);
    const r2 = await persistRun(at(25), [p, w]); // try-on ausente → CLEARED; las otras dos, CONFIRMED
    expect(r2.summary).toMatchObject({ confirmed: 2, cleared: 1 });
    expect((await rows()).map((x) => x.state)).toEqual(["CONFIRMED", "CLEARED", "CONFIRMED"]);
    // Las restricciones del esquema siguen mandando: un tipo que no corresponde a la carpeta o a la entrega se rechaza.
    await expect(t.prisma.$executeRaw`UPDATE "MediaAsset" SET "kind" = 'TRY_ON' WHERE "publicId" = ${p.publicId}`).rejects.toThrow(/MediaAsset_kind_check/);
    await heal();
    await expect(t.prisma.$executeRaw`UPDATE "MediaAsset" SET "delivery" = 'UPLOAD' WHERE "publicId" = ${tr.publicId}`).rejects.toThrow(/MediaAsset_delivery_check/);
    await heal();
  });
});

describe("límites, lotes, atomicidad y aislamiento", () => {
  /** Transacción espiada: registra cada llamada y los arrays que recibe cada sentencia. */
  function spied(tx: Prisma.TransactionClient) {
    const log = { methods: [] as string[], arrays: [] as number[] };
    const proxy = new Proxy(tx, {
      get(target, p) {
        const v = Reflect.get(target, p) as unknown;
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => {
          log.methods.push(String(p));
          for (const a of args.slice(1)) if (Array.isArray(a)) log.arrays.push(a.length);
          return (v as (...x: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    return { proxy, log };
  }

  it("15. más de 10.000 candidatas → TOO_MANY_CANDIDATES sin ninguna consulta", async () => {
    const many = Array.from({ length: svc.MAX_CANDIDATES + 1 }, (_, i) => cand("u1", `n${i}`));
    const l = await newRun(at(0));
    let methods: string[] = [];
    const err = await t.prisma.$transaction(async (tx) => {
      const s = spied(tx); methods = s.log.methods;
      return svc.persistMediaCandidates(s.proxy, { runId: l.runId, startedAt: at(0), detection: detectionAt(at(0), many) });
    }).then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ code: "TOO_MANY_CANDIDATES" });
    expect(methods).toEqual([]);
  });

  it("15. 10.000 candidatas (el máximo) se procesan en lotes de 500 como máximo; un segundo paso solo observa", async () => {
    await user("u1"); await user("u2");
    const many = Array.from({ length: svc.MAX_CANDIDATES }, (_, i) => cand(i % 2 ? "u1" : "u2", `n${String(i).padStart(5, "0")}`));
    for (const [startedAt, expected] of [[at(0), { created: 10_000 }], [at(2), { observed: 10_000 }]] as const) {
      const l = await newRun(startedAt);
      let log = { methods: [] as string[], arrays: [] as number[] };
      const r = await lease.finishWith(l, DONE, (tx) => {
        const s = spied(tx); log = s.log;
        return svc.persistMediaCandidates(s.proxy, { runId: l.runId, startedAt, detection: detectionAt(startedAt, many) });
      });
      if (!r.ok) throw new Error("finishWith");
      expect(r.value).toMatchObject(expected);
      expect(new Set(log.methods)).toEqual(new Set(["$queryRaw", "$executeRaw"])); // solo SQL por la transacción recibida
      // Las únicas listas completas son las del anti-join de ausentes (una lectura); todo lo demás va en lotes ≤ 500.
      const big = log.arrays.filter((n) => n > svc.BATCH_SIZE);
      expect(big.every((n) => n === 10_000)).toBe(true);
      expect(big).toHaveLength(2); // delivery y publicId de ese único anti-join
      expect(log.arrays.filter((n) => n === svc.BATCH_SIZE).length).toBeGreaterThanOrEqual(20);
    }
    expect(await t.prisma.mediaAsset.count({ where: { sightings: 2 } })).toBe(10_000);
  }, 120_000);

  it("16 y 17. un fallo a mitad (segundo lote de actualizaciones) deshace TODO: ni filas, ni cierre, ni liberación; el reintento funciona", async () => {
    await user("u1");
    const cands = Array.from({ length: 700 }, (_, i) => cand("u1", `m${String(i).padStart(4, "0")}`));
    await persistRun(at(0), cands);
    const before = await t.prisma.mediaAsset.findMany({ orderBy: { publicId: "asc" } });
    const victim = cands[650]!.publicId; // segundo lote
    await t.prisma.$executeRawUnsafe(`CREATE FUNCTION test_fail_asset() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW."publicId" = '${victim}' THEN RAISE EXCEPTION 'fallo provocado'; END IF; RETURN NEW; END $$`);
    await t.prisma.$executeRawUnsafe(`CREATE TRIGGER test_fail_asset BEFORE UPDATE ON "MediaAsset" FOR EACH ROW EXECUTE FUNCTION test_fail_asset()`);
    const l = await newRun(at(2));
    try {
      const err = await lease.finishWith(l, DONE, (tx) => svc.persistMediaCandidates(tx, { runId: l.runId, startedAt: at(2), detection: detectionAt(at(2), cands) }))
        .then(() => null, (e: unknown) => e);
      expect(String(err)).toMatch(/fallo provocado/);
    } finally {
      await heal();
      await t.prisma.$executeRawUnsafe(`DROP TRIGGER test_fail_asset ON "MediaAsset"`);
      await t.prisma.$executeRawUnsafe(`DROP FUNCTION test_fail_asset()`);
    }
    expect(await t.prisma.mediaAsset.findMany({ orderBy: { publicId: "asc" } })).toEqual(before); // ni el primer lote
    expect(await runStatus(l.runId)).toBe("RUNNING");
    expect((await t.prisma.mediaReconcileLock.findFirstOrThrow()).holderRunId).toBe(l.runId);
    // Reintento de la MISMA ejecución: una sola observación por fila.
    const r = await lease.finishWith(l, DONE, (tx) => svc.persistMediaCandidates(tx, { runId: l.runId, startedAt: at(2), detection: detectionAt(at(2), cands) }));
    expect(r).toMatchObject({ ok: true, value: { observed: 700 } });
    expect(await t.prisma.mediaAsset.count({ where: { sightings: 2 } })).toBe(700);
    expect(await runStatus(l.runId)).toBe("COMPLETED");
  }, 60_000);

  it("18. el servicio solo usa la transacción recibida: ni el cliente global ni otros métodos", async () => {
    await user("u1");
    globalUse.calls = [];
    const l = await newRun(at(0));
    let methods: string[] = [];
    await lease.finishWith(l, DONE, (tx) => {
      const s = spied(tx); methods = s.log.methods;
      return svc.persistMediaCandidates(s.proxy, { runId: l.runId, startedAt: at(0), detection: detectionAt(at(0), [cand("u1", "a")]) });
    });
    expect(globalUse.calls).toEqual([]);
    expect(methods.length).toBeGreaterThan(0);
    expect(new Set(methods)).toEqual(new Set(["$queryRaw", "$executeRaw"]));
    const src = readFileSync("src/services/media-asset.service.ts", "utf8");
    expect(src).not.toMatch(/@\/lib\/prisma|@\/lib\/cloudinary|\$transaction|deleteMany|DELETE\s+FROM/);
  });
});

describe("planObservation (transición pura)", () => {
  const row = (over: Partial<import("@/services/media-asset.service").AssetRow> = {}) => ({
    id: "x", publicId: "ai-wardrobe/u/wardrobe/a", delivery: "UPLOAD" as const, assetId: "as-a", state: "CANDIDATE" as const,
    firstCandidateAt: at(0), lastCandidateAt: at(0), firstCandidateRunId: "r1", lastCandidateRunId: "r1", sightings: 1, rowVersion: 0, ...over,
  });
  const obs = { publicId: "ai-wardrobe/u/wardrobe/a", delivery: "UPLOAD" as const, kind: "WARDROBE" as const, ownerUserId: "u", assetId: "as-a",
    version: 1, bytes: 1, format: "jpg", resourceCreatedAt: at(-1), detectorOwnerMissing: false };
  const ctx = { runId: "r2", startedAt: at(24), graceMs: 24 * H, ownerMissing: false, firstRunCompleted: true };

  it("decide cada caso sin E/S", () => {
    expect(svc.planObservation(null, obs, ctx)).toMatchObject({ op: "insert", values: { sightings: 1, firstCandidateRunId: "r2" } });
    expect(svc.planObservation(row({ lastCandidateRunId: "r2", sightings: 2, firstCandidateRunId: "r1" }), obs, ctx)).toEqual({ op: "noop" });
    expect(svc.planObservation(row(), obs, ctx)).toMatchObject({ op: "update", kind: "confirmed", values: { state: "CONFIRMED", sightings: 2 } });
    expect(svc.planObservation(row(), obs, { ...ctx, firstRunCompleted: false })).toMatchObject({ kind: "observed", values: { state: "CANDIDATE" } });
    expect(svc.planObservation(row({ state: "CLEARED", sightings: 5 }), obs, ctx)).toMatchObject({ kind: "reset", values: { sightings: 1, firstCandidateAt: at(24) } });
    expect(svc.planObservation(row(), { ...obs, assetId: "otro" }, ctx)).toMatchObject({ kind: "reset" });
    expect(() => svc.planObservation(row({ lastCandidateAt: at(30) }), obs, ctx)).toThrow(/STALE_RUN/);
    // B1: tampoco puede reiniciar un ciclo (CLEARED o assetId distinto) con una ejecución anterior.
    expect(() => svc.planObservation(row({ lastCandidateAt: at(30), state: "CLEARED" }), obs, ctx)).toThrow(/STALE_RUN/);
    expect(() => svc.planObservation(row({ lastCandidateAt: at(30) }), { ...obs, assetId: "otro" }, ctx)).toThrow(/STALE_RUN/);
    // La repetición de la misma ejecución sigue sin cambiar nada.
    expect(svc.planObservation(row({ lastCandidateRunId: "r2", lastCandidateAt: at(24), sightings: 2 }), obs, ctx)).toEqual({ op: "noop" });
  });
});
