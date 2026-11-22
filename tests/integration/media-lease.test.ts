import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestDb, type TestDb } from "../helpers/db";
import { setTestEnv } from "../helpers/mock-prisma";
import { createMediaLease, MAX_FENCING_TOKEN, MediaLeaseError, type MediaLease, type MediaLeaseService } from "@/services/media-lease.service";

/**
 * Fase 19.5 — servicio de lease del reconciliador de medios: lógica e integridad sobre PostgreSQL (PGlite, una sola
 * conexión). Las carreras REALES entre transacciones están en pg-concurrency.test.ts (PostgreSQL local, TEST_PG_URL).
 * El paso del tiempo se simula moviendo leaseExpiresAt al pasado con SQL (el TTL mínimo es de 10 s).
 *
 * Limitación del entorno: con PGLiteSocketServer, un error de base de datos recibido por la conexión de Prisma la cierra;
 * tras cada error esperado se «cura» la conexión.
 */
let t: TestDb;
let svc: MediaLeaseService;
beforeAll(async () => { setTestEnv(); t = await startTestDb(); svc = createMediaLease(t.prisma); }, 60_000);
afterAll(async () => { await t?.stop(); });
const heal = async () => { await t.prisma.$queryRawUnsafe("SELECT 1").catch(() => undefined); await t.prisma.$queryRawUnsafe("SELECT 1"); };
beforeEach(async () => {
  await heal();
  await t.prisma.$executeRawUnsafe(`INSERT INTO "MediaReconcileLock" ("name", "fencingToken", "createdAt", "updatedAt")
    VALUES ('media-reconcile', 0, now(), now()) ON CONFLICT ("name") DO NOTHING`); // por si una prueba borró la fila
  await t.prisma.$executeRawUnsafe(`UPDATE "MediaReconcileLock" SET "holderRunId" = NULL, "leaseExpiresAt" = NULL, "heartbeatAt" = NULL, "fencingToken" = 0`);
  await t.prisma.$executeRawUnsafe(`DELETE FROM "MediaAsset"`);
  await t.prisma.$executeRawUnsafe(`DELETE FROM "MediaReconcileRun"`);
});

const OPTS = { graceHours: 24, ttlMs: 60_000 };
const lock = () => t.prisma.mediaReconcileLock.findUniqueOrThrow({ where: { name: "media-reconcile" } });
const run = (id: string) => t.prisma.mediaReconcileRun.findUniqueOrThrow({ where: { id } });
const dbNow = async () => (await t.prisma.$queryRawUnsafe<{ now: Date }[]>(`SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS now`))[0]!.now;
/** Simula que el lease actual caducó hace `secs` segundos (sin esperar). */
const expire = (secs = 5) => t.prisma.$executeRawUnsafe(`UPDATE "MediaReconcileLock" SET "heartbeatAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '${secs + 1} seconds',
  "leaseExpiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '${secs} seconds' WHERE "holderRunId" IS NOT NULL`);
async function acquired(): Promise<MediaLease> {
  const r = await svc.acquire(OPTS);
  if (r.status !== "ACQUIRED") throw new Error(`esperaba ACQUIRED: ${r.reason}`);
  return r.lease;
}
const COMPLETED = { status: "COMPLETED" as const, inventoryComplete: true, summary: { byCategory: { ORPHAN_CANDIDATE: 1 } }, errorCodes: [] };

describe("adquisición", () => {
  it("primera adquisición: crea la ejecución RUNNING y asigna el lease con el token 1 y la hora de PostgreSQL", async () => {
    const before = await dbNow();
    const r = await svc.acquire({ ...OPTS, codeVersion: "abc1234" });
    expect(r).toMatchObject({ status: "ACQUIRED", abandoned: 0 });
    if (r.status !== "ACQUIRED") return;
    const l = await lock();
    expect(l).toMatchObject({ holderRunId: r.lease.runId, fencingToken: 1 });
    expect(l.leaseExpiresAt).toEqual(r.lease.leaseExpiresAt);
    const x = await run(r.lease.runId);
    expect(x).toMatchObject({ status: "RUNNING", fencingToken: 1, graceHours: 24, codeVersion: "abc1234", complete: false, finishedAt: null });
    expect(x.startedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(l.leaseExpiresAt!.getTime() - x.startedAt.getTime()).toBe(60_000);
    expect(l.heartbeatAt).toEqual(x.startedAt);
  });

  it("con un lease vigente, otra adquisición devuelve BUSY y no crea nada ni cambia el token", async () => {
    const a = await acquired();
    const before = await lock();
    expect(await svc.acquire(OPTS)).toEqual({ status: "BUSY", reason: "LEASE_HELD" });
    expect(await lock()).toEqual(before);
    expect(await t.prisma.mediaReconcileRun.count()).toBe(1);
    expect((await run(a.runId)).status).toBe("RUNNING");
  });

  it("con el lease caducado: nueva ejecución con token siguiente; la anterior queda ABANDONED con su fecha de fin", async () => {
    const a = await acquired();
    await expire();
    const r = await svc.acquire(OPTS);
    expect(r).toMatchObject({ status: "ACQUIRED", abandoned: 1 });
    if (r.status !== "ACQUIRED") return;
    expect(r.lease.fencingToken).toBe(a.fencingToken + 1);
    expect(await lock()).toMatchObject({ holderRunId: r.lease.runId, fencingToken: r.lease.fencingToken });
    const old = await run(a.runId);
    expect(old).toMatchObject({ status: "ABANDONED", complete: false });
    expect(old.finishedAt!.getTime()).toBeGreaterThanOrEqual(old.startedAt.getTime());
    expect(old.heartbeatAt.getTime()).toBeLessThanOrEqual(old.finishedAt!.getTime());
  });

  it("el fencingToken es estrictamente monotónico y nunca se reutiliza (aunque el contador del lock retroceda o la fila desaparezca)", async () => {
    const tokens: number[] = [];
    for (let i = 0; i < 3; i++) { const l = await acquired(); tokens.push(l.fencingToken); await svc.release(l, COMPLETED); }
    expect(tokens).toEqual([1, 2, 3]);
    await t.prisma.$executeRawUnsafe(`UPDATE "MediaReconcileLock" SET "fencingToken" = 0`); // contador manipulado
    const l4 = await acquired();
    expect(l4.fencingToken).toBe(4);
    await svc.release(l4, COMPLETED);
    await t.prisma.$executeRawUnsafe(`DELETE FROM "MediaReconcileLock"`); // la fila desaparece
    const l5 = await acquired();
    expect(l5.fencingToken).toBe(5);
    expect(await t.prisma.mediaReconcileLock.count()).toBe(1);
  });

  it("si la adquisición falla a mitad, se deshace todo: ni ejecución nueva, ni lock cambiado, ni ABANDONED", async () => {
    const a = await acquired();
    await expire();
    const before = await lock();
    await t.prisma.$executeRawUnsafe(`CREATE FUNCTION test_block_run_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'insercion bloqueada por la prueba'; END $$`);
    await t.prisma.$executeRawUnsafe(`CREATE TRIGGER test_block_run_insert BEFORE INSERT ON "MediaReconcileRun" FOR EACH ROW EXECUTE FUNCTION test_block_run_insert()`);
    try {
      await expect(svc.acquire(OPTS)).rejects.toThrow();
      await heal();
      expect(await lock()).toEqual(before);
      expect(await t.prisma.mediaReconcileRun.count()).toBe(1);
      expect((await run(a.runId)).status).toBe("RUNNING"); // el ABANDONED de la transacción fallida también se deshizo
    } finally {
      await heal();
      await t.prisma.$executeRawUnsafe(`DROP TRIGGER test_block_run_insert ON "MediaReconcileRun"`);
      await t.prisma.$executeRawUnsafe(`DROP FUNCTION test_block_run_insert()`);
    }
  });

  // «No usa el reloj de Node» se prueba en pg-concurrency.test.ts: PGlite corre dentro del proceso de Node y su
  // clock_timestamp() sale del reloj de JavaScript, así que aquí no se puede distinguir un reloj del otro.

  it("token al límite de INTEGER: el último token válido se emite; el siguiente → TOKEN_EXHAUSTED sin crear ni tocar nada", async () => {
    await t.prisma.$executeRawUnsafe(`UPDATE "MediaReconcileLock" SET "fencingToken" = ${MAX_FENCING_TOKEN - 1}`);
    const last = await acquired();
    expect(last.fencingToken).toBe(MAX_FENCING_TOKEN);
    await expire();
    const before = await lock();
    const runsBefore = await t.prisma.mediaReconcileRun.findMany({ orderBy: { id: "asc" } });
    await expect(svc.acquire(OPTS)).rejects.toMatchObject({ name: "MediaLeaseError", code: "TOKEN_EXHAUSTED", message: "Lease del reconciliador: TOKEN_EXHAUSTED" });
    expect(await lock()).toEqual(before); // el lock no cambió
    expect(await t.prisma.mediaReconcileRun.findMany({ orderBy: { id: "asc" } })).toEqual(runsBefore); // ni ejecución nueva ni ABANDONED
    expect((await run(last.runId)).status).toBe("RUNNING");
  });

  it.each([
    ["graceHours < 1", { graceHours: 0.5 }],
    ["graceHours NaN", { graceHours: Number.NaN }],
    ["TTL demasiado corto", { graceHours: 24, ttlMs: 1_000 }],
    ["TTL no entero", { graceHours: 24, ttlMs: 60_000.5 }],
    ["codeVersion vacío", { graceHours: 24, codeVersion: "" }],
  ])("argumentos inválidos (%s) → MediaLeaseError sin tocar la base de datos", async (_n, o) => {
    await expect(svc.acquire(o as never)).rejects.toMatchObject({ name: "MediaLeaseError", code: "INVALID_ARGUMENT" });
    expect(await t.prisma.mediaReconcileRun.count()).toBe(0);
  });
});

describe("renovación y operación protegida", () => {
  it("renueva: nueva expiración y heartbeat con la hora de PostgreSQL; también el heartbeat de la ejecución", async () => {
    const a = await acquired();
    const before = await lock();
    await new Promise((r) => setTimeout(r, 15));
    const r = await svc.renew(a);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const after = await lock();
    expect(after.leaseExpiresAt).toEqual(r.leaseExpiresAt);
    expect(after.leaseExpiresAt!.getTime()).toBeGreaterThan(before.leaseExpiresAt!.getTime());
    expect(after.heartbeatAt!.getTime()).toBeGreaterThan(before.heartbeatAt!.getTime());
    expect((await run(a.runId)).heartbeatAt).toEqual(after.heartbeatAt);
  });

  it.each([
    ["token incorrecto", (l: MediaLease) => ({ ...l, fencingToken: l.fencingToken + 1 })],
    ["propietario incorrecto", (l: MediaLease) => ({ ...l, runId: "otra-ejecucion" })],
  ])("con %s → LEASE_LOST y el lock no cambia", async (_n, alter) => {
    const a = await acquired();
    const before = await lock();
    expect(await svc.renew(alter(a))).toEqual({ ok: false, reason: "LEASE_LOST" });
    expect(await lock()).toEqual(before);
  });

  it("un lease caducado no se puede renovar aunque token y dueño coincidan", async () => {
    const a = await acquired();
    await expire();
    const before = await lock();
    expect(await svc.renew(a)).toEqual({ ok: false, reason: "LEASE_LOST" });
    expect(await lock()).toEqual(before);
  });

  it("withLease ejecuta la operación en la misma transacción que la renovación; si la operación falla, se deshace todo", async () => {
    const a = await acquired();
    const r = await svc.withLease(a, async (tx) => (await tx.$queryRaw<{ n: number }[]>`SELECT 1::int AS n`)[0]!.n);
    expect(r).toMatchObject({ ok: true, value: 1 });
    const before = await lock();
    await expect(svc.withLease(a, async (tx) => {
      await tx.$executeRaw`UPDATE "MediaReconcileRun" SET "codeVersion" = 'dentro' WHERE "id" = ${a.runId}`;
      throw new Error("fallo de la operación");
    })).rejects.toThrow("fallo de la operación");
    expect(await lock()).toEqual(before); // la renovación también se deshizo
    expect((await run(a.runId)).codeVersion).toBeNull();
  });

  it("withLease con la ejecución dueña ya no RUNNING (ABANDONED) → LEASE_LOST, sin ejecutar nada ni renovar el lock", async () => {
    const a = await acquired();
    await t.prisma.$executeRawUnsafe(`UPDATE "MediaReconcileRun" SET "status" = 'ABANDONED', "finishedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
      WHERE "id" = '${a.runId}'`); // preparación: estado incoherente provocado a mano (el lease sigue vigente)
    const before = await lock();
    const fn = vi.fn(async () => 1);
    expect(await svc.withLease(a, fn)).toEqual({ ok: false, reason: "LEASE_LOST" });
    expect(fn).not.toHaveBeenCalled();
    expect(await lock()).toEqual(before); // la renovación se deshizo con la transacción
    expect(await svc.renew(a)).toEqual({ ok: false, reason: "LEASE_LOST" });
  });

  it("withLease con el lease perdido no ejecuta la operación", async () => {
    const a = await acquired();
    await expire();
    const fn = vi.fn(async () => 1);
    expect(await svc.withLease(a, fn)).toEqual({ ok: false, reason: "LEASE_LOST" });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("liberación", () => {
  it("libera: dueño y expiración a NULL y la ejecución terminada con su resultado", async () => {
    const a = await acquired();
    expect(await svc.release(a, COMPLETED)).toEqual({ released: true, runFinalized: true });
    expect(await lock()).toMatchObject({ holderRunId: null, leaseExpiresAt: null, fencingToken: a.fencingToken });
    const x = await run(a.runId);
    expect(x).toMatchObject({ status: "COMPLETED", complete: true, inventoryComplete: true, summary: COMPLETED.summary, errorCodes: [] });
    expect(x.finishedAt!.getTime()).toBeGreaterThanOrEqual(x.startedAt.getTime());
    expect(x.heartbeatAt.getTime()).toBeLessThanOrEqual(x.finishedAt!.getTime());
  });

  it("INCOMPLETE y FAILED con códigos de error", async () => {
    for (const status of ["INCOMPLETE", "FAILED"] as const) {
      const a = await acquired();
      expect(await svc.release(a, { status, inventoryComplete: false, errorCodes: ["inventory/upload/TIME_BUDGET"] })).toEqual({ released: true, runFinalized: true });
      expect(await run(a.runId)).toMatchObject({ status, complete: false, errorCodes: ["inventory/upload/TIME_BUDGET"] });
    }
  });

  it("con token incorrecto no libera nada", async () => {
    const a = await acquired();
    const before = await lock();
    expect(await svc.release({ ...a, fencingToken: a.fencingToken + 7 }, COMPLETED)).toEqual({ released: false, reason: "LEASE_LOST" });
    expect(await lock()).toEqual(before);
    expect((await run(a.runId)).status).toBe("RUNNING");
  });

  it("un propietario antiguo no puede liberar ni renovar el lease de la ejecución nueva", async () => {
    const a = await acquired();
    await expire();
    const b = await acquired();
    const before = await lock();
    expect(await svc.release(a, COMPLETED)).toEqual({ released: false, reason: "LEASE_LOST" });
    expect(await svc.renew(a)).toEqual({ ok: false, reason: "LEASE_LOST" });
    expect(await lock()).toEqual(before);
    expect(before).toMatchObject({ holderRunId: b.runId, fencingToken: b.fencingToken });
    expect((await run(a.runId)).status).toBe("ABANDONED");
  });

  it("con el lease caducado pero sin nadie después, el dueño aún puede cerrar su ejecución", async () => {
    const a = await acquired();
    await expire();
    expect(await svc.release(a, { status: "FAILED", inventoryComplete: false })).toEqual({ released: true, runFinalized: true });
    expect(await lock()).toMatchObject({ holderRunId: null, leaseExpiresAt: null });
  });

  it.each([
    ["COMPLETED sin inventario completo", { status: "COMPLETED", inventoryComplete: false }],
    ["estado no terminal", { status: "RUNNING", inventoryComplete: false }],
    ["código de error vacío", { status: "FAILED", inventoryComplete: false, errorCodes: [""] }],
  ])("resultado inválido (%s) → MediaLeaseError y el lease sigue intacto", async (_n, outcome) => {
    const a = await acquired();
    const before = await lock();
    await expect(svc.release(a, outcome as never)).rejects.toBeInstanceOf(MediaLeaseError);
    expect(await lock()).toEqual(before);
  });
});

describe("recuperación de ejecuciones abandonadas", () => {
  const orphan = async (status = "RUNNING") => {
    const done = status === "COMPLETED";
    const [r] = await t.prisma.$queryRawUnsafe<{ id: string }[]>(`INSERT INTO "MediaReconcileRun" ("id","fencingToken","graceHours","status","complete","inventoryComplete","finishedAt","startedAt","heartbeatAt","updatedAt")
      VALUES (gen_random_uuid()::text, (SELECT COALESCE(MAX("fencingToken"),0) + 100 FROM "MediaReconcileRun"), 24, '${status}', ${done}, ${done},
        ${status === "RUNNING" ? "NULL" : "(clock_timestamp() AT TIME ZONE 'UTC')"}, (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 hour',
        (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 hour', now()) RETURNING "id"`);
    return r!.id;
  };

  it("marca ABANDONED las RUNNING sin lease vigente y no toca las terminales", async () => {
    const x = await orphan();
    const done = await orphan("COMPLETED");
    const failed = await orphan("FAILED");
    expect(await svc.recoverAbandoned()).toBe(1);
    expect((await run(x)).status).toBe("ABANDONED");
    expect((await run(x)).finishedAt).not.toBeNull();
    expect((await run(done)).status).toBe("COMPLETED");
    expect((await run(failed)).status).toBe("FAILED");
  });

  it("sin la fila del lock no abandona nada (no puede serializarse con las adquisiciones) y devuelve 0", async () => {
    const x = await orphan();
    await t.prisma.$executeRawUnsafe(`DELETE FROM "MediaReconcileLock"`);
    expect(await svc.recoverAbandoned()).toBe(0);
    expect((await run(x)).status).toBe("RUNNING");
    expect(await t.prisma.mediaReconcileLock.count()).toBe(0);
  });

  it("respeta a la dueña de un lease vigente; la recupera cuando caduca", async () => {
    const a = await acquired();
    const stray = await orphan();
    expect(await svc.recoverAbandoned()).toBe(1); // solo la huérfana
    expect((await run(a.runId)).status).toBe("RUNNING");
    expect((await run(stray)).status).toBe("ABANDONED");
    await expire();
    expect(await svc.recoverAbandoned()).toBe(1);
    expect((await run(a.runId)).status).toBe("ABANDONED");
    expect(await svc.renew(a)).toEqual({ ok: false, reason: "LEASE_LOST" });
  });
});

describe("API sin dependencia de this", () => {
  it("los métodos se pueden desestructurar: renew, withLease, release, acquire y recoverAbandoned funcionan igual", async () => {
    const { acquire, renew, withLease, release, recoverAbandoned } = svc;
    const r = await acquire(OPTS);
    if (r.status !== "ACQUIRED") throw new Error("no adquirió");
    const before = await lock();
    await new Promise((res) => setTimeout(res, 15));
    const renewed = await renew(r.lease);
    expect(renewed).toMatchObject({ ok: true });
    expect((await lock()).leaseExpiresAt!.getTime()).toBeGreaterThan(before.leaseExpiresAt!.getTime());
    expect(await withLease(r.lease, async () => "ok")).toMatchObject({ ok: true, value: "ok" });
    expect(await renew({ ...r.lease, fencingToken: r.lease.fencingToken + 1 })).toEqual({ ok: false, reason: "LEASE_LOST" });
    expect(await recoverAbandoned()).toBe(0);
    expect(await release(r.lease, COMPLETED)).toEqual({ released: true, runFinalized: true });
  });
});

describe("clasificación de LOCK_TIMEOUT: solo por estructura, nunca por el texto", () => {
  it.each([
    ["que contiene «55P03»", () => new Error("fallo propio: SQLSTATE 55P03 simulado")],
    ["que contiene «lock timeout»", () => new Error("canceling statement due to lock timeout")],
    ["con la forma de meta del adaptador pero sin ser un error de Prisma", () => Object.assign(new Error("imitación"), {
      code: "P2010", meta: { driverAdapterError: { cause: { kind: "postgres", code: "55P03", originalCode: "55P03" } } } })],
  ])("un error de fn %s se propaga TAL CUAL (no LOCK_TIMEOUT) y la renovación se deshace", async (_n, make) => {
    const a = await acquired();
    const before = await lock();
    const own = make();
    const err = await svc.withLease(a, async () => { throw own; }).then(() => null, (e: unknown) => e);
    expect(err).toBe(own); // el mismo objeto: ni MediaLeaseError ni LOCK_TIMEOUT
    expect(err).not.toBeInstanceOf(MediaLeaseError);
    expect(await lock()).toEqual(before);
  });
  // El reconocimiento de un lock_timeout REAL de PostgreSQL (55P03 del adaptador) se prueba en pg-concurrency.test.ts:
  // con PGlite (una sola sesión) no hay forma de provocar una espera por bloqueo.
});

describe("integridad y errores", () => {
  it("la ejecución dueña del lease no se puede borrar ni cambiar de token (FK compuesta RESTRICT)", async () => {
    const a = await acquired();
    await expect(t.prisma.mediaReconcileRun.delete({ where: { id: a.runId } })).rejects.toMatchObject({ code: "P2003" });
    await heal();
    await expect(t.prisma.mediaReconcileRun.update({ where: { id: a.runId }, data: { fencingToken: 999 } })).rejects.toMatchObject({ code: "P2003" });
    await heal();
    expect(await lock()).toMatchObject({ holderRunId: a.runId, fencingToken: a.fencingToken });
  });

  it("los errores públicos no contienen identificadores, tokens ni SQL", async () => {
    const e = await svc.acquire({ graceHours: 0 } as never).catch((x: Error) => x);
    expect(e).toBeInstanceOf(MediaLeaseError);
    expect((e as Error).message).toBe("Lease del reconciliador: INVALID_ARGUMENT");
  });
});
