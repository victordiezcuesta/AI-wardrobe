import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/generated/prisma/client";
import { prismaProxy, setTestEnv } from "../helpers/mock-prisma";
import { applyMigrations, listMigrations } from "../helpers/migrations";

/**
 * Fase 19.14d — purgeExpiredRateLimits con CONCURRENCIA REAL: PostgreSQL de verdad, varias conexiones independientes y
 * transacciones solapadas (PGlite no sirve: es de una sola sesión). Solo se ejecuta si TEST_PG_URL apunta EXACTAMENTE al
 * PostgreSQL local autorizado (127.0.0.1:55433); si no, se omite limpiamente y no forma parte del `npm run check` habitual.
 *
 * Aislamiento: cada ejecución crea su propia base `race_<aleatorio>`, aplica las migraciones del proyecto y la elimina al
 * terminar (también si falla). Nunca se toca una base preexistente. Los ganchos de prueba (trigger de auditoría/puerta) se
 * instalan SOLO en esa base temporal.
 *
 * Sincronización: sin esperas arbitrarias. Las secuencias se coordinan con una «puerta» (bloqueo consultivo que mantiene el
 * controlador) y se sondea el ESTADO de PostgreSQL (pg_stat_activity, pg_blocking_pids) hasta que se cumple la condición, con
 * un límite de tiempo que hace fallar la prueba en vez de colgarla.
 */
const ADMIN_URL = process.env.TEST_PG_URL;
const holder = vi.hoisted(() => ({ prisma: null as PrismaClient | null }));
vi.mock("@/lib/prisma", () => ({ prisma: prismaProxy(holder) }));

const GATE = 777;                                  // clave del bloqueo consultivo que hace de puerta
const TEMP_DB = /^race_[a-z0-9]{8}$/;
const APP = `aiw-purge-${randomUUID().slice(0, 8)}`;   // application_name de las conexiones del servicio y del limitador
const CTL = `${APP}-ctl`;                                // application_name de las conexiones del controlador

function assertAuthorizedTarget(url: string) {
  const u = new URL(url);
  // Solo el PostgreSQL local autorizado. Los mensajes no incluyen la URL ni credenciales.
  if (u.hostname !== "127.0.0.1" || u.port !== "55433") throw new Error("TEST_PG_URL debe apuntar a 127.0.0.1:55433 (el PostgreSQL local autorizado)");
}

let dbName = ""; let dbUrl = "";
let app: PrismaClient;
let svc: typeof import("@/services/rate-limit-purge.service");
let rl: typeof import("@/lib/rate-limit");
const opened: pg.Client[] = [];

beforeAll(async () => {
  if (!ADMIN_URL) return;
  assertAuthorizedTarget(ADMIN_URL);
  setTestEnv();
  dbName = `race_${Math.random().toString(36).slice(2, 10).padEnd(8, "0")}`;
  if (!TEMP_DB.test(dbName)) throw new Error("Nombre de base temporal inesperado");
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE ${dbName}`); } finally { await admin.end(); }
  const u = new URL(ADMIN_URL); u.pathname = `/${dbName}`; dbUrl = u.toString();
  const setup = new pg.Client({ connectionString: dbUrl });
  await setup.connect();
  try { await applyMigrations((sql) => setup.query(sql), listMigrations()); } finally { await setup.end(); }
  app = new PrismaClient({ adapter: new PrismaPg({ connectionString: dbUrl, max: 8, application_name: APP }) });
  holder.prisma = app;
  svc = await import("@/services/rate-limit-purge.service");
  rl = await import("@/lib/rate-limit");
}, 60_000);

afterAll(async () => {
  if (!ADMIN_URL || !dbName) return;
  if (!TEMP_DB.test(dbName)) throw new Error("Nombre de base temporal inesperado: no se borra nada");
  for (const c of opened.splice(0)) await c.end().catch(() => undefined);
  // FORCE termina también las sesiones que sigan conectadas, aunque una prueba haya fallado a medias.
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try { await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); } finally { await admin.end(); }
  await app?.$disconnect().catch(() => undefined);
});

/** Conexión independiente del controlador, con tiempos máximos para que nada pueda quedar bloqueado indefinidamente. */
async function ctl(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: dbUrl, application_name: CTL });
  await c.connect();
  await c.query("SET statement_timeout = '40s'; SET lock_timeout = '30s'; SET idle_in_transaction_session_timeout = '90s'");
  opened.push(c);
  return c;
}
const admin = async () => (opened[0] ?? (await ctl()));
const q = async <T extends object = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await (await admin()).query(sql, params)).rows as T[];

/** Espera a que se cumpla una condición observable (sondeo del estado de PostgreSQL); falla con límite de tiempo. */
async function until<T>(fn: () => Promise<T | false | null | undefined>, what: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`No se alcanzó la condición: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const appWaiting = async (waitEvent: string[]) => (await q<{ pid: number }>(
  `SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND application_name = $1 AND state = 'active' AND wait_event_type = 'Lock' AND wait_event = ANY($2)`,
  [APP, waitEvent])).map((r) => r.pid);

const HOOK = `
  CREATE TABLE IF NOT EXISTS purge_audit (pid int, key text, at timestamptz);
  CREATE OR REPLACE FUNCTION purge_test_hook() RETURNS trigger LANGUAGE plpgsql AS $f$
  BEGIN
    IF OLD."key" LIKE 'gate:%' THEN
      PERFORM set_config('lock_timeout', '0', true);   -- la espera en la puerta no debe agotar el lock_timeout del servicio
      PERFORM pg_advisory_xact_lock(${GATE});          -- la puerta: mantiene al lote DENTRO del DELETE, con sus filas bloqueadas
    END IF;
    IF OLD."key" = 'boom' THEN RAISE EXCEPTION 'fallo controlado del lote'; END IF;
    INSERT INTO purge_audit VALUES (pg_backend_pid(), OLD."key", clock_timestamp());
    RETURN OLD;
  END $f$;
  DROP TRIGGER IF EXISTS purge_test_hook ON "RateLimit";
  CREATE TRIGGER purge_test_hook BEFORE DELETE ON "RateLimit" FOR EACH ROW EXECUTE FUNCTION purge_test_hook();`;
const installHook = async () => { await (await admin()).query(HOOK); };

const seed = (prefix: string, n: number, hoursAgo: number, count = 1) =>
  q(`INSERT INTO "RateLimit" ("key", "count", "windowStart") SELECT $1 || ':' || g, $2, NOW() - make_interval(hours => $3) FROM generate_series(1, $4) g`, [prefix, count, hoursAgo, n]);
const keys = async () => (await q<{ key: string }>(`SELECT "key" FROM "RateLimit" ORDER BY "key"`)).map((r) => r.key);
const total = async () => Number((await q<{ n: string }>(`SELECT count(*) AS n FROM "RateLimit"`))[0]!.n);

beforeEach(async () => {
  if (!ADMIN_URL) return;
  for (const c of opened.splice(0)) await c.query("ROLLBACK").catch(() => undefined).then(() => c.end().catch(() => undefined)); // cierra sesiones y libera bloqueos
  await ctl();
  await q(`DROP TRIGGER IF EXISTS purge_test_hook ON "RateLimit"`);
  await q(`TRUNCATE "RateLimit"`);
  await q(`CREATE TABLE IF NOT EXISTS purge_audit (pid int, key text, at timestamptz)`);
  await q(`TRUNCATE purge_audit`);
});
afterEach(async () => {
  if (!ADMIN_URL) return;
  for (const c of opened.splice(0)) await c.query("ROLLBACK").catch(() => undefined).then(() => c.end().catch(() => undefined));
});

describe.skipIf(!ADMIN_URL)("purga de RateLimit con PostgreSQL real (127.0.0.1:55433, base temporal race_*)", () => {
  it("la base y la URL son las autorizadas (comprobación previa a cualquier operación destructiva)", async () => {
    expect(TEMP_DB.test(dbName)).toBe(true);
    const u = new URL(dbUrl);
    expect([u.hostname, u.port, u.pathname.slice(1)]).toEqual(["127.0.0.1", "55433", dbName]);
    const [row] = await q<{ db: string; v: string }>(`SELECT current_database() AS db, current_setting('server_version') AS v`);
    expect(row!.db).toBe(dbName);
    expect(/^(17|18)\./.test(row!.v)).toBe(true); // 17 (desarrollo) o 18 (versión de producción en Neon); cualquier otra no está validada
  });

  // ── A ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  it("A. dos purgas solapadas: SKIP LOCKED reparte filas distintas, sin esperas ni borrados dobles; la suma es el total", async () => {
    await installHook();
    await seed("gate", 12_000, 30);
    const gate = await ctl();
    await gate.query(`SELECT pg_advisory_lock(${GATE})`);          // la puerta se cierra: cada lote se queda DENTRO de su DELETE
    const runs = [svc.purgeExpiredRateLimits(), svc.purgeExpiredRateLimits()];
    // Condición de solape: las DOS purgas están dentro de su DELETE esperando la puerta (ninguna esperando una fila bloqueada).
    // Si la 2.ª no usara SKIP LOCKED, estaría esperando el bloqueo de fila de la 1.ª (wait_event transactionid/tuple), no la puerta.
    const pids = await until(async () => { const w = await appWaiting(["advisory"]); return new Set(w).size >= 2 ? w : false; }, "las dos purgas dentro del DELETE a la vez");
    expect(new Set(pids).size).toBe(2);
    expect(await appWaiting(["transactionid", "tuple"])).toEqual([]); // nadie espera filas bloqueadas de otro
    await gate.query(`SELECT pg_advisory_unlock(${GATE})`);          // se abre la puerta
    const [r1, r2] = await Promise.all(runs);
    expect(r1!.deleted + r2!.deleted).toBe(12_000);                  // la suma coincide con lo que correspondía purgar
    expect(r1!.deleted).toBeGreaterThan(0); expect(r2!.deleted).toBeGreaterThan(0);   // las dos trabajaron
    expect([r1!.complete, r2!.complete].some(Boolean)).toBe(true);   // la que borró lo último ve su propio resultado: terminada
    for (const r of [r1!, r2!]) { expect(r.batches).toBeGreaterThanOrEqual(1); expect(r.deleted).toBeLessThanOrEqual(r.batches * 5_000); }
    expect(await total()).toBe(0);
    const audit = (await q<{ pid: number; n: string; distinct_keys: string }>(`SELECT pid, count(*) AS n, count(DISTINCT key) AS distinct_keys FROM purge_audit GROUP BY pid`));
    expect(audit.length).toBe(2);                                    // dos conexiones distintas borraron
    expect(audit.reduce((a, r) => a + Number(r.n), 0)).toBe(12_000);
    const dup = await q<{ n: string }>(`SELECT count(*) - count(DISTINCT key) AS n FROM purge_audit`);
    expect(Number(dup[0]!.n)).toBe(0);                               // ninguna clave borrada dos veces
    expect(await svc.purgeExpiredRateLimits()).toEqual({ deleted: 0, batches: 1, complete: true });
  }, 90_000);

  // ── B ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  it("B. filas caducadas bloqueadas por otra transacción: la purga continúa con las libres, complete=false y, al liberar, termina", async () => {
    await seed("free", 100, 30); await seed("locked", 30, 30);
    const x = await ctl();
    await x.query("BEGIN");
    await x.query(`SELECT "key" FROM "RateLimit" WHERE "key" LIKE 'locked:%' FOR UPDATE`);
    const probe = await ctl();
    await expect(probe.query(`SELECT 1 FROM "RateLimit" WHERE "key" = 'locked:1' FOR UPDATE NOWAIT`)).rejects.toMatchObject({ code: "55P03" }); // el bloqueo es real
    const t0 = Date.now();
    const res = await svc.purgeExpiredRateLimits();
    expect(Date.now() - t0).toBeLessThan(10_000);                    // no esperó a las filas bloqueadas
    expect(res).toEqual({ deleted: 100, batches: 1, complete: false });
    expect((await keys()).every((k) => k.startsWith("locked:"))).toBe(true);
    expect(await total()).toBe(30);
    await x.query("ROLLBACK");                                       // se liberan los bloqueos
    expect(await svc.purgeExpiredRateLimits()).toEqual({ deleted: 30, batches: 1, complete: true });
    expect(await total()).toBe(0);
  }, 60_000);

  it("B2. todas las caducadas bloqueadas: deleted 0, complete false y nada se pierde", async () => {
    await seed("locked", 10, 30);
    const x = await ctl();
    await x.query("BEGIN");
    await x.query(`SELECT "key" FROM "RateLimit" FOR UPDATE`);
    expect(await svc.purgeExpiredRateLimits()).toEqual({ deleted: 0, batches: 1, complete: false });
    expect(await total()).toBe(10);
    await x.query("COMMIT");
    expect(await svc.purgeExpiredRateLimits()).toEqual({ deleted: 10, batches: 1, complete: true });
  }, 60_000);

  // ── C ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  it("C1. rateLimit sobre una clave que la purga tiene bloqueada: espera, y la ventana renovada NO desaparece (contador exacto)", async () => {
    await installHook();
    await seed("gate", 1, 30, 9);                                    // gate:1, caducada, contador 9
    const gate = await ctl();
    await gate.query(`SELECT pg_advisory_lock(${GATE})`);
    const purge = svc.purgeExpiredRateLimits();
    await until(async () => (await appWaiting(["advisory"])).length >= 1, "la purga dentro del DELETE con gate:1 bloqueada");
    const limited = rl.rateLimit("gate:1", 3, 3600);                // coincide con la purga sobre la MISMA clave
    const limitedPid = await until(async () => { const w = await appWaiting(["transactionid", "tuple"]); return w.length ? w[0] : false; }, "rateLimit esperando el bloqueo de fila de la purga");
    expect(limitedPid).toBeGreaterThan(0);
    await gate.query(`SELECT pg_advisory_unlock(${GATE})`);          // la purga continúa, confirma y libera la fila
    const [res] = await Promise.all([purge, limited]);               // rateLimit no lanza: la fila ya no existe y se inserta
    expect(res.deleted).toBe(1);
    const [row] = await q<{ count: number; recent: boolean }>(`SELECT "count", "windowStart" > NOW() - INTERVAL '1 minute' AS recent FROM "RateLimit" WHERE "key" = 'gate:1'`);
    expect(row!.count).toBe(1);                                      // exactamente 1: ventana nueva (como un reinicio), no 10 ni 0
    expect(row!.recent).toBe(true);                                  // ventana abierta ahora, no la caducada original
    expect(await svc.purgeExpiredRateLimits()).toEqual({ deleted: 0, batches: 1, complete: true }); // la ventana renovada sobrevive a otra purga
    expect((await q<{ count: number }>(`SELECT "count" FROM "RateLimit" WHERE "key" = 'gate:1'`))[0]!.count).toBe(1);
    expect(await rl.rateLimitStatus("gate:1", 3, 3600)).toBe(false);
  }, 60_000);

  it("C2. selección vieja de verdad: otra transacción refresca la fila y confirma MIENTRAS el DELETE espera; la condición repetida la salva", async () => {
    await seed("stale", 1, 30, 4);
    const x = await ctl(); const y = await ctl(); const z = await ctl();
    const xPid = (await x.query("SELECT pg_backend_pid() AS p")).rows[0].p as number;
    const yPid = (await y.query("SELECT pg_backend_pid() AS p")).rows[0].p as number;
    await x.query("BEGIN");
    await x.query(`UPDATE "RateLimit" SET "count" = 1, "windowStart" = NOW() WHERE "key" = 'stale:1'`);    // como rateLimit al abrir ventana (sin confirmar)
    // La sentencia REAL del servicio con una selección «vieja» que sigue devolviendo la fila (sin FOR UPDATE: no se bloquea al seleccionar).
    const stmt = svc.purgeBatchSql(Prisma.sql`SELECT ${"stale:1"}::text AS "key"`);
    const inFlight = y.query({ text: stmt.text, values: stmt.values });
    await until(async () => (await z.query("SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS b", [xPid, yPid])).rows[0].b, "el DELETE esperando a la transacción que refrescó la fila");
    await x.query("COMMIT");                                         // la fila queda refrescada y confirmada
    expect((await inFlight).rowCount).toBe(0);                       // el DELETE reevalúa la condición sobre la versión nueva: no borra
    expect(await keys()).toEqual(["stale:1"]);
    expect((await q<{ count: number }>(`SELECT "count" FROM "RateLimit"`))[0]!.count).toBe(1);
  }, 60_000);

  it("C2-control. SIN la condición repetida, la misma coreografía borraría la fila refrescada (la protección es necesaria)", async () => {
    await seed("stale", 1, 30, 4);
    const x = await ctl(); const y = await ctl(); const z = await ctl();
    const xPid = (await x.query("SELECT pg_backend_pid() AS p")).rows[0].p as number;
    const yPid = (await y.query("SELECT pg_backend_pid() AS p")).rows[0].p as number;
    await x.query("BEGIN");
    await x.query(`UPDATE "RateLimit" SET "count" = 1, "windowStart" = NOW() WHERE "key" = 'stale:1'`);
    const inFlight = y.query(`WITH doomed AS (SELECT 'stale:1'::text AS "key") DELETE FROM "RateLimit" r USING doomed d WHERE r."key" = d."key"`); // sin recomprobar la antigüedad
    await until(async () => (await z.query("SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS b", [xPid, yPid])).rows[0].b, "el DELETE de control esperando");
    await x.query("COMMIT");
    expect((await inFlight).rowCount).toBe(1);                       // borra la fila ya refrescada: perdería su contador
    expect(await keys()).toEqual([]);
  }, 60_000);

  // ── D ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  it("D. la comprobación SELECT EXISTS ve las filas bloqueadas (MVCC), no espera, no bloquea y no altera nada", async () => {
    await seed("locked", 20, 30); await seed("viva", 3, 1);
    const x = await ctl();
    await x.query("BEGIN");
    await x.query(`SELECT "key" FROM "RateLimit" WHERE "key" LIKE 'locked:%' FOR UPDATE`);
    const y = await ctl();
    await y.query("SET lock_timeout = '300ms'; SET statement_timeout = '3s'");   // si esperara a un bloqueo, fallaría aquí
    const yPid = (await y.query("SELECT pg_backend_pid() AS p")).rows[0].p as number;
    const snap = async () => (await q<{ key: string; xmin: string; xmax: string; count: number }>(`SELECT "key", "count", xmin::text AS xmin, xmax::text AS xmax FROM "RateLimit" ORDER BY "key"`));
    const before = await snap();
    const stmt = svc.expiredRowsRemainSql();
    const t0 = Date.now();
    const out = await y.query({ text: stmt.text, values: stmt.values });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(out.rows).toEqual([{ pending: true }]);                   // ve las filas caducadas aunque estén bloqueadas por x
    const heldByY = await q<{ n: string }>(`SELECT count(*) AS n FROM pg_locks WHERE pid = $1 AND locktype IN ('transactionid', 'tuple')`, [yPid]);
    expect(Number(heldByY[0]!.n)).toBe(0);                           // no tomó ningún bloqueo de fila ni tuvo xid
    expect(await snap()).toEqual(before);                            // ni cambió datos ni versiones (xmin/xmax/count)
    await x.query("ROLLBACK");
    const out2 = await y.query({ text: stmt.text, values: stmt.values });
    expect(out2.rows).toEqual([{ pending: true }]);                  // siguen caducadas sin bloqueo
    await q(`DELETE FROM "RateLimit" WHERE "key" LIKE 'locked:%'`);
    expect((await y.query({ text: stmt.text, values: stmt.values })).rows).toEqual([{ pending: false }]); // solo quedan las vivas
  }, 60_000);

  // ── E ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  it("E1. fallo controlado dentro de un lote: el lote entero se revierte, el error se propaga y no queda ninguna conexión abierta en transacción", async () => {
    await installHook();
    await seed("e", 2_999, 30); await q(`INSERT INTO "RateLimit" ("key", "count", "windowStart") VALUES ('boom', 1, NOW() - INTERVAL '30 hours')`);
    await expect(svc.purgeExpiredRateLimits()).rejects.toThrow();
    expect(await total()).toBe(3_000);                               // nada se borró: ni siquiera las filas anteriores a 'boom'
    const stuck = await q<{ n: string }>(`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND application_name = $1 AND state LIKE 'idle in transaction%'`, [APP]);
    expect(Number(stuck[0]!.n)).toBe(0);
    await q(`DROP TRIGGER purge_test_hook ON "RateLimit"`);          // el gancho fallaría también al limpiar a mano
    await q(`DELETE FROM "RateLimit" WHERE "key" = 'boom'`);
    expect(await svc.purgeExpiredRateLimits()).toEqual({ deleted: 2_999, batches: 1, complete: true });
  }, 60_000);

  it("E2. fallo en un lote posterior: el primero (ya confirmado) permanece confirmado y el fallo no deja nada a medias", async () => {
    await installHook();
    await seed("e", 5_999, 30);                                      // las más antiguas: entran en el 1.er lote (5000) y en el 2.º (999)
    await q(`INSERT INTO "RateLimit" ("key", "count", "windowStart") VALUES ('boom', 1, NOW() - INTERVAL '25 hours')`); // la más reciente: cae en el 2.º lote
    // Debe fallar POR EL GANCHO (2.º lote), no por otra causa: un statement_timeout (57014) en el 1.er lote bajo carga también rechaza, y antes se
    // confundía con el fallo inyectado (el recuento fallaba después con 6000). Ahora el error dice cuál fue.
    await expect(svc.purgeExpiredRateLimits()).rejects.toThrow(/fallo controlado del lote/);
    expect(await total()).toBe(1_000);                               // 5000 borradas y confirmadas; el 2.º lote (999 + boom) se revirtió entero
    expect(await keys()).toContain("boom");
    await q(`DROP TRIGGER purge_test_hook ON "RateLimit"`);          // el gancho fallaría también al limpiar a mano
    await q(`DELETE FROM "RateLimit" WHERE "key" = 'boom'`);
    expect(await svc.purgeExpiredRateLimits()).toEqual({ deleted: 999, batches: 1, complete: true });
    expect(await total()).toBe(0);
  }, 90_000);

  // ── F ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  it("F. EXPLAIN: el índice RateLimit_windowStart_idx existe y está disponible para la selección (se muestra el plan real)", async () => {
    await q(`INSERT INTO "RateLimit" ("key", "count", "windowStart") SELECT 'old:' || g, 1, NOW() - make_interval(hours => 25 + (g % 200)) FROM generate_series(1, 10000) g`);
    await q(`INSERT INTO "RateLimit" ("key", "count", "windowStart") SELECT 'new:' || g, 1, NOW() - make_interval(mins => g % 1200) FROM generate_series(1, 90000) g`);
    await q(`ANALYZE "RateLimit"`);
    const idx = await q<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE tablename = 'RateLimit' AND indexname = 'RateLimit_windowStart_idx'`);
    expect(idx).toHaveLength(1);
    expect(idx[0]!.indexdef).toContain(`("windowStart")`);
    const stmt = svc.purgeBatchSql();
    const sqlText = stmt.text.replace(/\$(\d+)/g, (_m, n: string) => String(stmt.values[Number(n) - 1]));
    const plan = async (pre = "") => (await q<{ "QUERY PLAN": string }>(`${pre}EXPLAIN ${sqlText}`)).map((r) => r["QUERY PLAN"]).join("\n");
    const natural = await plan();
    const c = await ctl();
    await c.query("BEGIN"); await c.query("SET LOCAL enable_seqscan = off");
    const forced = (await c.query(`EXPLAIN ${sqlText}`)).rows.map((r) => r["QUERY PLAN"]).join("\n");
    await c.query("ROLLBACK");
    process.stdout.write(`\n[EXPLAIN plan natural, 100 000 filas, 10 000 caducadas]\n${natural}\n[EXPLAIN con enable_seqscan = off]\n${forced}\n`);
    expect(natural).toContain("RateLimit");
    expect(forced).toContain("RateLimit_windowStart_idx");           // el índice está disponible para esta consulta
    // No se exige que el plan natural lo use: depende de las estadísticas.
  }, 90_000);
});
