import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
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
    deleteAllUserAssets: async () => undefined, // borrado de cuentas (fase 19.6.3): Cloudinary simulado
    APP_ROOT_PREFIX: "ai-wardrobe/", // detector (fase 19.7): el inventario se inyecta en cada prueba (listPage)
  };
});

let dbName = "";
let app: PrismaClient; // la que usan los servicios: pool de 4 conexiones, transacciones realmente en paralelo
let other: PrismaClient; // conexión independiente para mantener abierta «la otra» transacción
let monitor: PrismaClient; // conexión independiente para observar esperas de bloqueo

/**
 * Identificador EXCLUSIVO de las sesiones de esta ejecución (application_name, que pg aplica a cada conexión del pool).
 * La conexión monitor lleva otro distinto: la terminación forzosa nunca puede alcanzarla.
 */
const SUITE_APP = `aiw-pgc-${randomUUID().slice(0, 8)}`;
const MONITOR_APP = `${SUITE_APP}-monitor`;
const client = (url: string, max: number, applicationName = SUITE_APP) =>
  new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max, application_name: applicationName }) });

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
  monitor = client(url.toString(), 1, MONITOR_APP);
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

type Termination = { targeted: number[]; remaining: number[] };
/**
 * Termina SOLO las sesiones de esta ejecución: base temporal de esta ejecución (race_…), application_name exacto de la
 * suite y nunca la propia conexión monitor (que además lleva otro nombre y desde la que se ejecuta). Se niega a actuar si
 * monitor no es quien debe ser. Después espera a que esas sesiones desaparezcan y devuelve las que no lo hicieron.
 */
async function terminateSuiteSessions(waitMs = 5_000): Promise<Termination> {
  if (!TEMP_DB.test(dbName)) throw new Error("Base de datos temporal inesperada: no se termina ninguna sesión");
  const [me] = await monitor.$queryRaw<{ name: string; db: string }[]>`SELECT current_setting('application_name') AS name, current_database() AS db`;
  if (me?.name !== MONITOR_APP || me.db !== dbName) throw new Error("La conexión monitor no es la esperada: no se termina ninguna sesión");
  const killed = await monitor.$queryRaw<{ pid: number; ok: boolean }[]>`SELECT pid, pg_terminate_backend(pid) AS ok FROM pg_stat_activity
    WHERE datname = ${dbName} AND application_name = ${SUITE_APP} AND pid <> pg_backend_pid()`;
  const targeted = killed.map((k) => k.pid);
  let remaining = targeted;
  const end = Date.now() + waitMs;
  while (remaining.length > 0 && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 50));
    const alive = new Set((await monitor.$queryRaw<{ pid: number }[]>`SELECT pid FROM pg_stat_activity WHERE datname = ${dbName}`).map((a) => a.pid));
    remaining = targeted.filter((pid) => alive.has(pid));
  }
  return { targeted, remaining };
}

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
  /**
   * Limpieza garantizada, equivalente a un `finally` por prueba: cada retención (hold), barrera `done` y operación de
   * los servicios creada en una prueba queda registrada, y el afterEach la cierra SIEMPRE, también si una aserción falló
   * a mitad: abre las barreras, libera las retenciones (idempotente; acotadas por lock_timeout) y espera a que terminen
   * todas las operaciones (Promise.allSettled).
   * - Si no termina en CLEANUP_LIMIT_MS: termina a la fuerza las sesiones de la suite (terminateSuiteSessions), espera a
   *   que lo registrado se resuelva y marca la suite como CONTAMINADA (también si la terminación falla).
   * - Si la prueba agotó su tiempo (ctx.signal): su cuerpo puede seguir ejecutándose → suite CONTAMINADA.
   * - Con la suite contaminada, las pruebas siguientes fallan en el beforeEach, antes de abrir ninguna transacción.
   * - El registro de cada prueba se cierra al empezar su limpieza: lo que se intente crear después (por una prueba que
   *   sigue ejecutándose) se rechaza sin ejecutarse y nunca se registra en la prueba siguiente.
   */
  type Registry = { closed: boolean; gates: { open: () => void }[]; holds: { reached: boolean; release: () => Promise<void> }[]; ops: Promise<unknown>[] };
  class CleanupTimeoutError extends Error {
    constructor(message: string, readonly report: Termination | null, readonly settled: boolean, cause?: unknown) { super(message, { cause }); }
  }
  async function within<T>(p: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: false }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([p.then((value) => ({ done: true as const, value })), new Promise<{ done: false }>((r) => { timer = setTimeout(() => r({ done: false }), ms); })]);
    } finally { clearTimeout(timer); }
  }
  function createTestTracker(opts: { limitMs: number; terminateMs?: number; settleMs: number; terminate: () => Promise<Termination> }) {
    const terminateMs = opts.terminateMs ?? 10_000;
    let current: Registry | null = null;
    let contaminated: Error | null = null;
    const blocked = () => new Error(`Suite contaminada: no se ejecuta ninguna operación. Causa: ${contaminated!.message}`, { cause: contaminated });
    const registry = (): Registry => {
      if (contaminated) throw blocked();
      if (!current || current.closed) throw new Error("Recurso creado fuera de una prueba activa (una prueba ya cerrada sigue ejecutándose): no se crea ni se registra");
      return current;
    };
    return {
      get contaminated() { return contaminated; },
      registry,
      /** Para el beforeEach: falla (sin abrir nada) si la suite está contaminada. */
      begin() { if (contaminated) throw blocked(); current = { closed: false, gates: [], holds: [], ops: [] }; },
      /** Para el afterEach. */
      async finish(signal?: AbortSignal) {
        const reg = current; current = null;
        if (!reg) return;
        reg.closed = true;
        for (const g of reg.gates) g.open();
        const cleanup = (async () => {
          const released = await Promise.allSettled(reg.holds.map((h) => h.release()));
          await Promise.allSettled(reg.ops);
          // Una retención que no llegó a retener nada ya devolvió su error a la prueba (hold() lo lanza): no es una fuga.
          return released.flatMap((r, i) => (r.status === "rejected" && reg.holds[i]!.reached ? [r.reason as unknown] : []));
        })();
        const first = await within(cleanup, opts.limitMs);
        if (first.done) {
          if (first.value.length > 0) throw new Error("Una retención de la prueba terminó con error al liberarla", { cause: first.value[0] });
          if (signal?.aborted) {
            contaminated = new Error("Una prueba agotó su tiempo y su cuerpo puede seguir ejecutándose");
            throw contaminated;
          }
          return;
        }
        // Contaminada YA, antes de terminar nada: no hay ninguna ventana en la que la suite se considere limpia.
        contaminated = new Error(`La limpieza de la prueba no terminó en ${opts.limitMs} ms (terminación forzosa en curso)`);
        let report: Termination | null = null; let termError: unknown; let termTimedOut = false;
        const term = await within(opts.terminate().then((r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, e })), terminateMs);
        if (!term.done) termTimedOut = true;
        else if (term.value.ok) report = term.value.r;
        else termError = term.value.e;
        const after = await within(cleanup, opts.settleMs);
        const parts = [`La limpieza de la prueba no terminó en ${opts.limitMs} ms`];
        if (termTimedOut) parts.push(`la terminación forzosa NO se completó en ${terminateMs} ms`);
        else if (!report) parts.push("la terminación forzosa FALLÓ");
        else {
          parts.push(`sesiones de la suite terminadas: [${report.targeted.join(", ")}]`);
          parts.push(report.remaining.length > 0 ? `NO se pudieron terminar: [${report.remaining.join(", ")}]` : "ninguna sigue abierta");
        }
        parts.push(after.done ? "operaciones registradas resueltas" : `quedan operaciones registradas sin resolver tras ${opts.settleMs} ms`);
        const err = new CleanupTimeoutError(parts.join("; "), report, after.done, termError);
        contaminated = err; // sustituye a la marca provisional: la suite sigue contaminada en cualquier caso
        throw err;
      },
    };
  }
  type Tracker = ReturnType<typeof createTestTracker>;
  /** Límite de espera de un bloqueo dentro de hold(): menor que el límite de limpieza, para que liberar nunca se cuelgue. */
  const HOLD_LOCK_TIMEOUT_MS = 15_000;
  const CLEANUP_LIMIT_MS = 20_000;
  /** Peor caso del afterEach: 20 s de limpieza + 10 s de terminación + 5 s para resolver lo registrado = 35 s < 45 s. */
  const TERMINATE_LIMIT_MS = 10_000;
  const SETTLE_LIMIT_MS = 5_000;
  const AFTER_EACH_LIMIT_MS = 45_000;
  const T = createTestTracker({ limitMs: CLEANUP_LIMIT_MS, terminateMs: TERMINATE_LIMIT_MS, settleMs: SETTLE_LIMIT_MS, terminate: () => terminateSuiteSessions() });
  /** Barrera que el afterEach abre si la prueba no llegó a hacerlo. */
  const doneGate = (tracker: Tracker = T) => { const reg = tracker.registry(); const g = gate(); reg.gates.push(g); return g; };
  /**
   * Registra toda promesa devuelta por los métodos del servicio (no dependen de `this`, así que se pueden envolver). Queda
   * ligado al registro de la prueba que lo creó: una vez cerrado, o con la suite contaminada, rechaza sin ejecutar nada.
   */
  const trackSvc = <S extends object>(svc: S, tracker: Tracker = T): S => {
    const reg = tracker.registry();
    return new Proxy(svc, {
      get(target, key) {
        const v = Reflect.get(target, key) as unknown;
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => {
          if (tracker.contaminated || reg.closed) return Promise.reject(tracker.contaminated
            ? new Error(`Suite contaminada: no se ejecuta ninguna operación. Causa: ${tracker.contaminated.message}`)
            : new Error("Operación iniciada después de cerrar su prueba: no se ejecuta"));
          const p = (v as (...a: unknown[]) => Promise<unknown>)(...args);
          reg.ops.push(p);
          return p;
        };
      },
    });
  };
  afterEach(async (ctx) => { await T.finish(ctx.signal); }, AFTER_EACH_LIMIT_MS);
  const leaseSvc = async () => {
    const { createMediaLease } = await import("@/services/media-lease.service");
    return { a: trackSvc(createMediaLease(app)), b: trackSvc(createMediaLease(other)) }; // A y B: conexiones independientes
  };
  const lockRow = () => monitor.mediaReconcileLock.findUniqueOrThrow({ where: { name: "media-reconcile" } });
  const runStatus = async (id: string) => (await monitor.mediaReconcileRun.findUniqueOrThrow({ where: { id } })).status;
  const LOCK_STMT = `SELECT 1 FROM "MediaReconcileLock" WHERE "name" = 'media-reconcile' FOR UPDATE`;
  /**
   * Retiene una fila en una transacción de holderDb hasta liberarla (sin modificarla). Su espera por el bloqueo está
   * acotada (lock_timeout local a la transacción). La liberación es idempotente y queda registrada: si la prueba falla
   * antes de llamarla, el afterEach la ejecuta.
   */
  async function hold(stmt = LOCK_STMT, { lockTimeoutMs = HOLD_LOCK_TIMEOUT_MS, tracker = T }: { lockTimeoutMs?: number; tracker?: Tracker } = {}) {
    const reg = tracker.registry(); // antes de abrir nada: con la suite contaminada o la prueba cerrada, no se abre
    const inside = gate(); const done = gate();
    const rec = { reached: false, release: async () => undefined as void };
    const p = holderDb.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('lock_timeout', ${String(lockTimeoutMs)}, true)`;
      await tx.$queryRawUnsafe(stmt);
      rec.reached = true; inside.open(); await done.wait;
    }, { maxWait: 10_000, timeout: 60_000 });
    let released: Promise<void> | undefined;
    rec.release = () => (released ??= (async () => { done.open(); await p; })());
    reg.holds.push(rec);
    await reached(inside, p);
    return { release: rec.release };
  }
  /** Simula que el lease vigente caducó (SQL de preparación, fuera de cualquier operación del servicio). */
  const expireNow = () => app.$executeRawUnsafe(`UPDATE "MediaReconcileLock" SET "heartbeatAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '2 seconds',
    "leaseExpiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second' WHERE "holderRunId" IS NOT NULL`);
  beforeEach(async () => {
    if (!ADMIN_URL) return;
    T.begin(); // con la suite contaminada falla AQUÍ, antes de tocar la base de datos
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
    const inside = gate(); const done = doneGate();
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
      let settledRs: PromiseSettledResult<Awaited<typeof pa>>[] = [];
      try {
        await waitForLockWaiters(2); // solapamiento demostrado: ambas esperan la fila
      } finally {
        // Pase lo que pase: liberar la fila y esperar a que AMBAS adquisiciones terminen (nada queda en curso).
        await h.release();
        settledRs = await Promise.allSettled([pa, pb]);
      }
      const rs = settledRs.map((r) => { if (r.status === "rejected") throw r.reason; return r.value; }); // errores originales
      expect(rs.filter((r) => r.status === "ACQUIRED")).toHaveLength(1);
      expect(rs.filter((r) => r.status === "BUSY")).toEqual([{ status: "BUSY", reason: "LEASE_HELD" }]);
      const won = rs.find((r) => r.status === "ACQUIRED")!;
      if (won.status !== "ACQUIRED") return;
      expect(await lockRow()).toMatchObject({ holderRunId: won.lease.runId, fencingToken: round + 1 });
    }
    expect(await monitor.mediaReconcileRun.count({ where: { status: "RUNNING" } })).toBe(1);
  }, 30_000); // 10 rondas con esperas reales: el límite por defecto (5 s) se queda corto

  it("mientras A retiene el lock con su lease VIGENTE, B espera y, al entrar, obtiene BUSY (el lease sigue siendo de A)", async () => {
    const { a: svcA, b: svcB } = await leaseSvc();
    const la = await acquiredBy(svcA);
    const inside = gate(); const done = doneGate();
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

  describe("finishWith: persistencia, cierre y liberación atómicos frente a otras transacciones", () => {
    const SUMMARY = { summary: { ok: true }, errorCodes: [] as string[] };
    const NOW0 = new Date("2026-11-20T00:00:00Z");
    /** Escritura realista de la persistencia futura: un MediaAsset de la ejecución actual. */
    const writeAsset = (runId: string) => async (tx: Parameters<Parameters<Awaited<ReturnType<typeof leaseSvc>>["a"]["finishWith"]>[2]>[0]) => {
      await tx.mediaAsset.create({ data: {
        publicId: `ai-wardrobe/cmowner/wardrobe/${runId.slice(0, 8)}`, delivery: "UPLOAD", kind: "WARDROBE", ownerUserId: "cmowner", assetId: "a1",
        resourceCreatedAt: NOW0, firstCandidateAt: NOW0, lastCandidateAt: NOW0, firstCandidateRunId: runId, lastCandidateRunId: runId,
      } });
      return "escrito";
    };

    it("frente a una adquisición concurrente: B espera a que A cierre; después adquiere con el token siguiente", async () => {
      const { a: svcA, b: svcB } = await leaseSvc();
      const la = await acquiredBy(svcA);
      const inside = gate(); const done = doneGate();
      const pA = svcA.finishWith(la, SUMMARY, async (tx) => { const v = await writeAsset(la.runId)(tx); inside.open(); await done.wait; return v; }, OPTS);
      await reached(inside, pA);
      const pB = svcB.acquire(OPTS);
      await waitForLockWaiters(1);
      expect(await settled(pB)).toBe(false);
      done.open();
      expect(await pA).toMatchObject({ ok: true, value: "escrito" });
      const rb = await pB;
      expect(rb).toMatchObject({ status: "ACQUIRED", abandoned: 0 });
      if (rb.status !== "ACQUIRED") return;
      expect(rb.lease.fencingToken).toBe(la.fencingToken + 1);
      expect(await runStatus(la.runId)).toBe("COMPLETED");
      expect(await monitor.mediaAsset.count({ where: { lastCandidateRunId: la.runId } })).toBe(1);
    });

    it("después de que otro proceso adquiriera un token nuevo: LEASE_LOST, fn no se ejecuta y el lease de B queda intacto", async () => {
      const { a: svcA, b: svcB } = await leaseSvc();
      const la = await acquiredBy(svcA);
      await expireNow();
      const lb = await acquiredBy(svcB);
      const held = await lockRow();
      const fn = vi.fn(writeAsset(la.runId));
      expect(await svcA.finishWith(la, SUMMARY, fn, OPTS)).toEqual({ ok: false, reason: "LEASE_LOST" });
      expect(fn).not.toHaveBeenCalled();
      expect(await lockRow()).toEqual(held);
      expect(held).toMatchObject({ holderRunId: lb.runId, fencingToken: la.fencingToken + 1 });
      expect(await runStatus(la.runId)).toBe("ABANDONED");
      expect(await monitor.mediaAsset.count()).toBe(0);
    });

    it.each([
      ["vigente", false],
      ["caducado", true],
    ])("frente a recoverAbandoned (lease %s), en cualquier orden: nunca una ejecución COMPLETED y ABANDONED a la vez", async (_n, expired) => {
      const { a: svcA } = await leaseSvc();
      const { createMediaLease } = await import("@/services/media-lease.service");
      const svcR = trackSvc(createMediaLease(other)); // recoverAbandoned desde otra conexión
      const la = await acquiredBy(svcA);
      if (expired) await expireNow();
      const h = await hold();
      const fn = vi.fn(writeAsset(la.runId));
      const pF = svcA.finishWith(la, SUMMARY, fn, OPTS);
      await waitForLockWaiters(1);
      const pR = svcR.recoverAbandoned(OPTS);
      await waitForLockWaiters(2);
      await h.release();
      const [rf, recovered] = await Promise.all([pF, pR]);
      if (!expired) {
        expect(rf).toMatchObject({ ok: true });
        expect(recovered).toBe(0); // un lease vigente nunca se abandona; tras cerrar, no queda nada RUNNING
        expect(await runStatus(la.runId)).toBe("COMPLETED");
        expect(await monitor.mediaAsset.count()).toBe(1);
        expect(await lockRow()).toMatchObject({ holderRunId: null, leaseExpiresAt: null });
      } else {
        expect(rf).toEqual({ ok: false, reason: "LEASE_LOST" }); // caducado: nunca se cierra
        expect(fn).not.toHaveBeenCalled();
        expect(recovered).toBe(1);
        expect(await runStatus(la.runId)).toBe("ABANDONED");
        expect(await monitor.mediaAsset.count()).toBe(0);
      }
    });

    it("una espera por el bloqueo no permite usar una validación obsoleta: si el lease caduca mientras espera, LEASE_LOST", async () => {
      const { a: svcA } = await leaseSvc();
      const la = await acquiredBy(svcA);
      await app.$executeRawUnsafe(`UPDATE "MediaReconcileLock" SET "heartbeatAt" = (clock_timestamp() AT TIME ZONE 'UTC'),
        "leaseExpiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') + interval '1500 milliseconds'`);
      const h = await hold(); // retiene la fila SIN modificarla (como recoverAbandoned)
      const fn = vi.fn(writeAsset(la.runId));
      const pF = svcA.finishWith(la, SUMMARY, fn, OPTS);
      await waitForLockWaiters(1);
      for (let end = Date.now() + 10_000; ; ) {
        const [r] = await monitor.$queryRaw<{ expired: boolean }[]>`SELECT "leaseExpiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC') AS expired FROM "MediaReconcileLock"`;
        if (r!.expired) break;
        if (Date.now() > end) throw new Error("el lease no llegó a caducar");
        await new Promise((r2) => setTimeout(r2, 50));
      }
      expect(await settled(pF)).toBe(false);
      await h.release();
      expect(await pF).toEqual({ ok: false, reason: "LEASE_LOST" });
      expect(fn).not.toHaveBeenCalled();
      expect(await runStatus(la.runId)).toBe("RUNNING");
      expect(await monitor.mediaAsset.count()).toBe(0);
    });

    it("una transacción fallida (error real de PostgreSQL dentro de fn) no deja cambios parciales y el lease sigue siendo de A", async () => {
      const { a: svcA, b: svcB } = await leaseSvc();
      const la = await acquiredBy(svcA);
      const before = await lockRow();
      const err = await svcA.finishWith(la, SUMMARY, async (tx) => {
        await writeAsset(la.runId)(tx);
        // Viola MediaAsset_assetId_check: error real de la base de datos a mitad de la persistencia.
        await tx.$executeRaw`UPDATE "MediaAsset" SET "assetId" = '' WHERE "lastCandidateRunId" = ${la.runId}`;
        return "no";
      }, OPTS).then(() => null, (e: unknown) => e);
      expect(err).toBeTruthy();
      expect(await monitor.mediaAsset.count()).toBe(0);
      expect(await runStatus(la.runId)).toBe("RUNNING");
      expect(await lockRow()).toEqual(before);
      expect(await svcB.acquire(OPTS)).toEqual({ status: "BUSY", reason: "LEASE_HELD" });
      expect(await svcA.finishWith(la, SUMMARY, writeAsset(la.runId), OPTS)).toMatchObject({ ok: true }); // y A puede reintentar
    });
  });

  describe("persistencia de MediaAsset (19.6.3) frente a finishWith y al borrado REAL de cuentas", () => {
    const DONE = { summary: { ok: 1 }, errorCodes: [] };
    type Cand = import("@/services/media-reconcile.service").MediaCandidate;
    const cand = (owner: string, name: string): Cand => ({
      publicId: `ai-wardrobe/${owner}/wardrobe/${name}`, delivery: "upload", kind: "wardrobe", ownerUserId: owner, ownerMissing: false,
      assetId: `as-${name}`, version: 1, bytes: 10, format: "jpg", resourceCreatedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const detection = (cands: Cand[]) => ({
      report: { complete: true, inventoryStatus: "COMPLETE", inventoryComplete: { upload: true, authenticated: true }, errors: [],
        byCategory: { ORPHAN_CANDIDATE: cands.length } } as never,
      candidates: cands,
    });
    const detectionAt = (startedAt: Date, cands: Cand[]) => {
      const d = detection(cands);
      return { ...d, report: { ...(d.report as object), startedAt: startedAt.toISOString() } as never };
    };
    const services = async () => ({
      ...(await leaseSvc()),
      persist: (await import("@/services/media-asset.service")).persistMediaCandidates,
      account: (await import("@/services/account.service")).accountService,
    });
    /** Registra una operación en la limpieza de la prueba (se espera siempre, también si la prueba falla). */
    const tracked = <R,>(p: Promise<R>): Promise<R> => { T.registry().ops.push(p); return p; };
    const assets = (owner: string) => monitor.mediaAsset.count({ where: { ownerUserId: owner } });
    const exists = async (id: string) => (await monitor.user.count({ where: { id } })) === 1;
    /** Ejecución completa previa: deja filas activas de `cands`. */
    async function seed(svc: Awaited<ReturnType<typeof services>>, cands: Cand[]) {
      const l = await acquiredBy(svc.a);
      const r = await svc.a.finishWith(l, DONE, (tx) => svc.persist(tx, { runId: l.runId, startedAt: l.startedAt, detection: detectionAt(l.startedAt, cands) }));
      expect(r.ok).toBe(true);
    }

    it("17. atomicidad real: mientras la transacción de finishWith sigue abierta, otra conexión no ve nada; al cerrar, todo a la vez", async () => {
      const svc = await services();
      const u = await newUser();
      const l = await acquiredBy(svc.a);
      const inside = gate(); const done = doneGate();
      const p = svc.a.finishWith(l, DONE, async (tx) => {
        const s = await svc.persist(tx, { runId: l.runId, startedAt: l.startedAt, detection: detectionAt(l.startedAt, [cand(u.id, "a"), cand(u.id, "b")]) });
        inside.open(); await done.wait; return s;
      });
      await reached(inside, p);
      expect(await assets(u.id)).toBe(0); // escrito, pero sin confirmar
      expect(await runStatus(l.runId)).toBe("RUNNING");
      done.open();
      expect(await p).toMatchObject({ ok: true, value: { created: 2 } });
      expect(await assets(u.id)).toBe(2);
      expect(await runStatus(l.runId)).toBe("COMPLETED");
      expect((await lockRow()).holderRunId).toBeNull();
    });

    it("M1. fuera de finishWith, la persistencia bloquea el lock y comprueba la caducidad DESPUÉS de esperar: si caduca mientras espera, RUN_NOT_ACTIVE", async () => {
      const svc = await services();
      const u = await newUser();
      const l = await acquiredBy(svc.a);
      await app.$executeRawUnsafe(`UPDATE "MediaReconcileLock" SET "heartbeatAt" = (clock_timestamp() AT TIME ZONE 'UTC'),
        "leaseExpiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') + interval '1500 milliseconds'`);
      const h = await hold(); // retiene la fila del lock SIN modificarla
      const p = tracked(app.$transaction((tx) => svc.persist(tx, { runId: l.runId, startedAt: l.startedAt, detection: detectionAt(l.startedAt, [cand(u.id, "a")]) })));
      await waitForLockWaiters(1);
      for (let end = Date.now() + 10_000; ; ) {
        const [r] = await monitor.$queryRaw<{ expired: boolean }[]>`SELECT "leaseExpiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC') AS expired FROM "MediaReconcileLock"`;
        if (r!.expired) break;
        if (Date.now() > end) throw new Error("el lease no llegó a caducar");
        await new Promise((r2) => setTimeout(r2, 50));
      }
      expect(await settled(p)).toBe(false); // sigue esperando la fila
      await h.release();
      await expect(p).rejects.toMatchObject({ code: "RUN_NOT_ACTIVE" });
      expect(await assets(u.id)).toBe(0);
      expect(await runStatus(l.runId)).toBe("RUNNING");
    });

    it("13. la persistencia llega antes: los borrados de cuenta esperan y después eliminan TODO (también las filas recién creadas); sin interbloqueos", async () => {
      const svc = await services();
      const u = await newUser(); const v = await newUser();
      await seed(svc, [cand(v.id, "vieja")]); // v: fila activa que esta ejecución no ve (pasará a CLEARED)
      const l = await acquiredBy(svc.a);
      const inside = gate(); const done = doneGate();
      const p = svc.a.finishWith(l, DONE, async (tx) => {
        const s = await svc.persist(tx, { runId: l.runId, startedAt: l.startedAt, detection: detectionAt(l.startedAt, [cand(u.id, "nueva")]) });
        inside.open(); await done.wait; return s; // con FOR KEY SHARE de u y v
      });
      await reached(inside, p);
      const delU = tracked(svc.account.delete(u.id, "")); const delV = tracked(svc.account.delete(v.id, ""));
      await waitForLockWaiters(2); // los dos borrados esperan la fila de su usuario
      expect(await exists(u.id) && await exists(v.id)).toBe(true);
      done.open();
      expect(await p).toMatchObject({ ok: true, value: { created: 1, cleared: 1 } });
      await Promise.all([delU, delV]);
      expect([await exists(u.id), await exists(v.id)]).toEqual([false, false]);
      expect([await assets(u.id), await assets(v.id)]).toEqual([0, 0]); // la fila nueva de u no sobrevive a su cuenta
      expect(await runStatus(l.runId)).toBe("COMPLETED");
    });

    it("13. el borrado de cuenta llega antes (ya tiene la fila del usuario): la persistencia espera, ve la cuenta borrada y no recrea nada", async () => {
      const svc = await services();
      const u = await newUser();
      await seed(svc, [cand(u.id, "vieja")]);
      const token = `tok-${Math.random().toString(36).slice(2)}`;
      await app.verificationToken.create({ data: { identifier: u.email, token, expires: new Date(Date.now() + 3_600_000) } });
      // El borrado REAL bloquea primero el usuario y se detiene en su siguiente sentencia (la fila del token está retenida).
      const h = await hold(`SELECT 1 FROM "VerificationToken" WHERE "token" = '${token}' FOR UPDATE`);
      const del = tracked(svc.account.delete(u.id, ""));
      await waitForLockWaiters(1);
      const l = await acquiredBy(svc.a);
      const p = svc.a.finishWith(l, DONE, (tx) => svc.persist(tx, { runId: l.runId, startedAt: l.startedAt, detection: detectionAt(l.startedAt, [cand(u.id, "nueva")]) }));
      await waitForLockWaiters(2); // la persistencia espera la fila del usuario (FOR KEY SHARE)
      expect(await assets(u.id)).toBe(1);
      await h.release();
      await del;
      // El detector vio al usuario y ahora no existe: no se crea la nueva ni se toca la vieja (la borró la cuenta).
      expect(await p).toMatchObject({ ok: true, value: { created: 0, cleared: 0, skippedOwnerDeleted: 1 } });
      expect(await exists(u.id)).toBe(false);
      expect(await assets(u.id)).toBe(0);
      expect(await runStatus(l.runId)).toBe("COMPLETED");
    });
  });

  describe("orquestador 19.7 (lease → detección acotada → persistencia) con conexiones reales", () => {
    type ListPage = import("@/services/media-reconcile.service").ListPage;
    type LeaseLike = Awaited<ReturnType<typeof leaseSvc>>["a"];
    const rawRes = (public_id: string) => ({ public_id, type: "upload", created_at: "2020-01-01T00:00:00Z",
      asset_id: `a${Buffer.from(public_id).toString("hex").slice(-31)}`, version: 1, bytes: 10, format: "jpg", resource_type: "image" });
    /** Inventario simulado (sin Cloudinary real): `upload` con esos recursos; `before` se espera antes de devolverlo. */
    const pagesOf = (ids: string[], before?: () => Promise<void>): ListPage => async (type) => {
      if (type === "upload") await before?.();
      return { resources: type === "upload" ? ids.map(rawRes) : [] } as never;
    };
    async function runnerOf(lease: LeaseLike, listPage: ListPage, persist?: typeof import("@/services/media-asset.service").persistMediaCandidates) {
      const { createMediaReconcileRunner } = await import("@/services/media-reconcile-run.service");
      const { detectOrphanMediaDetailed } = await import("@/services/media-reconcile.service");
      const { persistMediaCandidates } = await import("@/services/media-asset.service");
      return createMediaReconcileRunner({ lease, detect: (o) => detectOrphanMediaDetailed({ ...o, listPage }), persist: persist ?? persistMediaCandidates });
    }
    const tracked = <R,>(p: Promise<R>): Promise<R> => { T.registry().ops.push(p); return p; };
    const allRuns = () => monitor.mediaReconcileRun.findMany({ orderBy: { fencingToken: "asc" } });

    it("D3: la lectura del detector llega a PostgreSQL, espera el bloqueo, la CANCELA statement_timeout y la conexión queda libre", async () => {
      const { detectOrphanMediaDetailed } = await import("@/services/media-reconcile.service");
      const u = await newUser();
      const LOCK_CATALOG = `LOCK TABLE "CatalogProduct" IN ACCESS EXCLUSIVE MODE`;
      type Session = { pid: number; state: string | null; waitType: string | null; xactOpen: boolean; query: string; blockedBy: number[] };
      /** Sesiones de ESTA suite en ESTA base (nunca ajenas, nunca la conexión monitor). */
      const suiteSessions = () => monitor.$queryRaw<Session[]>`
        SELECT pid, state, wait_event_type AS "waitType", xact_start IS NOT NULL AS "xactOpen", query, pg_blocking_pids(pid) AS "blockedBy"
          FROM pg_stat_activity WHERE datname = ${dbName} AND application_name = ${SUITE_APP} AND pid <> pg_backend_pid()`;
      const poll = async <R,>(f: () => Promise<R | null>, ms: number, stop?: () => Promise<boolean>): Promise<R | null> => {
        const end = Date.now() + ms;
        for (;;) {
          const v = await f(); if (v !== null) return v;
          if (Date.now() > end || (stop && await stop())) return null;
          await new Promise((r) => setTimeout(r, 10));
        }
      };

      // 1. Otra sesión de la suite retiene la tabla en exclusiva (transacción abierta, sin soltarla).
      const h = await hold(LOCK_CATALOG);
      const holders = (await suiteSessions()).filter((x) => x.query === LOCK_CATALOG && x.state === "idle in transaction");
      expect(holders).toHaveLength(1);
      const holderPid = holders[0]!.pid;

      // 2. Detección con lecturas acotadas: inventario inmediato y 3 s para las lecturas de PostgreSQL.
      const BUDGET = 1_000; const QUERY_BUDGET = 3_000;
      const t0 = Date.now();
      const p = tracked(detectOrphanMediaDetailed({ now: new Date(), budgetMs: BUDGET, queryBudgetMs: QUERY_BUDGET, listPage: pagesOf([`ai-wardrobe/${u.id}/wardrobe/x`]) }));

      // 3. La lectura de catálogo LLEGA a PostgreSQL y queda esperando el bloqueo de esa sesión, ANTES del plazo y con la
      //    detección todavía en curso (si el límite saltara antes de llegar a PostgreSQL, nunca se vería esta espera).
      const waiter = await poll(async () => (await suiteSessions()).find((x) =>
        x.waitType === "Lock" && x.blockedBy.includes(holderPid) && /"CatalogProduct"/.test(x.query) && !x.query.startsWith("LOCK TABLE")) ?? null,
      QUERY_BUDGET, async () => (await settled(p)) === true);
      expect(waiter, "la lectura del detector nunca llegó a esperar el bloqueo en PostgreSQL").not.toBeNull();
      expect(Date.now() - t0).toBeLessThan(BUDGET + QUERY_BUDGET);
      expect(await settled(p)).toBe(false);
      expect(waiter!.xactOpen).toBe(true); // dentro de su transacción acotada

      // 4. Vence el plazo: detección incompleta, sin candidatas, con el error genérico de la lectura de URLs.
      const { report, candidates } = await p;
      expect(Date.now() - t0).toBeLessThan(BUDGET + QUERY_BUDGET + 2_000);
      expect(report.inventoryStatus).toBe("COMPLETE");
      expect(report.complete).toBe(false);
      expect(candidates).toEqual([]);
      expect(report.byCategory.ORPHAN_CANDIDATE).toBe(0);
      expect(report.errors).toContainEqual({ stage: "database", scope: "urls", code: "QUERY_TIMEOUT" });

      // 5. La MISMA sesión deja de esperar y su transacción termina (ROLLBACK) mientras el bloqueo SIGUE retenido: solo
      //    puede deberse a la cancelación de la sentencia en el servidor (statement_timeout). Si la conexión se hubiera
      //    cerrado, el pid habría desaparecido; si solo hubiera vencido JavaScript, seguiría esperando.
      const after = await poll(async () => {
        const me = (await suiteSessions()).find((x) => x.pid === waiter!.pid);
        return me && me.waitType !== "Lock" && me.state === "idle" && !me.xactOpen ? me : null;
      }, 3_000);
      expect(after, "la sesión siguió esperando o con la transacción abierta tras el plazo").not.toBeNull();
      expect(after!.blockedBy).toEqual([]);
      const stillHeld = (await suiteSessions()).find((x) => x.pid === holderPid);
      expect(stillHeld).toMatchObject({ state: "idle in transaction", query: LOCK_CATALOG }); // el bloqueo no se soltó

      // 6. Ninguna otra sesión de la suite queda esperando ni con una transacción abierta (salvo la retención).
      const others = (await suiteSessions()).filter((x) => x.pid !== holderPid);
      expect(others.filter((x) => x.waitType === "Lock")).toEqual([]);
      expect(others.filter((x) => x.state === "idle in transaction" || x.xactOpen)).toEqual([]);

      await h.release();
      expect((await suiteSessions()).filter((x) => x.state === "idle in transaction" || x.xactOpen)).toEqual([]);
      // 7. La conexión volvió al pool: sin bloqueo, las mismas lecturas acotadas funcionan y la detección es completa.
      const ok = await detectOrphanMediaDetailed({ now: new Date(), budgetMs: 1_000, queryBudgetMs: 5_000, listPage: pagesOf([]) });
      expect(ok.report.complete).toBe(true);
    }, 20_000); // plazo de 4 s + sondeos acotados: un fallo se debe ver en su aserción, no por el límite de la prueba

    it("dos ejecuciones simultáneas (conexiones distintas): solo una adquiere el lease; la otra BUSY sin crear ejecución", async () => {
      const { a, b } = await leaseSvc();
      const u = await newUser();
      const inside = gate(); const done = doneGate();
      const wait = async () => { inside.open(); await done.wait; };
      const ids = [`ai-wardrobe/${u.id}/wardrobe/o1`];
      const [ra, rb] = [await runnerOf(a, pagesOf(ids, wait)), await runnerOf(b, pagesOf(ids, wait))];
      const pa = tracked(ra.run()); const pb = tracked(rb.run());
      const first = await Promise.race([pa.then((r) => ({ who: "a", r })), pb.then((r) => ({ who: "b", r }))]);
      expect(first.r).toEqual({ outcome: "BUSY", reason: expect.stringMatching(/^(LEASE_HELD|LOCK_TIMEOUT)$/) });
      await inside.wait;
      expect(await allRuns()).toHaveLength(1);
      done.open();
      const winner = await (first.who === "a" ? pb : pa);
      expect(winner).toMatchObject({ outcome: "COMPLETED", persisted: { created: 1 } });
      expect((await allRuns()).map((r) => r.status)).toEqual(["COMPLETED"]);
      expect((await lockRow()).holderRunId).toBeNull();
    });

    it("lease perdido durante la detección y adquirido por otra: la antigua no persiste nada (LEASE_LOST) y queda ABANDONED", async () => {
      const { a, b } = await leaseSvc();
      const u = await newUser();
      const shared = `ai-wardrobe/${u.id}/wardrobe/comun`; const onlyA = `ai-wardrobe/${u.id}/wardrobe/solo-a`;
      const inside = gate(); const done = doneGate();
      const ra = await runnerOf(a, pagesOf([shared, onlyA], async () => { inside.open(); await done.wait; }));
      const pa = tracked(ra.run());
      await reached(inside, pa);
      await expireNow(); // el lease de A caduca mientras A sigue detectando
      const rb = await runnerOf(b, pagesOf([shared]));
      expect(await tracked(rb.run())).toMatchObject({ outcome: "COMPLETED", persisted: { created: 1 } });
      done.open();
      const resA = await pa;
      expect(resA).toMatchObject({ outcome: "LEASE_LOST", persisted: null, errorCodes: ["lease/LEASE_LOST"], finalized: false });
      const [runA, runB] = await allRuns();
      expect([runA!.status, runB!.status]).toEqual(["ABANDONED", "COMPLETED"]);
      const rows = await monitor.mediaAsset.findMany();
      expect(rows.map((r) => r.publicId)).toEqual([shared]); // nada de `solo-a`
      expect(rows.every((r) => r.firstCandidateRunId === runB!.id && r.lastCandidateRunId === runB!.id)).toBe(true);
      expect((await lockRow()).holderRunId).toBeNull();
    });

    it("borrado de cuenta durante la persistencia orquestada: espera, sin interbloqueos, y elimina también las filas nuevas", async () => {
      const { a } = await leaseSvc();
      const { persistMediaCandidates } = await import("@/services/media-asset.service");
      const { accountService } = await import("@/services/account.service");
      const u = await newUser();
      const inside = gate(); const done = doneGate();
      const r = await runnerOf(a, pagesOf([`ai-wardrobe/${u.id}/wardrobe/n`]), async (tx, input) => {
        const s = await persistMediaCandidates(tx, input); // con FOR KEY SHARE sobre u
        inside.open(); await done.wait; return s;
      });
      const p = tracked(r.run());
      await reached(inside, p);
      const del = tracked(accountService.delete(u.id, ""));
      await waitForLockWaiters(1); // el borrado espera la fila del usuario
      expect(await monitor.user.count({ where: { id: u.id } })).toBe(1);
      done.open();
      expect(await p).toMatchObject({ outcome: "COMPLETED", persisted: { created: 1 } });
      await del;
      expect(await monitor.user.count({ where: { id: u.id } })).toBe(0);
      expect(await monitor.mediaAsset.count({ where: { ownerUserId: u.id } })).toBe(0);
      expect((await allRuns()).map((x) => x.status)).toEqual(["COMPLETED"]);
    });
  });

  describe("retención DRY_RUN 19.8a con conexiones reales", () => {
    const tracked = <R,>(p: Promise<R>): Promise<R> => { T.registry().ops.push(p); return p; };
    type LeaseLike = Awaited<ReturnType<typeof leaseSvc>>["a"];
    /** Ejecución terminada hace 400 días (token siguiente según la base de datos). */
    async function oldRun() {
      const [r] = await app.$queryRawUnsafe<{ id: string }[]>(`INSERT INTO "MediaReconcileRun"
        ("id", "status", "fencingToken", "startedAt", "heartbeatAt", "finishedAt", "complete", "inventoryComplete", "graceHours", "updatedAt")
        SELECT gen_random_uuid()::text, 'COMPLETED', GREATEST(COALESCE(MAX("fencingToken"), 0), (SELECT "fencingToken" FROM "MediaReconcileLock")) + 1,
          now() - interval '401 days', now() - interval '401 days', now() - interval '400 days', true, true, 24, now() FROM "MediaReconcileRun"
        RETURNING "id"`);
      return r!.id;
    }
    /** `n` filas CLEARED de hace 60 días (eliminables por la regla de 30 d) del propietario `owner`. */
    async function cleared(owner: string, n: number, runId: string, tag = "c") {
      await app.$executeRawUnsafe(`INSERT INTO "MediaAsset" ("id", "publicId", "delivery", "kind", "ownerUserId", "assetId", "resourceCreatedAt",
          "state", "firstCandidateAt", "lastCandidateAt", "firstCandidateRunId", "lastCandidateRunId", "sightings", "ownerMissing", "createdAt", "updatedAt")
        SELECT gen_random_uuid()::text, 'ai-wardrobe/${owner}/wardrobe/${tag}' || lpad(i::text, 5, '0'), 'UPLOAD', 'WARDROBE', '${owner}', 'as-${tag}' || i,
          now() - interval '400 days', 'CLEARED', now() - interval '60 days', now() - interval '60 days', '${runId}', '${runId}', 1, false, now(), now()
        FROM generate_series(1, ${n}) AS i`);
    }
    async function retain(lease: Pick<LeaseLike, "withLease">, l: Awaited<ReturnType<typeof acquiredBy>>) {
      const { createMediaRetention } = await import("@/services/media-retention.service");
      return tracked(createMediaRetention({ lease }).run(l, { budgetMs: 60_000, ttlMs: 360_000, graceHours: 24 }));
    }
    const snapshot = async () => ({
      assets: await monitor.mediaAsset.findMany({ orderBy: { publicId: "asc" } }),
      runs: await monitor.mediaReconcileRun.findMany({ where: { status: { not: "RUNNING" } }, orderBy: { fencingToken: "asc" } }),
    });

    it("retención y borrado de la cuenta sobre las MISMAS filas: el borrado espera al lote, sin interbloqueo; la cuenta se borra entera", async () => {
      const { a } = await leaseSvc();
      const { accountService } = await import("@/services/account.service");
      const u = await newUser();
      await cleared(u.id, 3, await oldRun());
      const l = await acquiredBy(a);
      const inside = gate(); const done = doneGate();
      let first = true;
      // El primer lote se detiene DESPUÉS de seleccionar (filas de u bloqueadas FOR UPDATE), dentro de su transacción.
      const paused = { withLease: ((ls: never, fn: (tx: never) => Promise<unknown>, o: never) => a.withLease(ls, async (tx) => {
        const v = await fn(tx as never);
        if (first) { first = false; inside.open(); await done.wait; }
        return v;
      }, o)) as never };
      const p = retain(paused, l);
      await reached(inside, p);
      const del = tracked(accountService.delete(u.id, ""));
      await waitForLockWaiters(1); // el borrado de la cuenta espera las filas que tiene el lote
      done.open();
      expect(await p).toMatchObject({ status: "DONE", assets: { eligible: 3 }, errorCodes: [] });
      await del;
      expect(await monitor.user.count({ where: { id: u.id } })).toBe(0);
      expect(await monitor.mediaAsset.count({ where: { ownerUserId: u.id } })).toBe(0);
    });

    it("filas bloqueadas por otra sesión (p. ej. un borrado de cuenta en curso): SKIP LOCKED → no espera y no las cuenta", async () => {
      const { a } = await leaseSvc();
      const u1 = await newUser(); const u2 = await newUser();
      const r = await oldRun();
      await cleared(u1.id, 5, r, "x"); await cleared(u2.id, 3, r, "y");
      const l = await acquiredBy(a);
      const h = await hold(`SELECT 1 FROM "MediaAsset" WHERE "ownerUserId" = '${u1.id}' FOR UPDATE`);
      const t0 = Date.now();
      const res = await retain(a, l);
      expect(Date.now() - t0).toBeLessThan(1_500); // nunca esperó a lock_timeout
      expect(res).toMatchObject({ status: "DONE", assets: { eligible: 3 } });
      await h.release();
      expect(await monitor.mediaAsset.count({ where: { ownerUserId: u1.id } })).toBe(5);
    });

    it("450 elegibles con la fila 150 bloqueada por otra sesión: 449 filas en 3 lotes, sin duplicados, sin esperas y completa", async () => {
      const { a } = await leaseSvc();
      const u = await newUser();
      await cleared(u.id, 450, await oldRun());
      const locked = `ai-wardrobe/${u.id}/wardrobe/c00150`; // posición 150 en el orden (delivery, publicId)
      const l = await acquiredBy(a);
      const h = await hold(`SELECT 1 FROM "MediaAsset" WHERE "publicId" = '${locked}' FOR UPDATE`);
      const seen: string[] = [];
      const spy = { withLease: ((ls: never, fn: (tx: never) => Promise<unknown>, o: never) => a.withLease(ls, async (tx) => {
        const v = await fn(tx as never);
        for (const row of v as { publicId?: string }[]) if (row.publicId) seen.push(row.publicId);
        return v;
      }, o)) as never };
      const t0 = Date.now();
      const res = await retain(spy, l);
      const elapsed = Date.now() - t0;
      await h.release();
      expect(res).toMatchObject({ status: "DONE", errorCodes: [], assets: { eligible: 449, batches: 3, complete: true } });
      expect(seen).toHaveLength(449);
      expect(new Set(seen).size).toBe(449); // sin duplicados entre lotes
      expect(seen).not.toContain(locked);
      expect([...seen].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)))).toEqual(seen); // orden estrictamente creciente
      expect(elapsed).toBeLessThan(1_500); // SKIP LOCKED: nunca esperó la fila bloqueada
    });

    it("fila del lock retenida por otra sesión → el lote no empieza: LOCK_TIMEOUT en ~2 s y STOPPED, sin reintentos", async () => {
      const { a } = await leaseSvc();
      await cleared((await newUser()).id, 2, await oldRun());
      const l = await acquiredBy(a);
      const h = await hold(LOCK_STMT);
      const t0 = Date.now();
      const res = await retain(a, l);
      const elapsed = Date.now() - t0;
      await h.release();
      expect(res).toMatchObject({ status: "STOPPED", errorCodes: ["retention/LOCK_TIMEOUT"], assets: { batches: 0 } });
      expect(elapsed).toBeGreaterThanOrEqual(1_500);
      expect(elapsed).toBeLessThan(5_000);
    });

    it("lease perdido entre lotes y adquirido por otra conexión → LEASE_LOST; la antigua queda ABANDONED", async () => {
      const { a, b } = await leaseSvc();
      await cleared((await newUser()).id, 450, await oldRun());
      const l = await acquiredBy(a);
      let n = 0;
      const wrapped = { withLease: (async (...args: Parameters<LeaseLike["withLease"]>) => {
        const r = await a.withLease(...args);
        if (++n === 1) { await expireNow(); await acquiredBy(b); }
        return r;
      }) as never };
      const res = await retain(wrapped, l);
      expect(res).toMatchObject({ status: "LEASE_LOST", errorCodes: ["retention/LEASE_LOST"], assets: { batches: 1, eligible: 200 } });
      expect(await runStatus(l.runId)).toBe("ABANDONED");
    });

    it("DRY_RUN con PostgreSQL real: ninguna fila cambia; statement_timeout 5 s y lock_timeout 2 s dentro de cada lote; lease renovado", async () => {
      const { a } = await leaseSvc();
      await cleared((await newUser()).id, 250, await oldRun());
      const l = await acquiredBy(a);
      await app.$executeRawUnsafe(`UPDATE "MediaReconcileLock" SET "leaseExpiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') + interval '20 seconds'`);
      const before = await snapshot();
      const seen: { st: string; lt: string }[] = [];
      const spy = { withLease: ((ls: never, fn: (tx: never) => Promise<unknown>, o: never) => a.withLease(ls, async (tx) => {
        const v = await fn(tx as never);
        seen.push((await tx.$queryRawUnsafe<{ st: string; lt: string }[]>(`SELECT current_setting('statement_timeout') AS st, current_setting('lock_timeout') AS lt`))[0]!);
        return v;
      }, o)) as never };
      const res = await retain(spy, l);
      expect(res).toMatchObject({ mode: "DRY_RUN", status: "DONE", assets: { eligible: 250, batches: 2 } });
      expect(seen).toEqual([{ st: "5s", lt: "2s" }, { st: "5s", lt: "2s" }, { st: "5s", lt: "2s" }]);
      expect(await snapshot()).toEqual(before);
      const [row] = await monitor.$queryRaw<{ left: number }[]>`SELECT EXTRACT(EPOCH FROM ("leaseExpiresAt" - (clock_timestamp() AT TIME ZONE 'UTC')))::float8 AS "left" FROM "MediaReconcileLock"`;
      expect(row!.left).toBeGreaterThan(340); // renovación confirmada y visible desde otra conexión
    });
  });

  describe("limpieza de las pruebas: retenciones acotadas, terminación forzosa y suite contaminada", () => {
    const dbUrl = () => { const u = new URL(ADMIN_URL!); u.pathname = `/${dbName}`; return u.toString(); };
    /** Sesión AJENA a la suite (otro application_name): nunca debe terminarse. */
    async function foreign(url: string, applicationName: string) {
      const c = new pg.Client({ connectionString: url, application_name: applicationName });
      await c.connect();
      const [{ pid }] = (await c.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows as [{ pid: number }];
      return { c, pid };
    }
    const alive = async (pid: number) => (await monitor.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = ${pid}`)[0]!.n === 1;

    it("identifica sus sesiones: todas las de la base temporal llevan el application_name exclusivo de la suite, salvo monitor", async () => {
      await Promise.all([...Array.from({ length: 4 }, () => app.$queryRaw`SELECT 1 AS n FROM pg_sleep(0.1)`), other.$queryRaw`SELECT 1`, holderDb.$queryRaw`SELECT 1`]);
      expect(SUITE_APP).toMatch(/^aiw-pgc-[0-9a-f]{8}$/);
      const [me] = await monitor.$queryRaw<{ name: string; pid: number }[]>`SELECT current_setting('application_name') AS name, pg_backend_pid() AS pid`;
      expect(me!.name).toBe(MONITOR_APP);
      const rows = await monitor.$queryRaw<{ pid: number; name: string }[]>`SELECT pid, application_name AS name FROM pg_stat_activity
        WHERE datname = ${dbName} AND backend_type = 'client backend' AND pid <> pg_backend_pid()`;
      expect(rows.length).toBeGreaterThanOrEqual(6); // 4 de app (el pool completo), other y holderDb
      expect(new Set(rows.map((r) => r.name))).toEqual(new Set([SUITE_APP]));
    });

    it("hold() falla de forma acotada si no puede obtener el bloqueo (lock_timeout local), y su límite es menor que el de la limpieza", async () => {
      expect(HOLD_LOCK_TIMEOUT_MS).toBeLessThan(CLEANUP_LIMIT_MS);
      const f = await foreign(dbUrl(), "aiw-ajena-hold");
      try {
        await f.c.query("BEGIN"); await f.c.query(LOCK_STMT); // la fila queda retenida por una sesión fuera del registro
        const t0 = Date.now();
        const err = await hold(LOCK_STMT, { lockTimeoutMs: 300 }).then(() => null, (e: unknown) => e);
        expect(String((err as Error | null)?.message)).toMatch(/lock timeout/i);
        expect(Date.now() - t0).toBeLessThan(5_000);
        // El valor es local a la transacción: no se filtra a la conexión de holderDb.
        expect((await holderDb.$queryRaw<{ v: string }[]>`SELECT current_setting('lock_timeout') AS v`)[0]!.v).toBe("0");
      } finally { await f.c.query("ROLLBACK").catch(() => undefined); await f.c.end(); }
    });

    it("si vence el límite: termina SOLO las sesiones de la suite (nunca monitor ni sesiones ajenas), y la suite queda contaminada sin ejecutar nada más", async () => {
      const { createMediaLease } = await import("@/services/media-lease.service");
      const ajenaMismaBase = await foreign(dbUrl(), "aiw-ajena-misma-base");
      const mismoNombreOtraBase = await foreign(ADMIN_URL!, SUITE_APP); // mismo application_name, OTRA base de datos
      try {
        await ajenaMismaBase.c.query("BEGIN"); await ajenaMismaBase.c.query(LOCK_STMT); // transacción ajena abierta
        const t = createTestTracker({ limitMs: 300, settleMs: 5_000, terminate: () => terminateSuiteSessions() });
        t.begin();
        const svc = trackSvc(createMediaLease(app), t);
        // Operación de la suite que espera SIN límite (lock_timeout 0) tras la transacción ajena: la limpieza no termina.
        const blocked = other.$transaction(async (tx) => { await tx.$queryRawUnsafe(LOCK_STMT); }, { maxWait: 10_000, timeout: 60_000 });
        t.registry().ops.push(blocked);
        await waitForLockWaiters(1);
        const [w] = await monitor.$queryRaw<{ pid: number }[]>`SELECT pid FROM pg_stat_activity WHERE datname = ${dbName} AND wait_event_type = 'Lock'`;
        const monitorPid = (await monitor.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid;

        const err = await t.finish().then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(CleanupTimeoutError);
        const { report, settled, message } = err as CleanupTimeoutError;
        expect(message).toMatch(/no terminó en 300 ms/);
        expect(report!.targeted).toContain(w!.pid); // la sesión bloqueada de la suite
        expect(report!.targeted).not.toContain(monitorPid);
        expect(report!.targeted).not.toContain(ajenaMismaBase.pid);
        expect(report!.targeted).not.toContain(mismoNombreOtraBase.pid);
        expect(report!.remaining).toEqual([]);
        expect(settled).toBe(true);
        expect(await blocked.then(() => "ok", () => "rechazada")).toBe("rechazada");

        // Intactas: monitor, la sesión ajena (con su transacción abierta) y la de otra base de datos.
        expect(await alive(monitorPid)).toBe(true);
        expect(await alive(ajenaMismaBase.pid)).toBe(true);
        const [st] = await monitor.$queryRaw<{ state: string }[]>`SELECT state FROM pg_stat_activity WHERE pid = ${ajenaMismaBase.pid}`;
        expect(st!.state).toBe("idle in transaction");
        expect((await mismoNombreOtraBase.c.query("SELECT 1 AS n")).rows).toEqual([{ n: 1 }]);
        // Ninguna sesión de la suite sigue dentro de una transacción.
        const [open] = await monitor.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = ${dbName} AND application_name = ${SUITE_APP} AND xact_start IS NOT NULL`;
        expect(open!.n).toBe(0);

        // Contaminada: nada vuelve a ejecutarse ni a registrarse.
        expect(t.contaminated).toBe(err);
        expect(() => t.begin()).toThrow(/Suite contaminada/);
        expect(() => t.registry()).toThrow(/Suite contaminada/);
        await expect(hold(LOCK_STMT, { tracker: t })).rejects.toThrow(/Suite contaminada/);
        await expect(svc.acquire(OPTS)).rejects.toThrow(/Suite contaminada/);
        expect(Number((await lockRow()).fencingToken)).toBe(0); // acquire no llegó a ejecutarse
      } finally {
        await ajenaMismaBase.c.query("ROLLBACK").catch(() => undefined);
        await Promise.all([ajenaMismaBase.c.end(), mismoNombreOtraBase.c.end()]);
      }
    });

    it("si la terminación forzosa falla, la suite también queda contaminada y se informa", async () => {
      const t = createTestTracker({ limitMs: 100, settleMs: 100, terminate: async () => { throw new Error("sin permiso"); } });
      t.begin();
      t.registry().ops.push(new Promise(() => undefined)); // nunca termina
      const err = await t.finish().then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(CleanupTimeoutError);
      expect((err as Error).message).toMatch(/terminación forzosa FALLÓ.*sin resolver/);
      expect(((err as Error).cause as Error).message).toBe("sin permiso");
      expect(() => t.begin()).toThrow(/Suite contaminada/);
    });

    it("si la terminación forzosa se cuelga: la suite ya está contaminada mientras se ejecuta, y se corta a los terminateMs", async () => {
      expect(CLEANUP_LIMIT_MS + TERMINATE_LIMIT_MS + SETTLE_LIMIT_MS).toBeLessThan(AFTER_EACH_LIMIT_MS - 5_000); // margen
      let during: { begin?: unknown; gate?: unknown; hold?: unknown; svc?: unknown; flag?: unknown } = {};
      const { createMediaLease } = await import("@/services/media-lease.service");
      const t = createTestTracker({ limitMs: 100, terminateMs: 300, settleMs: 100, terminate: async () => {
        // Comprobado DENTRO de la terminación: la marca ya está activa para todo lo que podría abrir algo.
        during = {
          flag: t.contaminated?.message,
          begin: (() => { try { t.begin(); return "ok"; } catch (e) { return (e as Error).message; } })(),
          gate: (() => { try { doneGate(t); return "ok"; } catch (e) { return (e as Error).message; } })(),
          hold: await hold(LOCK_STMT, { tracker: t }).then(() => "ok", (e: Error) => e.message),
          svc: await svc.acquire(OPTS).then(() => "ok", (e: Error) => e.message),
        };
        return new Promise<never>(() => undefined); // nunca termina
      } });
      t.begin();
      const svc = trackSvc(createMediaLease(app), t);
      t.registry().ops.push(new Promise(() => undefined)); // la limpieza no termina
      const t0 = Date.now();
      const err = await t.finish().then(() => null, (e: unknown) => e);
      expect(Date.now() - t0).toBeLessThan(3_000); // 100 + 300 + 100 ms, sin quedarse colgado
      expect(during.flag).toMatch(/terminación forzosa en curso/);
      for (const k of ["begin", "gate", "hold", "svc"] as const) expect(during[k]).toMatch(/Suite contaminada/);
      expect(err).toBeInstanceOf(CleanupTimeoutError);
      expect((err as Error).message).toMatch(/no terminó en 100 ms; la terminación forzosa NO se completó en 300 ms;.*sin resolver/);
      expect(t.contaminated).toBe(err);
      expect(() => t.begin()).toThrow(/Suite contaminada/);
      expect(Number((await lockRow()).fencingToken)).toBe(0); // nada llegó a ejecutarse
    });

    it("una prueba que agotó su tiempo contamina la suite aunque su limpieza termine", async () => {
      const t = createTestTracker({ limitMs: 1_000, settleMs: 100, terminate: () => Promise.reject(new Error("no debe llamarse")) });
      t.begin();
      const ac = new AbortController(); ac.abort();
      await expect(t.finish(ac.signal)).rejects.toThrow(/agotó su tiempo/);
      expect(() => t.begin()).toThrow(/Suite contaminada/);
    });

    it("limpieza normal: libera retenciones, abre barreras y espera operaciones; lo creado después no se registra en la prueba siguiente", async () => {
      const { createMediaLease } = await import("@/services/media-lease.service");
      const t = createTestTracker({ limitMs: 5_000, settleMs: 1_000, terminate: () => Promise.reject(new Error("no debe llamarse")) });
      t.begin();
      const svc = trackSvc(createMediaLease(app), t);
      await hold(LOCK_STMT, { tracker: t }); // sin liberar, como en una prueba que falla a mitad
      const done = doneGate(t);
      const waiting = svc.acquire(OPTS); // espera la fila retenida
      await waitForLockWaiters(1);
      let opened = false; void done.wait.then(() => { opened = true; });
      await t.finish();
      expect(opened).toBe(true);
      const got = await waiting;
      if (got.status !== "ACQUIRED") throw new Error("no adquirió durante la limpieza"); // terminó durante la limpieza
      expect(t.contaminated).toBeNull();
      // Prueba cerrada: lo que intente crear después se rechaza sin ejecutarse.
      expect(() => doneGate(t)).toThrow(/fuera de una prueba activa/);
      await expect(hold(LOCK_STMT, { tracker: t })).rejects.toThrow(/fuera de una prueba activa/);
      await expect(svc.renew(got.lease, OPTS)).rejects.toThrow(/después de cerrar su prueba/);
      t.begin(); // la siguiente prueba empieza con un registro vacío
      expect(t.registry()).toEqual({ closed: false, gates: [], holds: [], ops: [] });
      await t.finish();
      const [r] = await monitor.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = ${dbName} AND application_name = ${SUITE_APP} AND xact_start IS NOT NULL`;
      expect(r!.n).toBe(0);
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
    expect(r.lease.startedAt!.getUTCFullYear()).not.toBe(2099); // startedAt también viene de PostgreSQL
    expect(Math.abs(r.lease.startedAt!.getTime() - now.getTime())).toBeLessThan(10_000);
    expect(Math.abs(r.lease.leaseExpiresAt.getTime() - (now.getTime() + 60_000))).toBeLessThan(10_000);
  });
});
