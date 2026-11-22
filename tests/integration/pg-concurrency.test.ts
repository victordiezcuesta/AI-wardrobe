import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { prismaProxy, setTestEnv } from "../helpers/mock-prisma";
import { applyMigrations, listMigrations } from "../helpers/migrations";

/**
 * Concurrencia REAL entre transacciones: PostgreSQL de verdad con varias conexiones independientes (PGlite no sirve:
 * es de una sola sesión). Solo se ejecuta si TEST_PG_URL apunta a un PostgreSQL LOCAL y desechable. Cómo levantarlo,
 * ejecutar estas pruebas y limpiarlo (también si el contenedor o el volumen ya existen): README, «11. Tests» →
 * «Concurrencia con PostgreSQL real». Resumen:
 *
 *   docker start ai-wardrobe-pgrace   # o, la primera vez: docker run … --tmpfs /var/lib/postgresql/data postgres:17-alpine
 *   PGPASSWORD=<contraseña del contenedor, vía docker inspect> \
 *     TEST_PG_URL=postgresql://postgres@127.0.0.1:55432/postgres npx vitest run tests/integration/pg-concurrency.test.ts
 *
 * Cada ejecución crea su propia base de datos (race_<aleatorio>), aplica la migración del proyecto y la elimina al
 * terminar. Se niega a ejecutarse contra hosts que no sean locales. Cloudinary está simulado (sin llamadas reales).
 */
const ADMIN_URL = process.env.TEST_PG_URL;
const isLocal = (u: string) => ["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(u).hostname);

const holder = vi.hoisted(() => ({ prisma: null as PrismaClient | null }));
const cloud = vi.hoisted(() => ({
  stored: new Set<string>(),
  deleted: [] as string[],
  /** Se ejecuta en cada borrado ANTES de completarlo (para observar el estado de la base de datos en ese instante). */
  onDelete: null as ((id: string) => Promise<void>) | null,
}));
vi.mock("@/lib/prisma", () => ({ prisma: prismaProxy(holder) }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: () => undefined }));
vi.mock("@/lib/pollinations/client", () => ({ editImage: async () => Buffer.alloc(0) }));
vi.mock("@/lib/cloudinary", () => {
  const remove = async (ids: string[]) => {
    for (const id of ids) { await cloud.onDelete?.(id); cloud.deleted.push(id); cloud.stored.delete(id); } // idempotente, como Cloudinary
  };
  return {
    signedUrl: (id: string) => `https://api.cloudinary.com/signed/${id}`,
    uploadPrivate: async () => { throw new Error("no usado"); },
    deletePrivateImages: remove,
    deleteImage: async (id: string | null | undefined) => { if (id) await remove([id]); },
    deleteImages: remove,
  };
});

let dbName = "";
let app: PrismaClient; // la que usan los servicios: pool de 4 conexiones, transacciones realmente en paralelo
let other: PrismaClient; // conexión independiente para mantener abierta «la otra» transacción
let monitor: PrismaClient; // conexión independiente para observar esperas de bloqueo

const client = (url: string, max: number) => new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max }) });

beforeAll(async () => {
  if (!ADMIN_URL) return;
  if (!isLocal(ADMIN_URL)) throw new Error("TEST_PG_URL debe apuntar a un PostgreSQL local y desechable");
  setTestEnv();
  dbName = `race_${Math.random().toString(36).slice(2, 10)}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  const setup = new pg.Client({ connectionString: url.toString() });
  await setup.connect();
  try { await applyMigrations((sql) => setup.query(sql), listMigrations()); } finally { await setup.end(); }
  app = client(url.toString(), 4);
  other = client(url.toString(), 1);
  monitor = client(url.toString(), 1);
  holder.prisma = app;
}, 60_000);

/** Nombre de la base temporal de ESTA ejecución: lo único que la limpieza puede borrar. */
const TEMP_DB = /^race_[a-z0-9]{1,8}$/;

afterAll(async () => {
  if (!ADMIN_URL || !dbName) return;
  if (!TEMP_DB.test(dbName)) throw new Error("Nombre de base de datos temporal inesperado: no se borra nada");
  // Primero se elimina la base temporal con FORCE, que termina también las sesiones que sigan conectadas (incluida una
  // transacción retenida por una prueba que haya fallado): la limpieza no depende de que $disconnect() termine antes.
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
  await Promise.all([app?.$disconnect(), other?.$disconnect(), monitor?.$disconnect()]);
});

beforeEach(() => {
  if (!ADMIN_URL) return;
  holder.prisma = app;
  cloud.stored.clear(); cloud.deleted = []; cloud.onDelete = null;
});

/** Promesa abrible desde fuera. */
function gate() { let open!: () => void; const wait = new Promise<void>((r) => { open = r; }); return { wait, open }; }
/** Espera a que `inside` se abra; si `op` termina antes (p. ej. con un error), falla en ese momento en vez de colgarse. */
const reached = (inside: { wait: Promise<void> }, op: Promise<unknown>) =>
  Promise.race([inside.wait, op.then(
    () => { throw new Error("La operación terminó sin llegar a retener su transacción"); },
    (e: unknown) => { throw e; },
  )]);
const settled = async (p: Promise<unknown>) => Promise.race([p.then(() => true, () => true), new Promise((r) => setTimeout(() => r(false), 0))]);

/** Sesiones de ESTA base de datos que están esperando un bloqueo (pg_stat_activity). */
async function lockWaiters(): Promise<number> {
  const [r] = await monitor.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock'`;
  return r!.n;
}
async function waitForLockWaiters(n: number, timeoutMs = 5_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if ((await lockWaiters()) >= n) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error(`Ninguna transacción llegó a esperar un bloqueo (esperadas ${n})`);
}

const newUser = () => app.user.create({ data: { email: `c${Math.random().toString(36).slice(2)}@q.com` } });
async function sharedItems(userId: string, n: number) {
  const imagePublicId = `ai-wardrobe/${userId}/wardrobe/src-${Math.random().toString(36).slice(2)}`;
  cloud.stored.add(imagePublicId);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push((await app.wardrobeItem.create({ data: { userId, name: `P${i}`, category: "OTHER", imagePublicId } })).id);
  return { ids, imagePublicId };
}
const services = async () => ({
  wardrobe: (await import("@/services/wardrobe.service")).wardrobeService,
  tryOn: (await import("@/services/tryon.service")).tryOnService,
});

describe.skipIf(!ADMIN_URL)("PostgreSQL real con varias conexiones", () => {
  describe("prendas que comparten foto (SELECT … FOR UPDATE)", () => {
    it("B espera de verdad a la transacción de A; la foto se borra una vez, cuando B es la última referencia", async () => {
      const u = await newUser();
      const { wardrobe } = await services();
      const { ids, imagePublicId } = await sharedItems(u.id, 2);
      // Estado de la base de datos en el instante en que se pide borrar la foto.
      const refsAtDelete: number[] = [];
      cloud.onDelete = async (id) => { if (id === imagePublicId) refsAtDelete.push(await monitor.wardrobeItem.count({ where: { imagePublicId } })); };

      // A ejecuta su transacción real (bloquea, decide y borra su prenda) y se queda SIN confirmar hasta que la soltemos.
      const inside = gate();
      const release = gate();
      let gated = true;
      holder.prisma = new Proxy(app, {
        get(target, prop) {
          if (prop === "$transaction" && gated) {
            gated = false;
            return (cb: (tx: unknown) => Promise<unknown>, opts?: object) =>
              target.$transaction(async (tx) => { const r = await cb(tx); inside.open(); await release.wait; return r; }, { ...opts, timeout: 20_000 });
          }
          const v = Reflect.get(target, prop, target) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      }) as PrismaClient;

      const pA = wardrobe.remove(u.id, ids[0]!);
      let pB: Promise<void> | undefined;
      try {
        await reached(inside, pA); // A tiene las filas bloqueadas y su prenda borrada, sin confirmar
        pB = wardrobe.remove(u.id, ids[1]!); // otra conexión del pool
        await waitForLockWaiters(1); // B está bloqueada en el FOR UPDATE (pg_stat_activity: wait_event_type = Lock)
        expect(await settled(pB)).toBe(false);
        expect(cloud.deleted).toEqual([]); // nadie ha borrado la foto mientras A no confirma
      } finally {
        release.open(); // también si una aserción falla: la transacción de A no queda retenida
      }
      await Promise.all([pA, pB]);
      expect(await app.wardrobeItem.count({ where: { id: { in: ids } } })).toBe(0);
      expect(cloud.deleted.filter((d) => d === imagePublicId)).toHaveLength(1); // una sola vez
      expect(refsAtDelete).toEqual([1]); // al borrarla solo quedaba la prenda que se estaba borrando
      expect(cloud.stored.has(imagePublicId)).toBe(false); // sin huérfana
    });

    it("carga real: 25 rondas de 2 y de 3 borrados en paralelo (4 conexiones) → nunca queda la foto huérfana ni se borra antes de tiempo", async () => {
      const u = await newUser();
      const { wardrobe } = await services();
      for (let round = 0; round < 25; round++) {
        for (const n of [2, 3]) {
          const { ids, imagePublicId } = await sharedItems(u.id, n);
          const early: string[] = [];
          cloud.onDelete = async (id) => { if (id === imagePublicId && (await monitor.wardrobeItem.count({ where: { imagePublicId } })) > 1) early.push(id); };
          await Promise.all(ids.map((id) => wardrobe.remove(u.id, id)));
          expect(early).toEqual([]);
          expect(await app.wardrobeItem.count({ where: { id: { in: ids } } })).toBe(0);
          expect(cloud.stored.has(imagePublicId)).toBe(false);
        }
      }
    }, 60_000);
  });

  describe("probador: DELETE condicionado frente a la finalización de la generación", () => {
    async function generation(data: { status: "PROCESSING" | "COMPLETED"; publicId: string | null }) {
      const u = await newUser();
      const row = await app.generatedImage.create({ data: { userId: u.id, scenario: "studio", pose: "standing", ...data } });
      if (data.publicId) cloud.stored.add(data.publicId);
      return { userId: u.id, id: row.id };
    }

    it("la generación guarda su resultado en otra transacción mientras se borra → el DELETE espera, re-evalúa y no deja huérfano", async () => {
      const { userId, id } = await generation({ status: "PROCESSING", publicId: null });
      const { tryOn } = await services();
      const result = `ai-wardrobe/${userId}/try-on/result-1`;
      cloud.stored.add(result);

      // «run()» en otra conexión: guarda el resultado (mismo UPDATE que run) y aún no confirma.
      const inside = gate();
      const release = gate();
      const held = other.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE "GeneratedImage" SET "status" = 'COMPLETED', "publicId" = ${result}, "updatedAt" = now() WHERE "id" = ${id}`;
        inside.open();
        await release.wait;
      }, { timeout: 20_000 });
      let pR: Promise<void> | undefined;
      try {
        await reached(inside, held);
        pR = tryOn.remove(userId, id); // lee la versión confirmada (sin resultado) y lanza su DELETE condicionado
        await waitForLockWaiters(1); // el DELETE espera el bloqueo de fila del UPDATE
        expect(await settled(pR)).toBe(false);
      } finally {
        release.open(); // también si una aserción falla: la transacción retenida termina
      }
      await held;
      await pR; // re-evalúa: publicId ya no coincide → 0 filas → relee → borra el resultado → borra la fila
      expect(await app.generatedImage.findUnique({ where: { id } })).toBeNull();
      expect(cloud.deleted).toContain(result);
      expect(cloud.stored.has(result)).toBe(false);
    });

    it("dos borrados de la misma generación en conexiones distintas, bloqueados a la vez → la fila se borra una vez, sin errores ni huérfanos", async () => {
      const result = `ai-wardrobe/x/try-on/result-${Math.random()}`;
      const { userId, id } = await generation({ status: "COMPLETED", publicId: result });
      const { tryOn } = await services();
      // Un bloqueo de fila ajeno hace que los dos DELETE coincidan esperando.
      const inside = gate();
      const release = gate();
      const held = other.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "GeneratedImage" WHERE "id" = ${id} FOR UPDATE`;
        inside.open();
        await release.wait;
      }, { timeout: 20_000 });
      let both: Promise<PromiseSettledResult<void>[]> | undefined;
      try {
        await reached(inside, held);
        both = Promise.allSettled([tryOn.remove(userId, id), tryOn.remove(userId, id)]);
        await waitForLockWaiters(2);
      } finally {
        release.open(); // también si una aserción falla: la transacción retenida termina
      }
      await held;
      const results = await both!;
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]); // el segundo re-evalúa: ya no existe → hecho
      expect(await app.generatedImage.findUnique({ where: { id } })).toBeNull();
      expect(cloud.stored.has(result)).toBe(false);
    });
  });
});

describe.skipIf(!ADMIN_URL)("lease del reconciliador de medios (bloqueo real de la fila del lock)", () => {
  const OPTS = { graceHours: 24, ttlMs: 60_000, lockTimeoutMs: 10_000 };
  const COMPLETED = { status: "COMPLETED" as const, inventoryComplete: true };
  /** Cuarta conexión independiente: retiene filas (como recoverAbandoned: SELECT … FOR UPDATE sin modificarlas). */
  let holderDb: PrismaClient;
  beforeAll(() => {
    if (!ADMIN_URL) return;
    const url = new URL(ADMIN_URL);
    url.pathname = `/${dbName}`;
    holderDb = client(url.toString(), 1);
  });
  afterAll(async () => { await holderDb?.$disconnect(); });
  const leaseSvc = async () => {
    const { createMediaLease } = await import("@/services/media-lease.service");
    return { a: createMediaLease(app), b: createMediaLease(other) }; // A y B: procesos con conexiones independientes
  };
  const lockRow = () => monitor.mediaReconcileLock.findUniqueOrThrow({ where: { name: "media-reconcile" } });
  const runStatus = async (id: string) => (await monitor.mediaReconcileRun.findUniqueOrThrow({ where: { id } })).status;
  const LOCK_STMT = `SELECT 1 FROM "MediaReconcileLock" WHERE "name" = 'media-reconcile' FOR UPDATE`;
  /** Retiene una fila en una transacción de holderDb hasta abrir `done` (sin modificarla). */
  async function hold(stmt = LOCK_STMT) {
    const inside = gate(); const done = gate();
    const p = holderDb.$transaction(async (tx) => { await tx.$queryRawUnsafe(stmt); inside.open(); await done.wait; }, { maxWait: 10_000, timeout: 60_000 });
    await reached(inside, p);
    return { release: async () => { done.open(); await p; } };
  }
  /** Simula que el lease vigente caducó (SQL de preparación, fuera de cualquier operación del servicio). */
  const expireNow = () => app.$executeRawUnsafe(`UPDATE "MediaReconcileLock" SET "heartbeatAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '2 seconds',
    "leaseExpiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second' WHERE "holderRunId" IS NOT NULL`);
  beforeEach(async () => {
    if (!ADMIN_URL) return;
    await app.$executeRawUnsafe(`UPDATE "MediaReconcileLock" SET "holderRunId" = NULL, "leaseExpiresAt" = NULL, "heartbeatAt" = NULL, "fencingToken" = 0`);
    await app.$executeRawUnsafe(`DELETE FROM "MediaAsset"`);
    await app.$executeRawUnsafe(`DELETE FROM "MediaReconcileRun"`);
  });
  async function acquiredBy(svc: Awaited<ReturnType<typeof leaseSvc>>["a"]) {
    const r = await svc.acquire(OPTS);
    if (r.status !== "ACQUIRED") throw new Error("no adquirió");
    return r.lease;
  }

  it("A retiene la fila del lock en una operación protegida; B espera; al terminar A, B adquiere y A ya no puede renovar, operar ni liberar", async () => {
    const { a: svcA, b: svcB } = await leaseSvc();
    const la = await acquiredBy(svcA);
    const inside = gate(); const done = gate();
    // Operación protegida de A: la fila del lock queda bloqueada hasta el final de su transacción. Dentro, A deja
    // caducar su propio lease (simula que su tiempo se agota mientras trabaja).
    const pA = svcA.withLease(la, async (tx) => {
      inside.open();
      await done.wait;
      await tx.$executeRaw`UPDATE "MediaReconcileLock" SET "heartbeatAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '2 seconds',
        "leaseExpiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second' WHERE "name" = 'media-reconcile'`;
      return "A";
    }, OPTS);
    await reached(inside, pA);
    const pB = svcB.acquire(OPTS);
    await waitForLockWaiters(1); // B espera de verdad (pg_stat_activity)
    expect(await settled(pB)).toBe(false);
    done.open();
    expect(await pA).toMatchObject({ ok: true, value: "A" });
    const rb = await pB;
    expect(rb).toMatchObject({ status: "ACQUIRED", abandoned: 1 });
    if (rb.status !== "ACQUIRED") return;
    expect(rb.lease.fencingToken).toBe(la.fencingToken + 1);
    const held = await lockRow();
    expect(held).toMatchObject({ holderRunId: rb.lease.runId, fencingToken: rb.lease.fencingToken });
    const fn = vi.fn(async () => "no");
    expect(await svcA.renew(la, OPTS)).toEqual({ ok: false, reason: "LEASE_LOST" });
    expect(await svcA.withLease(la, fn, OPTS)).toEqual({ ok: false, reason: "LEASE_LOST" });
    expect(fn).not.toHaveBeenCalled();
    expect(await svcA.release(la, COMPLETED, OPTS)).toEqual({ released: false, reason: "LEASE_LOST" });
    expect(await lockRow()).toEqual(held); // A nunca modifica el lease de B
    expect(await runStatus(la.runId)).toBe("ABANDONED");
    expect(await svcB.renew(rb.lease, OPTS)).toMatchObject({ ok: true });
  });

  it("I1: la renovación de A espera tras una transacción que solo RETIENE el lock (como recoverAbandoned); si el lease caduca durante la espera, falla", async () => {
    const { a: svcA } = await leaseSvc();
    const la = await acquiredBy(svcA);
    await app.$executeRawUnsafe(`UPDATE "MediaReconcileLock" SET "heartbeatAt" = (clock_timestamp() AT TIME ZONE 'UTC'),
      "leaseExpiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') + interval '1500 milliseconds'`); // vence en 1,5 s
    const h = await hold();
    const pRenew = svcA.renew(la, OPTS);
    await waitForLockWaiters(1);
    // Se espera (condición, no un sleep fijo) a que el reloj de PostgreSQL supere la expiración mientras A espera.
    for (let end = Date.now() + 10_000; ; ) {
      const [r] = await monitor.$queryRaw<{ expired: boolean }[]>`SELECT "leaseExpiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC') AS expired FROM "MediaReconcileLock"`;
      if (r!.expired) break;
      if (Date.now() > end) throw new Error("el lease no llegó a caducar");
      await new Promise((r2) => setTimeout(r2, 50));
    }
    expect(await settled(pRenew)).toBe(false); // sigue esperando el bloqueo
    const before = await lockRow();
    await h.release();
    expect(await pRenew).toEqual({ ok: false, reason: "LEASE_LOST" }); // la vigencia se comprobó DESPUÉS de obtener el bloqueo
    expect(await lockRow()).toEqual(before);
    expect(await runStatus(la.runId)).toBe("RUNNING");
  });

  it("adquisición de B y renovación de A concurrentes tras la caducidad: se serializan; B adquiere y A no renueva (en cualquier orden)", async () => {
    const { a: svcA, b: svcB } = await leaseSvc();
    const la = await acquiredBy(svcA);
    await expireNow();
    const h = await hold();
    const pB = svcB.acquire(OPTS);
    await waitForLockWaiters(1);
    const pA = svcA.renew(la, OPTS);
    await waitForLockWaiters(2); // las dos esperan a la vez la misma fila
    await h.release();
    const [rb, ra] = await Promise.all([pB, pA]);
    expect(rb).toMatchObject({ status: "ACQUIRED" });
    expect(ra).toEqual({ ok: false, reason: "LEASE_LOST" });
    if (rb.status !== "ACQUIRED") return;
    expect(await lockRow()).toMatchObject({ holderRunId: rb.lease.runId, fencingToken: la.fencingToken + 1 });
    expect(await runStatus(la.runId)).toBe("ABANDONED");
  });

  it("recoverAbandoned concurrente con acquire: nunca abandona la ejecución recién adquirida (en cualquier orden)", async () => {
    const { a: svcA, b: svcB } = await leaseSvc();
    const la = await acquiredBy(svcA);
    await expireNow();
    const h = await hold();
    const pB = svcB.acquire(OPTS);
    await waitForLockWaiters(1);
    const pR = svcA.recoverAbandoned(OPTS);
    await waitForLockWaiters(2);
    await h.release();
    const [rb] = await Promise.all([pB, pR]);
    expect(rb).toMatchObject({ status: "ACQUIRED" });
    if (rb.status !== "ACQUIRED") return;
    expect(await runStatus(rb.lease.runId)).toBe("RUNNING"); // la nueva dueña sigue RUNNING
    expect(await runStatus(la.runId)).toBe("ABANDONED");
    expect(await lockRow()).toMatchObject({ holderRunId: rb.lease.runId });
    expect(await monitor.mediaReconcileRun.count({ where: { status: "RUNNING" } })).toBe(1);
    expect(await svcB.renew(rb.lease, OPTS)).toMatchObject({ ok: true });
  });

  it.each([
    ["vigente", false],
    ["caducado", true],
  ])("release concurrente con acquire (lease %s): el lock y las ejecuciones quedan siempre coherentes", async (_n, expired) => {
    const { a: svcA, b: svcB } = await leaseSvc();
    const la = await acquiredBy(svcA);
    if (expired) await expireNow();
    const h = await hold();
    const pRel = svcA.release(la, COMPLETED, OPTS);
    await waitForLockWaiters(1);
    const pB = svcB.acquire(OPTS);
    await waitForLockWaiters(2);
    await h.release();
    const [rel, rb] = await Promise.all([pRel, pB]);
    const lk = await lockRow();
    const aStatus = await runStatus(la.runId);
    if (rel.released) {
      expect(aStatus).toBe("COMPLETED"); // liberación y cierre juntos
    } else {
      expect(rel).toEqual({ released: false, reason: "LEASE_LOST" }); // B entró antes con el lease caducado
      expect(expired).toBe(true);
      expect(aStatus).toBe("ABANDONED");
    }
    if (rb.status === "ACQUIRED") {
      expect(lk).toMatchObject({ holderRunId: rb.lease.runId, fencingToken: la.fencingToken + 1 });
      expect(await runStatus(rb.lease.runId)).toBe("RUNNING");
    } else {
      expect(rb).toEqual({ status: "BUSY", reason: "LEASE_HELD" }); // B entró antes con el lease vigente
      expect(lk).toMatchObject({ holderRunId: null, leaseExpiresAt: null });
    }
    const running = await monitor.mediaReconcileRun.findMany({ where: { status: "RUNNING" }, select: { id: true } });
    expect(running.map((r) => r.id)).toEqual(lk.holderRunId ? [lk.holderRunId] : []); // ninguna RUNNING sin lease
  });

  it("dos adquisiciones que esperan A LA VEZ la fila del lock libre: exactamente una lo obtiene (10 rondas con solapamiento garantizado)", async () => {
    const { a: svcA, b: svcB } = await leaseSvc();
    for (let round = 0; round < 10; round++) {
      await app.$executeRawUnsafe(`UPDATE "MediaReconcileLock" SET "holderRunId" = NULL, "leaseExpiresAt" = NULL`);
      const h = await hold();
      const pa = svcA.acquire(OPTS);
      const pb = svcB.acquire(OPTS);
      await waitForLockWaiters(2); // solapamiento demostrado: ambas esperan la fila
      await h.release();
      const rs = await Promise.all([pa, pb]);
      expect(rs.filter((r) => r.status === "ACQUIRED")).toHaveLength(1);
      expect(rs.filter((r) => r.status === "BUSY")).toEqual([{ status: "BUSY", reason: "LEASE_HELD" }]);
      const won = rs.find((r) => r.status === "ACQUIRED")!;
      if (won.status !== "ACQUIRED") return;
      expect(await lockRow()).toMatchObject({ holderRunId: won.lease.runId, fencingToken: round + 1 });
    }
    expect(await monitor.mediaReconcileRun.count({ where: { status: "RUNNING" } })).toBe(1);
  });

  it("mientras A retiene el lock con su lease VIGENTE, B espera y, al entrar, obtiene BUSY (el lease sigue siendo de A)", async () => {
    const { a: svcA, b: svcB } = await leaseSvc();
    const la = await acquiredBy(svcA);
    const inside = gate(); const done = gate();
    const pA = svcA.withLease(la, async () => { inside.open(); await done.wait; return "A"; }, OPTS);
    await reached(inside, pA);
    const pB = svcB.acquire(OPTS);
    await waitForLockWaiters(1);
    expect(await settled(pB)).toBe(false);
    done.open();
    await pA;
    expect(await pB).toEqual({ status: "BUSY", reason: "LEASE_HELD" });
    expect(await lockRow()).toMatchObject({ holderRunId: la.runId, fencingToken: la.fencingToken });
    expect(await monitor.mediaReconcileRun.count()).toBe(1);
  });

  describe("tiempos de espera: LOCK_TIMEOUT, nunca un falso LEASE_LOST", () => {
    it("acquire, renew y release esperando la fila del lock más que su lock_timeout → LOCK_TIMEOUT y nada cambia", async () => {
      const { a: svcA, b: svcB } = await leaseSvc();
      const la = await acquiredBy(svcA);
      const h = await hold();
      const before = await lockRow();
      const short = { ...OPTS, lockTimeoutMs: 300 };
      expect(await svcB.acquire(short)).toEqual({ status: "BUSY", reason: "LOCK_TIMEOUT" });
      expect(await svcA.renew(la, short)).toEqual({ ok: false, reason: "LOCK_TIMEOUT" });
      expect(await svcA.release(la, COMPLETED, short)).toEqual({ released: false, reason: "LOCK_TIMEOUT" });
      await expect(svcA.recoverAbandoned(short)).rejects.toMatchObject({ name: "MediaLeaseError", code: "LOCK_TIMEOUT" });
      await h.release();
      expect(await lockRow()).toEqual(before);
      expect(await runStatus(la.runId)).toBe("RUNNING");
      expect(await svcA.renew(la, OPTS)).toMatchObject({ ok: true }); // el lease no se había perdido
    });

    it("un lock_timeout DENTRO de la operación protegida no es LEASE_LOST: error controlado y la renovación se deshace", async () => {
      const { a: svcA } = await leaseSvc();
      const la = await acquiredBy(svcA);
      const u = await newUser();
      const h = await hold(`SELECT 1 FROM "User" WHERE "id" = '${u.id}' FOR UPDATE`); // fila de datos ocupada por otro
      const before = await lockRow();
      const err = await svcA.withLease(la, async (tx) => tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${u.id} FOR UPDATE`, { ...OPTS, lockTimeoutMs: 300 })
        .then(() => null, (e: Error) => e);
      await h.release();
      expect(err).toMatchObject({ name: "MediaLeaseError", code: "LOCK_TIMEOUT", message: "Lease del reconciliador: LOCK_TIMEOUT" });
      expect(await lockRow()).toEqual(before); // la renovación de esa transacción se deshizo
      expect(await svcA.renew(la, OPTS)).toMatchObject({ ok: true }); // el lease sigue siendo de A
    });
  });

  it("no usa el reloj de Node: con la hora del sistema en 2099, el lease se calcula con el reloj de PostgreSQL", async () => {
    const { a: svcA } = await leaseSvc();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2099-01-01T00:00:00Z"));
    let r: Awaited<ReturnType<typeof svcA.acquire>>;
    try { r = await svcA.acquire(OPTS); } finally { vi.useRealTimers(); }
    if (r.status !== "ACQUIRED") throw new Error("no adquirió");
    const [row] = await monitor.$queryRaw<{ now: Date }[]>`SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS now`;
    const now = row!.now;
    expect(r.lease.leaseExpiresAt.getUTCFullYear()).not.toBe(2099);
    expect(Math.abs(r.lease.leaseExpiresAt.getTime() - (now.getTime() + 60_000))).toBeLessThan(10_000);
  });
});
