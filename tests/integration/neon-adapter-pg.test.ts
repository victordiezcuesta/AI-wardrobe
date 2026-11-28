import { randomUUID } from "node:crypto";
import { neonConfig } from "@neondatabase/serverless";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isUniqueViolationOn } from "@/lib/errors/db";
import { createPrismaClient } from "@/lib/prisma";
import type { PrismaClient } from "@/generated/prisma/client";
import { applyMigrations, listMigrations } from "../helpers/migrations";

/**
 * El adaptador REAL de producción (`@prisma/adapter-neon`, driver `@neondatabase/serverless`, transporte WebSocket) contra
 * un PostgreSQL local, a través del proxy WebSocket oficial de Neon (`ghcr.io/neondatabase/wsproxy`): la misma pila que
 * usa la app en Vercel, salvo el servicio de Neon en sí. NO sustituye una prueba contra Neon (pooler PgBouncer incluido).
 *
 * Se omite salvo que existan las tres variables (así `npm test` no necesita Docker):
 *   TEST_PG_URL        PostgreSQL local de administración (127.0.0.1), contraseña por PGPASSWORD.
 *   TEST_NEON_WSPROXY  host:puerto local del proxy WebSocket, p. ej. 127.0.0.1:5488.
 *   TEST_NEON_PG_ADDR  host:puerto del PostgreSQL tal y como lo ve el proxy, p. ej. 172.17.0.2:5432.
 * Cada ejecución crea su propia base `neonad_<aleatorio>` y la elimina al terminar. Nunca se conecta a hosts remotos.
 */
const ADMIN_URL = process.env.TEST_PG_URL;
const PROXY = process.env.TEST_NEON_WSPROXY;
const PG_ADDR = process.env.TEST_NEON_PG_ADDR;
const enabled = Boolean(ADMIN_URL && PROXY && PG_ADDR);
const isLocal = (host: string) => ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host);
const TEMP_DB = /^neonad_[a-z0-9]{1,8}$/;

const MAX = 3;
let dbName = "";
let url = "";
let neon: PrismaClient; // pool de MAX conexiones, connectionTimeoutMillis acotado
let admin: pg.Client;

const backends = async () =>
  Number((await admin.query("select count(*)::int n from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()", [dbName])).rows[0].n);
const killBackends = async () =>
  admin.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()", [dbName]);
const incr = (key: string) => neon.$executeRaw`insert into "RateLimit" (key, count) values (${key}, 1) on conflict (key) do update set count = "RateLimit".count + 1`;
const count = async (key: string) => (await neon.rateLimit.findUnique({ where: { key } }))?.count;

describe.skipIf(!enabled)("PrismaNeon (adaptador de producción) vía proxy WebSocket de Neon", () => {
  beforeAll(async () => {
    if (!isLocal(new URL(ADMIN_URL!).hostname) || !isLocal(PROXY!.split(":")[0] ?? "")) throw new Error("Solo se admiten PostgreSQL y proxy locales");
    dbName = `neonad_${Math.random().toString(36).slice(2, 10)}`;
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const u = new URL(ADMIN_URL!);
    u.pathname = `/${dbName}`;
    const setup = new pg.Client({ connectionString: u.toString() });
    await setup.connect();
    try { await applyMigrations((sql) => setup.query(sql), listMigrations()); } finally { await setup.end(); }
    // Cadena tal y como la vería el proxy: host:puerto del servidor, sin TLS (el proxy local no lo usa).
    url = `postgresql://${u.username}:${encodeURIComponent(decodeURIComponent(u.password) || process.env.PGPASSWORD || "")}@${PG_ADDR}/${dbName}?sslmode=disable`;
    neonConfig.wsProxy = (host, port) => `${PROXY}/v1?address=${host}:${port}`;
    neonConfig.useSecureWebSocket = false;
    neonConfig.pipelineConnect = false;
    neonConfig.pipelineTLS = false;
    neon = createPrismaClient(url, { max: MAX, connectionTimeoutMillis: 3_000, idleTimeoutMillis: 60_000 });
  }, 60_000);

  afterAll(async () => {
    await neon?.$disconnect();
    if (admin && dbName) {
      if (!TEMP_DB.test(dbName)) throw new Error("Nombre de base de datos temporal inesperado: no se borra nada");
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    }
    await admin?.end();
  });

  it("lee y escribe con tipos correctos (fechas, enteros, texto)", async () => {
    const email = `${randomUUID()}@example.test`;
    const u = await neon.user.create({ data: { email, name: "Ñandú" } });
    const back = await neon.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(back.email).toBe(email);
    expect(back.name).toBe("Ñandú");
    expect(back.createdAt).toBeInstanceOf(Date);
  });

  it("40 incrementos concurrentes sobre la misma fila no pierden actualizaciones", async () => {
    await Promise.all(Array.from({ length: 40 }, () => incr("hot")));
    expect(await count("hot")).toBe(40);
  });

  it("una transacción interactiva confirma y otra se revierte por completo", async () => {
    await neon.$transaction(async (tx) => { await tx.rateLimit.create({ data: { key: "tx-ok" } }); });
    await expect(neon.$transaction(async (tx) => { await tx.rateLimit.create({ data: { key: "tx-bad" } }); throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await count("tx-ok")).toBe(0);
    expect(await count("tx-bad")).toBeUndefined();
  });

  it("más transacciones simultáneas que conexiones del pool terminan todas, sin deadlock y sin superar el máximo", async () => {
    let peak = 0;
    await Promise.all(Array.from({ length: 12 }, (_, i) =>
      neon.$transaction(async (tx) => {
        await tx.$executeRaw`insert into "RateLimit" (key, count) values (${"pool-" + i}, 1)`;
        await tx.$executeRaw`insert into "RateLimit" (key, count) values ('shared-tx', 1) on conflict (key) do update set count = "RateLimit".count + 1`;
        peak = Math.max(peak, await backends());
        await new Promise((r) => setTimeout(r, 30));
      }, { timeout: 15_000, maxWait: 15_000 })));
    expect(await count("shared-tx")).toBe(12);
    expect(peak).toBeLessThanOrEqual(MAX);
  });

  it("tras cortar todas las conexiones, la siguiente consulta se recupera sola", async () => {
    await incr("alive");
    await killBackends();
    await new Promise((r) => setTimeout(r, 200));
    // El pool descarta el cliente roto: como mucho falla la primera consulta; las siguientes deben funcionar.
    let ok = false;
    for (let i = 0; i < MAX + 2 && !ok; i++) ok = await incr("alive").then(() => true, () => false);
    expect(ok).toBe(true);
    await incr("alive");
    expect((await count("alive")) ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("si cortan la conexión durante una consulta, esa consulta falla y el cliente sigue siendo utilizable", async () => {
    const slow = neon.$queryRaw`select pg_sleep(5)::text`;
    const settled = slow.then(() => "ok", (e: unknown) => String(e));
    await new Promise((r) => setTimeout(r, 300));
    await killBackends();
    const outcome = await settled;
    expect(outcome).not.toBe("ok");
    expect(outcome).not.toMatch(/deserialize/); // falla por el corte, no por el tipo de la consulta
    let ok = false;
    for (let i = 0; i < MAX + 2 && !ok; i++) ok = await incr("after-kill").then(() => true, () => false);
    expect(ok).toBe(true);
  });

  it("con el pool agotado, una consulta extra falla rápido (connectionTimeoutMillis) en vez de colgarse", async () => {
    const release: Array<() => void> = [];
    // `maxWait` (por defecto 2 s en Prisma) acotado muy por encima: bajo la carga de la suite completa el handshake WebSocket de las
    // 3 conexiones puede tardar más y un `P2028` aquí no es lo que se prueba (sí lo es la consulta extra de abajo).
    let holderFailure: unknown;
    const holders = Array.from({ length: MAX }, () =>
      neon.$transaction(async (tx) => { await tx.$queryRaw`select 1`; await new Promise<void>((r) => release.push(r)); }, { timeout: 20_000, maxWait: 20_000 })
        .catch((e: unknown) => { holderFailure = e; }));
    const deadline = Date.now() + 20_000;
    while (release.length < MAX && holderFailure === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    if (release.length < MAX) { release.forEach((r) => r()); await Promise.all(holders); throw new Error(`los ${MAX} titulares no llegaron a abrir su transacción: ${String(holderFailure)}`); }
    const t0 = Date.now();
    await expect(incr("starved")).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(8_000);
    release.forEach((r) => r());
    await Promise.all(holders);
    expect(holderFailure).toBeUndefined();
    await incr("starved"); // se recupera
  }, 30_000);

  /** Forma del error del adaptador que el código de producción reconoce por estructura (nunca por el texto del mensaje). */
  const causeOf = (e: unknown) => (e as { meta?: { driverAdapterError?: { cause?: Record<string, unknown> } } }).meta?.driverAdapterError?.cause;
  const failure = async (p: Promise<unknown>) => p.then(() => { throw new Error("debía fallar"); }, (e: unknown) => e);

  it("la violación de unicidad del email llega con la forma que reconoce auth.service (isUniqueViolationOn)", async () => {
    const email = `${randomUUID()}@example.test`;
    await neon.user.create({ data: { email } });
    const err = await failure(neon.user.create({ data: { email } }));
    expect(isUniqueViolationOn(err, { table: "User", fields: ["email"], index: "User_email_key" })).toBe(true);
    expect(isUniqueViolationOn(err, { table: "User", fields: ["id"], index: "User_pkey" })).toBe(false);
  });

  it("lock_timeout (55P03) llega como la estructura que reconoce media-lease", async () => {
    await neon.rateLimit.create({ data: { key: "locked" } });
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const holder = neon.$transaction(async (tx) => { await tx.$queryRaw`select 1 from "RateLimit" where key = 'locked' for update`; locked(); await held; }, { timeout: 20_000 });
    await isLocked;
    const err = await failure(neon.$transaction(async (tx) => {
      await tx.$queryRaw`select set_config('lock_timeout', '300ms', true)`;
      await tx.$queryRaw`select 1 from "RateLimit" where key = 'locked' for update`;
    }));
    release();
    await holder;
    expect((err as { code?: string }).code).toBe("P2010");
    expect(causeOf(err)).toMatchObject({ kind: "postgres" });
    const c = causeOf(err)!;
    expect(c.originalCode === "55P03" || c.code === "55P03").toBe(true);
  });

  it("statement_timeout (57014) llega como la estructura que reconoce media-reconcile", async () => {
    const err = await failure(neon.$transaction(async (tx) => {
      await tx.$queryRaw`select set_config('statement_timeout', '200ms', true)`;
      await tx.$queryRaw`select pg_sleep(3)::text`;
    }));
    const c = causeOf(err);
    expect(c?.originalCode === "57014" || c?.code === "57014").toBe(true);
  });

  it("$disconnect cierra todas las conexiones del pool", async () => {
    const own = createPrismaClient(url, { max: 2 });
    await Promise.all([own.$queryRaw`select 1`, own.$queryRaw`select pg_sleep(0.2)::text`]);
    const before = await backends();
    expect(before).toBeGreaterThanOrEqual(2);
    await own.$disconnect();
    await new Promise((r) => setTimeout(r, 300));
    expect(await backends()).toBeLessThan(before);
  });
});
