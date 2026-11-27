import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { prismaProxy, setTestEnv } from "../helpers/mock-prisma";
import { applyMigrations, listMigrations } from "../helpers/migrations";
import { TokenOwnerMissingError } from "@/repositories/token.repository";

/**
 * Fase F.4 — atomicidad de tokens con CONCURRENCIA REAL: PostgreSQL de verdad con varias conexiones independientes (PGlite no sirve: es
 * de una sola sesión y su cliente de pruebas usa `max: 1`). Solo se ejecuta si TEST_PG_URL apunta a un PostgreSQL LOCAL y desechable;
 * sin ella se omite. Mismo mecanismo y mismas protecciones que pg-concurrency.test.ts (README, «Concurrencia con PostgreSQL real»):
 * base de datos aislada por ejecución (race_<aleatorio>) con las migraciones del proyecto, se niega a ejecutarse contra hosts no locales
 * y la elimina al terminar. NO arranca, detiene ni modifica contenedores: usa el PostgreSQL que indique TEST_PG_URL.
 *
 * La sincronización es DETERMINISTA, sin esperas arbitrarias: una conexión independiente retiene un bloqueo de fila, se espera a que las
 * operaciones probadas figuren esperando ese bloqueo en pg_stat_activity (wait_event_type = 'Lock'), y solo entonces se libera.
 */
const ADMIN_URL = process.env.TEST_PG_URL;
const isLocal = (u: string) => ["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(u).hostname);

const holder = vi.hoisted(() => ({ prisma: null as PrismaClient | null }));
vi.mock("@/lib/prisma", () => ({ prisma: prismaProxy(holder) }));

/**
 * Límites de tiempo de ESTE archivo (no cambian los del proyecto): cada prueba espera bloqueos reales, así que los 5 s por defecto son
 * justos en una máquina lenta; 30 s dejan margen y siguen acotando cualquier cuelgue. Dentro de ellos todo está acotado además por
 * separado: `lock_timeout` de 10 s en las retenciones, `timeout` de las transacciones y 5 s en cada espera de `pg_stat_activity`.
 */
if (process.env.TEST_PG_URL) vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const hash = (n: string) => sha(`token-${n}-${SUITE_APP}`);
const future = (ms = 3_600_000) => new Date(Date.now() + ms);

let dbName = "";
let app: PrismaClient;      // el que usan el repositorio y el servicio: pool de 6 conexiones, transacciones realmente en paralelo
let other: PrismaClient;    // conexión independiente que retiene bloqueos
let monitor: PrismaClient;  // conexión independiente que observa las esperas de bloqueo
const SUITE_APP = `aiw-tok-${randomUUID().slice(0, 8)}`;
const client = (url: string, max: number, applicationName = SUITE_APP) =>
  new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max, application_name: applicationName }) });
const TEMP_DB = /^race_[a-z0-9]{1,8}$/;

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
  app = client(url.toString(), 6);
  other = client(url.toString(), 1);
  monitor = client(url.toString(), 1, `${SUITE_APP}-monitor`);
  holder.prisma = app;
}, 60_000);

afterAll(async () => {
  if (!ADMIN_URL || !dbName) return;
  if (!TEMP_DB.test(dbName)) throw new Error("Nombre de base de datos temporal inesperado: no se borra nada");
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try { await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); } finally { await admin.end(); }
  await Promise.all([app?.$disconnect(), other?.$disconnect(), monitor?.$disconnect()]);
});

/** Promesa abrible desde fuera. */
function gate() { let open!: () => void; const wait = new Promise<void>((r) => { open = r; }); return { wait, open }; }
/** Espera a que `inside` se abra; si `op` termina antes (p. ej. con un error), falla en ese momento en vez de colgarse. */
const reached = (inside: { wait: Promise<void> }, op: Promise<unknown>) =>
  Promise.race([inside.wait, op.then(() => { throw new Error("La operación terminó sin llegar a retener su bloqueo"); }, (e: unknown) => { throw e; })]);
const settled = (p: Promise<unknown>) => Promise.race([p.then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), 0))]);

async function lockWaiters(): Promise<number> {
  const [r] = await monitor.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
  return r!.n;
}
async function waitForLockWaiters(n: number, timeoutMs = 5_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if ((await lockWaiters()) >= n) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error(`Ninguna transacción llegó a esperar un bloqueo (esperadas ${n})`);
}

/** Retenciones abiertas: el afterEach las libera aunque una aserción falle, para no dejar transacciones colgadas. */
const holds: { release: () => Promise<void> }[] = [];
afterEach(async () => { for (const h of holds.splice(0)) await h.release().catch(() => undefined); });

/** Retiene una fila en una transacción de `other` (sin modificarla) hasta liberarla. La espera por el bloqueo está acotada (lock_timeout). */
async function hold(stmt: string) {
  const inside = gate(); const done = gate();
  const p = other.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('lock_timeout', '10000', true)`;
    await tx.$queryRawUnsafe(stmt);
    inside.open(); await done.wait;
  }, { maxWait: 10_000, timeout: 60_000 });
  let released: Promise<void> | undefined;
  const release = () => (released ??= (async () => { done.open(); await p; })());
  holds.push({ release });
  await reached(inside, p);
  return { release };
}

/**
 * Imita el borrado de cuenta REAL (account.service.delete): bloquea PRIMERO la fila del usuario con FOR UPDATE y, al soltarla, borra sus
 * tokens y la cuenta en la misma transacción. Se queda parado con el bloqueo tomado hasta `release()`.
 */
async function holdAccountDeletion(email: string) {
  const inside = gate(); const done = gate();
  const p = other.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('lock_timeout', '10000', true)`;
    await tx.$queryRaw`SELECT 1 FROM "User" WHERE "email" = ${email} FOR UPDATE`;
    inside.open(); await done.wait;
    await tx.verificationToken.deleteMany({ where: { identifier: email } });
    await tx.user.delete({ where: { email } });
  }, { maxWait: 10_000, timeout: 60_000 });
  let released: Promise<void> | undefined;
  const release = () => (released ??= (async () => { done.open(); await p; })());
  holds.push({ release });
  await reached(inside, p);
  return { release };
}

let tokenRepository: typeof import("@/repositories/token.repository").tokenRepository;
let authService: typeof import("@/services/auth.service").authService;
const newUser = (verified = false) => app.user.create({ data: { email: `t${Math.random().toString(36).slice(2)}@q.com`, passwordHash: "hash-previo", emailVerified: verified ? new Date() : null } });
const tokensOf = (identifier: string, kind?: string) => monitor.verificationToken.findMany({ where: { identifier, ...(kind ? { kind } : {}) }, orderBy: { token: "asc" } });
const seed = (identifier: string, kind: string, h: string, expires = future()) => app.verificationToken.create({ data: { identifier, kind, token: h, expires } });

beforeEach(async () => {
  if (!ADMIN_URL) return;
  holder.prisma = app;
  await app.$executeRawUnsafe(`TRUNCATE "User", "VerificationToken", "Session", "RateLimit" CASCADE`);
  ({ tokenRepository } = await import("@/repositories/token.repository"));
  ({ authService } = await import("@/services/auth.service"));
});

describe.skipIf(!ADMIN_URL)("PostgreSQL real con varias conexiones: tokens", () => {
  describe("conexiones independientes", () => {
    it("4 transacciones simultáneas del pool ocupan 4 sesiones de PostgreSQL distintas (pids), distintas de las de retención y observación", async () => {
      const pids: number[] = [];
      const barrier = gate();
      let arrived = 0;
      // Ninguna transacción termina hasta que las 4 están DENTRO a la vez: solo es posible con 4 conexiones reales en paralelo.
      await Promise.all(Array.from({ length: 4 }, () => app.$transaction(async (tx) => {
        const [r] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        pids.push(r!.pid);
        if (++arrived === 4) barrier.open();
        await barrier.wait;
      }, { timeout: 10_000 })));
      expect(new Set(pids).size).toBe(4);
      const [o] = await other.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      const [m] = await monitor.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      expect(o!.pid).not.toBe(m!.pid);
      expect(pids).not.toContain(o!.pid);
      expect(pids).not.toContain(m!.pid);
    });
  });

  describe("replace serializado por cuenta (SELECT … FOR NO KEY UPDATE sobre User)", () => {
    it("DETERMINISTA: un primer replace retiene el bloqueo de la cuenta; un segundo replace ESPERA y no termina antes de liberarlo; después ambos completan y queda un solo token (el del segundo)", async () => {
      const u = await newUser();
      await seed(u.email, "RESET_PASSWORD", hash("previo"));
      // El primer replace REAL ejecuta su transacción (bloquea la cuenta, borra el token previo y crea el suyo) y se queda sin confirmar.
      const inside = gate(); const release = gate();
      let gated = true;
      holder.prisma = new Proxy(app, {
        get(target, prop) {
          if (prop === "$transaction" && gated) {
            gated = false;   // solo la primera transacción se retiene; las siguientes pasan tal cual
            return (cb: (tx: unknown) => Promise<unknown>, opts?: object) =>
              target.$transaction(async (tx) => { const r = await cb(tx); inside.open(); await release.wait; return r; }, { ...opts, timeout: 20_000 });
          }
          const v = Reflect.get(target, prop, target) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      }) as PrismaClient;
      const r1 = tokenRepository.replace(u.email, "RESET_PASSWORD", hash("primero"), future());
      let r2: Promise<unknown> | undefined;
      try {
        await reached(inside, r1);                               // r1 tiene el bloqueo y su token creado, sin confirmar
        r2 = tokenRepository.replace(u.email, "RESET_PASSWORD", hash("segundo"), future());   // otra conexión del pool
        await waitForLockWaiters(1);                             // r2 figura esperando un bloqueo en pg_stat_activity
        expect(await settled(r2)).toBe(false);                   // y no ha terminado
        // Lo confirmado no ha cambiado: r1 no ha confirmado y r2 no ha empezado a escribir.
        expect((await tokensOf(u.email)).map((r) => r.token)).toEqual([hash("previo")]);
      } finally {
        release.open();                                          // también si una aserción falla: la transacción de r1 no queda retenida
        holder.prisma = app;
      }
      await Promise.all([r1, r2]);
      // r2 se aplicó DESPUÉS de r1: sustituyó su token. Un solo token válido, el del segundo.
      expect((await tokensOf(u.email, "RESET_PASSWORD")).map((r) => r.token)).toEqual([hash("segundo")]);
    });

    it("con la fila de la cuenta retenida, dos reemplazos ESPERAN de verdad; al liberarla se aplican en serie y queda un solo token", async () => {
      const u = await newUser();
      await seed(u.email, "RESET_PASSWORD", hash("previo"));
      const h = await hold(`SELECT 1 FROM "User" WHERE "email" = '${u.email}' FOR UPDATE`);   // el mismo FOR UPDATE que toma el borrado de cuenta
      const r1 = tokenRepository.replace(u.email, "RESET_PASSWORD", hash("n1"), future());
      const r2 = tokenRepository.replace(u.email, "RESET_PASSWORD", hash("n2"), future());
      try {
        await waitForLockWaiters(2);                          // ambos figuran esperando un bloqueo (pg_stat_activity)
        expect(await settled(r1)).toBe(false);
        expect(await settled(r2)).toBe(false);
        expect((await tokensOf(u.email)).map((r) => r.token)).toEqual([hash("previo")]);   // mientras esperan no han tocado nada
      } finally { await h.release(); }
      await Promise.all([r1, r2]);
      const left = await tokensOf(u.email, "RESET_PASSWORD");
      expect(left).toHaveLength(1);
      expect([hash("n1"), hash("n2")]).toContain(left[0]!.token);
    });

    it("carga real: 12 reemplazos simultáneos (pool de 6 conexiones) de la misma cuenta y finalidad → siempre un solo token", async () => {
      const u = await newUser();
      for (let round = 0; round < 5; round++) {
        const hashes = Array.from({ length: 12 }, (_, i) => hash(`r${round}-${i}`));
        await Promise.all(hashes.map((x) => tokenRepository.replace(u.email, "VERIFY_EMAIL", x, future())));
        const left = await tokensOf(u.email, "VERIFY_EMAIL");
        expect(left).toHaveLength(1);
        expect(hashes).toContain(left[0]!.token);
      }
    }, 60_000);

    it("cuentas distintas son independientes: mientras la cuenta A está retenida, la B se reemplaza sin esperar", async () => {
      const a = await newUser(); const b = await newUser();
      const h = await hold(`SELECT 1 FROM "User" WHERE "email" = '${a.email}' FOR UPDATE`);
      const rA = tokenRepository.replace(a.email, "RESET_PASSWORD", hash("a"), future());
      try {
        await waitForLockWaiters(1);
        await tokenRepository.replace(b.email, "RESET_PASSWORD", hash("b"), future());   // termina aunque A esté esperando
        expect(await settled(rA)).toBe(false);
        expect(await tokensOf(b.email)).toHaveLength(1);
        expect(await tokensOf(a.email)).toHaveLength(0);
      } finally { await h.release(); }
      await rA;
      expect(await tokensOf(a.email)).toHaveLength(1);
    });

    it("finalidades distintas de una misma cuenta: cada una queda con su token (se serializan por cuenta, pero no se interfieren)", async () => {
      const u = await newUser();
      const h = await hold(`SELECT 1 FROM "User" WHERE "email" = '${u.email}' FOR UPDATE`);
      const rv = tokenRepository.replace(u.email, "VERIFY_EMAIL", hash("v"), future());
      const rr = tokenRepository.replace(u.email, "RESET_PASSWORD", hash("r"), future());
      try { await waitForLockWaiters(2); } finally { await h.release(); }
      await Promise.all([rv, rr]);
      expect((await tokensOf(u.email, "VERIFY_EMAIL")).map((r) => r.token)).toEqual([hash("v")]);
      expect((await tokensOf(u.email, "RESET_PASSWORD")).map((r) => r.token)).toEqual([hash("r")]);
    });
  });

  describe("replace frente al borrado de cuenta (mismo orden de bloqueos: User → VerificationToken)", () => {
    it("el borrado ya tiene la fila de la cuenta: el reemplazo espera, ve la cuenta borrada y NO deja un token huérfano", async () => {
      const u = await newUser();
      await seed(u.email, "RESET_PASSWORD", hash("previo"));
      const del = await holdAccountDeletion(u.email);
      const r = tokenRepository.replace(u.email, "RESET_PASSWORD", hash("nuevo"), future());
      const outcome = r.then(() => "creado", (e: unknown) => e);
      try {
        await waitForLockWaiters(1);
        expect(await settled(r)).toBe(false);
      } finally { await del.release(); }
      expect(await outcome).toBeInstanceOf(TokenOwnerMissingError);
      expect(await tokensOf(u.email)).toEqual([]);            // ni el previo (lo borró la cuenta) ni uno nuevo huérfano
      expect(await monitor.user.count({ where: { email: u.email } })).toBe(0);
    });

    it("el reemplazo ya tiene la fila (transacción SIN confirmar): el borrado de cuenta espera a que termine y luego elimina también el token nuevo", async () => {
      const u = await newUser();
      await seed(u.email, "VERIFY_EMAIL", hash("previo"));
      // El reemplazo REAL ejecuta su transacción (bloquea la cuenta, borra el token previo y crea el nuevo) y se queda sin confirmar.
      const inside = gate(); const release = gate();
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
      const r = tokenRepository.replace(u.email, "VERIFY_EMAIL", hash("nuevo"), future());
      let del: Promise<void> | undefined;
      try {
        await reached(inside, r);                              // el reemplazo tiene la fila bloqueada y el token nuevo creado, sin confirmar
        // El borrado de cuenta real: bloquea PRIMERO la fila de User (FOR UPDATE) y luego borra los tokens y la cuenta.
        del = other.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT set_config('lock_timeout', '10000', true)`;
          await tx.$queryRaw`SELECT 1 FROM "User" WHERE "email" = ${u.email} FOR UPDATE`;
          await tx.verificationToken.deleteMany({ where: { identifier: u.email } });
          await tx.user.delete({ where: { email: u.email } });
        }, { maxWait: 10_000, timeout: 60_000 }).then(() => undefined);
        await waitForLockWaiters(1);                           // el borrado está esperando el bloqueo que tiene el reemplazo
        expect(await settled(del)).toBe(false);
        expect(await monitor.user.count({ where: { email: u.email } })).toBe(1);
      } finally {
        release.open();                                        // también si una aserción falla: la transacción no queda retenida
        holder.prisma = app;
      }
      await Promise.all([r, del]);
      expect(await tokensOf(u.email)).toEqual([]);             // el borrado elimina el token nuevo: no queda ninguno huérfano
      expect(await monitor.user.count({ where: { email: u.email } })).toBe(0);
    });
  });

  describe("consumo de un solo uso (DELETE condicionado, count === 1)", () => {
    it("con la fila del token retenida, dos consumos ESPERAN en el DELETE; al liberarla gana uno solo y el otro recibe null", async () => {
      const u = await newUser();
      await seed(u.email, "VERIFY_EMAIL", hash("t"));
      const h = await hold(`SELECT 1 FROM "VerificationToken" WHERE "token" = '${hash("t")}' FOR UPDATE`);
      const c1 = tokenRepository.consume(hash("t"), "VERIFY_EMAIL");
      const c2 = tokenRepository.consume(hash("t"), "VERIFY_EMAIL");
      try {
        await waitForLockWaiters(2);           // los dos pasaron el SELECT (una lectura no se bloquea) y esperan en el DELETE
        expect(await settled(c1)).toBe(false);
        expect(await settled(c2)).toBe(false);
      } finally { await h.release(); }
      const results = await Promise.all([c1, c2]);
      expect(results.filter((r) => r === u.email)).toHaveLength(1);
      expect(results.filter((r) => r === null)).toHaveLength(1);
      expect(await tokensOf(u.email)).toEqual([]);
    });

    it("carga real: 8 consumos simultáneos del mismo token (pool de 6 conexiones) → un único ganador, repetido", async () => {
      const u = await newUser();
      for (let i = 0; i < 10; i++) {
        await seed(u.email, "RESET_PASSWORD", hash(`c${i}`));
        const results = await Promise.all(Array.from({ length: 8 }, () => tokenRepository.consume(hash(`c${i}`), "RESET_PASSWORD")));
        expect(results.filter((r) => r !== null)).toHaveLength(1);
      }
    }, 60_000);

    it("tokens distintos son independientes: con el token A retenido, el consumo del B termina sin esperar", async () => {
      const a = await newUser(); const b = await newUser();
      await seed(a.email, "VERIFY_EMAIL", hash("a")); await seed(b.email, "VERIFY_EMAIL", hash("b"));
      const h = await hold(`SELECT 1 FROM "VerificationToken" WHERE "token" = '${hash("a")}' FOR UPDATE`);
      const cA = tokenRepository.consume(hash("a"), "VERIFY_EMAIL");
      try {
        await waitForLockWaiters(1);
        expect(await tokenRepository.consume(hash("b"), "VERIFY_EMAIL")).toBe(b.email);
        expect(await settled(cA)).toBe(false);
      } finally { await h.release(); }
      expect(await cA).toBe(a.email);
    });

    it("un token caducado no se consume aunque exista (ni espera ni borra)", async () => {
      const u = await newUser();
      await seed(u.email, "VERIFY_EMAIL", hash("viejo"), new Date(Date.now() - 1000));
      expect(await tokenRepository.consume(hash("viejo"), "VERIFY_EMAIL")).toBeNull();
      expect(await tokensOf(u.email)).toHaveLength(1);
    });

    it("dos verifyEmail simultáneos con el mismo token (servicio real): uno verifica la cuenta y el otro recibe INVALID_TOKEN", async () => {
      const u = await newUser();
      const raw = "e".repeat(64);
      await seed(u.email, "VERIFY_EMAIL", sha(raw));
      const results = await Promise.allSettled(Array.from({ length: 4 }, () => authService.verifyEmail(raw)));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results.filter((x) => x.status === "rejected")) expect((r as PromiseRejectedResult).reason).toMatchObject({ code: "INVALID_TOKEN", status: 400 });
      expect((await monitor.user.findUniqueOrThrow({ where: { email: u.email } })).emailVerified).toBeInstanceOf(Date);
    });
  });

  describe("rollback de replace (transacción real)", () => {
    it("si el INSERT falla por un hash repetido, el borrado anterior se revierte aunque haya otras conexiones activas", async () => {
      const a = await newUser(); const b = await newUser();
      await seed(a.email, "RESET_PASSWORD", hash("previo"));
      await seed(b.email, "RESET_PASSWORD", hash("choque"));
      await expect(tokenRepository.replace(a.email, "RESET_PASSWORD", hash("choque"), future())).rejects.toMatchObject({ code: "P2002" });
      expect((await tokensOf(a.email)).map((r) => r.token)).toEqual([hash("previo")]);
    });
  });
});
