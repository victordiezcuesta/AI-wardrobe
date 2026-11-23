import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { Prisma } from "@/generated/prisma/client";
import { startTestDb, type TestDb } from "../helpers/db";
import { prismaProxy, setTestEnv } from "../helpers/mock-prisma";

/**
 * Fase 19.14b — purgeExpiredRateLimits sobre PGlite (SQL real, restricciones reales, reloj de PostgreSQL). Los márgenes de
 * tiempo son amplios (25 h frente a 23 h para la retención de 24 h) para que ninguna prueba dependa de lo que tarde en ejecutarse.
 * La concurrencia entre conexiones reales (SKIP LOCKED) queda para la subfase 19.14d, con PostgreSQL local.
 */
const holder = vi.hoisted(() => ({ prisma: null as PrismaClient | null }));
vi.mock("@/lib/prisma", () => ({ prisma: prismaProxy(holder) }));

let t: TestDb;
let svc: typeof import("@/services/rate-limit-purge.service");
let rl: typeof import("@/lib/rate-limit");
beforeAll(async () => {
  setTestEnv(); t = await startTestDb(); holder.prisma = t.prisma;
  svc = await import("@/services/rate-limit-purge.service");
  rl = await import("@/lib/rate-limit");
}, 60_000);
afterAll(async () => { await t?.stop(); });
let consoleSpies: ReturnType<typeof vi.spyOn>[];
beforeEach(async () => {
  await t.prisma.$executeRawUnsafe(`DELETE FROM "RateLimit"`);
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
});
afterEach(() => { vi.restoreAllMocks(); });

const insert = (key: string, hoursAgo: number, count = 1) =>
  t.prisma.$executeRawUnsafe(`INSERT INTO "RateLimit" ("key", "count", "windowStart") VALUES ('${key}', ${count}, NOW() - INTERVAL '${hoursAgo} hours')`);
const seedMany = (n: number, hoursAgo: number, prefix = "bulk") =>
  t.prisma.$executeRawUnsafe(`INSERT INTO "RateLimit" ("key", "count", "windowStart") SELECT '${prefix}:' || g, 1, NOW() - INTERVAL '${hoursAgo} hours' FROM generate_series(1, ${n}) g`);
const keys = async () => (await t.prisma.rateLimit.findMany({ select: { key: true }, orderBy: { key: "asc" } })).map((r) => r.key);
const total = () => t.prisma.rateLimit.count();

describe("criterio de antigüedad", () => {
  it("elimina las filas con más de 24 h y conserva las recientes", async () => {
    await insert("viejo:a", 25); await insert("viejo:b", 48); await insert("viejo:c", 24 * 30);
    await insert("reciente:a", 23); await insert("reciente:b", 1); await insert("reciente:c", 0);
    const res = await svc.purgeExpiredRateLimits();
    expect(res).toEqual({ deleted: 3, batches: 1, complete: true });
    expect(await keys()).toEqual(["reciente:a", "reciente:b", "reciente:c"]);
  });
  it("tabla vacía o sin filas caducadas: no borra nada (idempotente)", async () => {
    expect(await svc.purgeExpiredRateLimits()).toEqual({ deleted: 0, batches: 1, complete: true });
    await insert("reciente", 5);
    expect(await svc.purgeExpiredRateLimits()).toEqual({ deleted: 0, batches: 1, complete: true });
    expect(await keys()).toEqual(["reciente"]);
  });
  it("una segunda ejecución tras una purga completa es idempotente y no toca lo que queda", async () => {
    await insert("viejo", 30); await insert("reciente", 2, 7);
    const before = await t.prisma.rateLimit.findUniqueOrThrow({ where: { key: "reciente" } });
    expect((await svc.purgeExpiredRateLimits()).deleted).toBe(1);
    for (let i = 0; i < 3; i++) expect(await svc.purgeExpiredRateLimits()).toEqual({ deleted: 0, batches: 1, complete: true });
    expect(await t.prisma.rateLimit.findUniqueOrThrow({ where: { key: "reciente" } })).toEqual(before);
  });
  it("no acepta configuración desde fuera: retención, lote y lotes ignoran cualquier opción", async () => {
    await insert("dos-horas", 2); await insert("veinticinco-horas", 25);
    const res = await svc.purgeExpiredRateLimits({ retentionHours: 1, batchSize: 1, maxBatches: 1, budgetMs: 1 } as never);
    expect(res).toEqual({ deleted: 1, batches: 1, complete: true });
    expect(await keys()).toEqual(["dos-horas"]);
  });
});

describe("todas las familias de claves: solo se purga lo expirado", () => {
  const HASH = "0123456789abcdef0123456789abcdef";
  const FAMILIES = [
    `login:ana@example.com`, `login-ip-1m:v4:203.0.113.7`, `login-ip-15m:v4:203.0.113.7`, `login-fail-ip:v6:2001:db8:0:0`,
    `register:v4:203.0.113.7`, `forgot:v4:203.0.113.7`, `reset:v4:203.0.113.7`, `verify:v4:203.0.113.7`,
    `register-email:${HASH}`, `forgot-email:${HASH}`,
    "photos:cuid1", "tryon:cuid1", "profile:cuid1", "wardrobe:create:cuid1", "wardrobe:upload:cuid1", "stylist:cuid1", "shopping:cuid1",
    "account-delete:cuid1", "account-export:cuid1", "feedback:cuid1", "weather:cuid1", "geocode:cuid1",
  ];
  it.each(FAMILIES)("%s: expirada se purga y reciente se conserva", async (family) => {
    await insert(`${family}:expirada`.replace(/:expirada$/, ""), 25);
    // misma familia, otra clave con ventana reciente
    const recent = family.startsWith("login:") ? "login:otra@example.com" : `${family}-reciente`;
    await insert(recent, 23);
    const res = await svc.purgeExpiredRateLimits();
    expect(res.deleted).toBe(1);
    expect(await keys()).toEqual([recent]);
  });
  it("todas las familias a la vez: se purgan exactamente las expiradas", async () => {
    for (const f of FAMILIES) { await insert(`${f}-viejo`, 26); await insert(`${f}-nuevo`, 22); }
    const res = await svc.purgeExpiredRateLimits();
    expect(res).toEqual({ deleted: FAMILIES.length, batches: 1, complete: true });
    expect(await keys()).toEqual(FAMILIES.map((f) => `${f}-nuevo`).sort());
  });
  it("una ventana reciente no se elimina nunca por su familia, aunque su contador esté por encima del límite", async () => {
    for (const f of FAMILIES) await insert(`${f}-bloqueada`, 0, 9_999);
    expect(await svc.purgeExpiredRateLimits()).toEqual({ deleted: 0, batches: 1, complete: true });
    expect(await total()).toBe(FAMILIES.length);
  });
});

describe("lotes y presupuesto", () => {
  it("respeta el tamaño de lote (5000): 12 000 filas → 3 lotes", async () => {
    await seedMany(12_000, 30);
    expect(await svc.purgeExpiredRateLimits()).toEqual({ deleted: 12_000, batches: 3, complete: true });
    expect(await total()).toBe(0);
  }, 60_000);
  it("exactamente 5000 filas: un lote lleno y otro vacío que confirma que ha terminado", async () => {
    await seedMany(5_000, 30);
    expect(await svc.purgeExpiredRateLimits()).toEqual({ deleted: 5_000, batches: 2, complete: true });
  }, 60_000);
  it("4999 filas: un único lote (menor que el tamaño) y completa", async () => {
    await seedMany(4_999, 30);
    expect(await svc.purgeExpiredRateLimits()).toEqual({ deleted: 4_999, batches: 1, complete: true });
  }, 60_000);
  it("respeta el máximo de lotes (20): 100 001 filas → 100 000 borradas, complete false; la siguiente ejecución termina", async () => {
    await seedMany(100_001, 30);
    expect(await svc.purgeExpiredRateLimits()).toEqual({ deleted: 100_000, batches: 20, complete: false });
    expect(await total()).toBe(1);
    expect(await svc.purgeExpiredRateLimits()).toEqual({ deleted: 1, batches: 1, complete: true });
    expect(await svc.purgeExpiredRateLimits()).toEqual({ deleted: 0, batches: 1, complete: true });
  }, 180_000);
  it("el presupuesto es efectivo: sin tiempo para otro lote entero (cota de 17 s), se detiene con complete false", async () => {
    await seedMany(12_000, 30);
    // Lecturas del reloj: inicio (0), antes del 1.er lote (0), antes del 2.º (20 s): 20 + 17 > 25 → no empieza.
    const seq = [0, 0, 20_000];
    const res = await svc.purgeExpiredRateLimits({ clock: () => seq.shift() ?? 20_000 });
    expect(res).toEqual({ deleted: 5_000, batches: 1, complete: false });
    expect(await total()).toBe(7_000);
    expect(await svc.purgeExpiredRateLimits()).toEqual({ deleted: 7_000, batches: 2, complete: true }); // continúa al día siguiente
  }, 60_000);
  it("frontera del presupuesto: con 8 s transcurridos aún cabe otro lote (8 + 17 = 25); con 8,001 s no", async () => {
    await seedMany(12_000, 30);
    const fits = await svc.purgeExpiredRateLimits({ clock: (() => { const q = [0, 0, 8_000]; return () => q.shift() ?? 8_000; })() });
    expect(fits.batches).toBeGreaterThanOrEqual(2); // el 2.º lote se inició
    await seedMany(12_000, 30, "otro");
    const stops = await svc.purgeExpiredRateLimits({ clock: (() => { const q = [0, 0, 8_001]; return () => q.shift() ?? 8_001; })() });
    expect(stops).toEqual({ deleted: 5_000, batches: 1, complete: false });
  }, 120_000);
  it("el primer lote siempre cabe en el presupuesto (la purga nunca se queda sin hacer nada por el reloj)", async () => {
    await insert("viejo", 30);
    const res = await svc.purgeExpiredRateLimits({ clock: () => 0 });
    expect(res.batches).toBe(1);
    expect(res.deleted).toBe(1);
  });
  it("cada lote usa statement_timeout y lock_timeout locales y una transacción acotada, y es UNA sola sentencia de borrado", async () => {
    await seedMany(6_000, 30);
    const orig = t.prisma.$transaction.bind(t.prisma);
    const log: { select: string[]; exec: string[]; opts: unknown[] } = { select: [], exec: [], opts: [] };
    vi.spyOn(t.prisma, "$transaction").mockImplementation(((fn: (tx: unknown) => Promise<unknown>, o: unknown) => {
      log.opts.push(o);
      return orig(async (tx) => fn(new Proxy(tx as object, {
        get(target, prop) {
          const v = (target as Record<string | symbol, unknown>)[prop];
          if (prop === "$queryRaw") return (s: TemplateStringsArray | Prisma.Sql, ...a: unknown[]) => { log.select.push(Array.isArray(s) ? `${(s as unknown as string[]).join("?")}|${a.join(",")}` : (s as Prisma.Sql).sql); return (v as (...x: unknown[]) => unknown).call(target, s, ...a); };
          if (prop === "$executeRaw") return (q: Prisma.Sql) => { log.exec.push(q.sql); return (v as (...x: unknown[]) => unknown).call(target, q); };
          return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(target) : v;
        },
      })), o as never);
    }) as never);
    await svc.purgeExpiredRateLimits();
    expect(log.opts).toHaveLength(2);
    for (const o of log.opts) expect(o).toEqual({ maxWait: 2_000, timeout: 8_000 });
    // 2 lotes: cada uno fija sus timeouts locales; solo el último (menor que el tamaño de lote) hace la comprobación de lectura.
    expect(log.select).toHaveLength(3);
    for (const s of log.select.filter((x) => x.includes("set_config"))) { expect(s).toContain("set_config('statement_timeout'"); expect(s).toContain("5000ms"); expect(s).toContain("2000ms"); }
    expect(log.select.filter((x) => x.includes("set_config"))).toHaveLength(2);
    expect(log.exec).toHaveLength(2); // una sentencia de borrado por lote
    for (const sql of log.exec) {
      expect(sql).toMatch(/ORDER BY "windowStart"/); expect(sql).toMatch(/LIMIT \?/); expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/);
      expect(sql).toMatch(/DELETE FROM "RateLimit" r USING doomed d/);
      expect(sql.match(/"windowStart" < NOW\(\) - \(\? \* INTERVAL '1 hour'\)/g)).toHaveLength(2); // la condición va en la selección Y en el DELETE
    }
  }, 60_000);
});

describe("semántica de complete: filas caducadas saltadas por SKIP LOCKED", () => {
  /**
   * PGlite tiene UNA sola conexión: no puede mantener una fila bloqueada por «otra transacción» mientras la purga corre. Aquí
   * se SIMULA el efecto de SKIP LOCKED (la sentencia de borrado deja sin tocar unas claves) y se comprueba la LÓGICA del
   * servicio sobre la comprobación de lectura real. Que PostgreSQL salte de verdad filas bloqueadas y que la comprobación las
   * vea con bloqueos reales entre conexiones queda para la subfase 19.14d (PostgreSQL local).
   */
  const skippingLocked = (lockedPrefix: string) => {
    const orig = t.prisma.$transaction.bind(t.prisma);
    vi.spyOn(t.prisma, "$transaction").mockImplementation(((fn: (tx: unknown) => Promise<unknown>, o: unknown) =>
      orig(async (tx) => fn(new Proxy(tx as object, {
        get(target, prop) {
          const v = (target as Record<string | symbol, unknown>)[prop];
          if (prop === "$executeRaw") {
            // El borrado sustituye la selección por una que SALTA las claves «bloqueadas», como haría SKIP LOCKED.
            return () => (v as (q: Prisma.Sql) => unknown).call(target, svc.purgeBatchSql(Prisma.sql`SELECT "key" FROM "RateLimit"
              WHERE "windowStart" < NOW() - (24 * INTERVAL '1 hour') AND "key" NOT LIKE ${`${lockedPrefix}%`} ORDER BY "windowStart" LIMIT 5000`));
          }
          return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(target) : v;
        },
      })), o as never)) as never);
  };

  it("un lote menor que 5000 con filas caducadas saltadas NO es complete: complete=false y la siguiente ejecución las recoge", async () => {
    for (let i = 0; i < 10; i++) await insert(`libre:${i}`, 30);
    for (let i = 0; i < 5; i++) await insert(`bloqueada:${i}`, 30);
    skippingLocked("bloqueada:");
    const res = await svc.purgeExpiredRateLimits();
    expect(res).toEqual({ deleted: 10, batches: 1, complete: false }); // antes del arreglo: complete true con 5 filas caducadas vivas
    vi.restoreAllMocks();
    expect((await keys()).sort()).toEqual([0, 1, 2, 3, 4].map((i) => `bloqueada:${i}`));
    expect(await svc.purgeExpiredRateLimits()).toEqual({ deleted: 5, batches: 1, complete: true });
  });
  it("si TODAS las caducadas están saltadas: deleted 0 y complete false (no se declara terminado)", async () => {
    for (let i = 0; i < 3; i++) await insert(`bloqueada:${i}`, 30);
    skippingLocked("bloqueada:");
    expect(await svc.purgeExpiredRateLimits()).toEqual({ deleted: 0, batches: 1, complete: false });
    vi.restoreAllMocks();
    expect(await total()).toBe(3);
  });
  it("las filas recientes no cuentan como pendientes: complete true aunque existan filas vivas", async () => {
    await insert("libre", 30); await insert("viva:1", 1); await insert("viva:2", 23);
    expect(await svc.purgeExpiredRateLimits()).toEqual({ deleted: 1, batches: 1, complete: true });
  });
  it("cuando realmente no queda ninguna caducada, complete es true (también con otras filas vivas bloqueables)", async () => {
    for (let i = 0; i < 7; i++) await insert(`libre:${i}`, 30);
    await insert("viva", 2);
    expect(await svc.purgeExpiredRateLimits()).toEqual({ deleted: 7, batches: 1, complete: true });
    expect(await svc.purgeExpiredRateLimits()).toEqual({ deleted: 0, batches: 1, complete: true });
  });
  it("la comprobación es de SOLO LECTURA: SELECT EXISTS sin FOR UPDATE, y no cambia ni bloquea ninguna fila (xmin y xmax intactos)", async () => {
    const sql = svc.expiredRowsRemainSql().sql;
    expect(sql).toMatch(/^SELECT EXISTS \(SELECT 1 FROM "RateLimit" WHERE "windowStart" < NOW\(\) - \(\? \* INTERVAL '1 hour'\)\) AS "pending"$/);
    expect(sql).not.toMatch(/FOR\s+(UPDATE|SHARE|NO KEY)|SKIP LOCKED|DELETE|UPDATE|INSERT/i);
    await insert("caducada:a", 30); await insert("caducada:b", 40); await insert("viva", 1);
    const snap = () => t.prisma.$queryRawUnsafe<{ key: string; xmin: string; xmax: string }[]>(`SELECT "key", xmin::text AS xmin, xmax::text AS xmax FROM "RateLimit" ORDER BY "key"`);
    const before = await snap();
    for (let i = 0; i < 5; i++) expect(await t.prisma.$queryRaw<{ pending: boolean }[]>(svc.expiredRowsRemainSql())).toEqual([{ pending: true }]);
    expect(await snap()).toEqual(before);
    expect(before.every((r) => r.xmax === "0")).toBe(true);
  });
  it("devuelve solo un booleano: ni claves ni recuentos", async () => {
    await insert("login:secreto@example.com", 30);
    const rows = await t.prisma.$queryRaw<Record<string, unknown>[]>(svc.expiredRowsRemainSql());
    expect(rows).toEqual([{ pending: true }]);
  });
  it("la comprobación solo se ejecuta cuando el lote no está lleno (los lotes llenos ya implican «puede haber más»)", async () => {
    await seedMany(12_000, 30);
    const orig = t.prisma.$transaction.bind(t.prisma);
    const selects: string[] = [];
    vi.spyOn(t.prisma, "$transaction").mockImplementation(((fn: (tx: unknown) => Promise<unknown>, o: unknown) =>
      orig(async (tx) => fn(new Proxy(tx as object, {
        get(target, prop) {
          const v = (target as Record<string | symbol, unknown>)[prop];
          if (prop === "$queryRaw") return (q: unknown, ...a: unknown[]) => { selects.push(Array.isArray(q) ? (q as string[]).join("?") : (q as Prisma.Sql).sql); return (v as (...x: unknown[]) => unknown).call(target, q, ...a); };
          return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(target) : v;
        },
      })), o as never)) as never);
    expect(await svc.purgeExpiredRateLimits()).toEqual({ deleted: 12_000, batches: 3, complete: true });
    expect(selects.filter((x) => x.includes("EXISTS"))).toHaveLength(1);   // solo el 3.er lote (2000 filas)
    expect(selects.filter((x) => x.includes("set_config"))).toHaveLength(3);
  }, 60_000);
  it("20 lotes llenos: complete false sin necesidad de comprobar (hay más o no se puede afirmar)", async () => {
    await seedMany(100_000, 30);
    expect(await svc.purgeExpiredRateLimits()).toEqual({ deleted: 100_000, batches: 20, complete: false });
    expect(await svc.purgeExpiredRateLimits()).toEqual({ deleted: 0, batches: 1, complete: true });
  }, 180_000);
});

describe("carrera con rateLimit: la condición repetida en el DELETE", () => {
  it("una fila seleccionada como caducada y refrescada después NO se borra (simulación determinista de la selección vieja)", async () => {
    await insert("refrescada", 0, 1);   // ya refrescada: ventana nueva, contador 1
    await insert("caducada", 30, 4);
    // Selección «vieja»: devuelve las dos claves, como si «refrescada» aún estuviera caducada cuando se seleccionó.
    const stale = Prisma.sql`SELECT "key" FROM "RateLimit" WHERE "key" IN ('refrescada', 'caducada')`;
    const n = await t.prisma.$executeRaw(svc.purgeBatchSql(stale));
    expect(n).toBe(1);
    expect(await keys()).toEqual(["refrescada"]);
    expect((await t.prisma.rateLimit.findUniqueOrThrow({ where: { key: "refrescada" } })).count).toBe(1); // contador intacto
  });
  it("sin la selección vieja (uso normal) el resultado coincide con el criterio de antigüedad", async () => {
    await insert("refrescada", 0); await insert("caducada", 30);
    expect(await t.prisma.$executeRaw(svc.purgeBatchSql())).toBe(1);
    expect(await keys()).toEqual(["refrescada"]);
  });
  it("una fila purgada y vuelta a contar equivale a una fila caducada reiniciada: count = 1 en ambos casos", async () => {
    await insert("a", 30, 50); await insert("b", 30, 50);
    await svc.purgeExpiredRateLimits();
    expect(await keys()).toEqual([]);
    await rl.rateLimit("a", 3, 60);
    expect((await t.prisma.rateLimit.findUniqueOrThrow({ where: { key: "a" } })).count).toBe(1);
    await insert("c", 30, 50); // caducada SIN purgar: el siguiente golpe la reinicia igual
    await rl.rateLimit("c", 3, 60);
    expect((await t.prisma.rateLimit.findUniqueOrThrow({ where: { key: "c" } })).count).toBe(1);
  });
});

describe("el limitador sigue funcionando", () => {
  it("rateLimit cuenta y bloquea con normalidad tras una purga, y una ventana viva no se ve afectada", async () => {
    await rl.rateLimit("t:vivo", 3, 3600); await rl.rateLimit("t:vivo", 3, 3600);
    await insert("t:muerto", 30, 99);
    await svc.purgeExpiredRateLimits();
    await rl.rateLimit("t:vivo", 3, 3600);
    await expect(rl.rateLimit("t:vivo", 3, 3600)).rejects.toMatchObject({ status: 429, code: "RATE_LIMITED" });
    await expect(rl.rateLimit("t:muerto", 3, 3600)).resolves.toBeUndefined();
  });
  it("rateLimitStatus responde igual antes y después de la purga y NO escribe (xmin intacto)", async () => {
    await insert("t:bloqueada", 0, 5);
    await insert("t:vieja", 30, 5);
    expect(await rl.rateLimitStatus("t:bloqueada", 3, 3600)).toBe(true);
    expect(await rl.rateLimitStatus("t:vieja", 3, 3600)).toBe(false); // caducada: false aunque su contador sea alto
    await svc.purgeExpiredRateLimits();
    const snapshot = () => t.prisma.$queryRawUnsafe<{ key: string; count: number; windowStart: Date; xmin: string }[]>(`SELECT "key", "count", "windowStart", xmin::text AS xmin FROM "RateLimit" ORDER BY "key"`);
    const before = await snapshot();
    for (let i = 0; i < 10; i++) { await rl.rateLimitStatus("t:bloqueada", 3, 3600); await rl.rateLimitStatus("t:vieja", 3, 3600); }
    expect(await rl.rateLimitStatus("t:bloqueada", 3, 3600)).toBe(true);
    expect(await rl.rateLimitStatus("t:vieja", 3, 3600)).toBe(false); // purgada: sigue siendo false
    expect(await snapshot()).toEqual(before);
    expect(before.map((r) => r.key)).toEqual(["t:bloqueada"]);
  });
  it("rateLimit y la purga alternados no se interfieren (ráfaga secuencial)", async () => {
    for (let i = 0; i < 5; i++) { await rl.rateLimit("t:alterna", 100, 3600); await svc.purgeExpiredRateLimits(); }
    expect((await t.prisma.rateLimit.findUniqueOrThrow({ where: { key: "t:alterna" } })).count).toBe(5);
  });
});

describe("errores", () => {
  it("una excepción de SQL se propaga tal cual (sin resultado aparentemente satisfactorio)", async () => {
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "RateLimit" RENAME TO "RateLimitX"`);
    try {
      await expect(svc.purgeExpiredRateLimits()).rejects.toThrow();
    } finally { await t.prisma.$executeRawUnsafe(`ALTER TABLE "RateLimitX" RENAME TO "RateLimit"`); }
  });
  it("el lote es atómico: si la transacción falla DESPUÉS del borrado, no se borra ninguna fila", async () => {
    await seedMany(3_000, 30);
    const orig = t.prisma.$transaction.bind(t.prisma);
    vi.spyOn(t.prisma, "$transaction").mockImplementation(((fn: (tx: unknown) => Promise<unknown>, o: unknown) =>
      orig(async (tx) => {
        const out = await fn(tx);
        throw Object.assign(new Error("fallo tras el borrado"), { out }); // la transacción se deshace entera
      }, o as never)) as never);
    await expect(svc.purgeExpiredRateLimits()).rejects.toThrow("fallo tras el borrado");
    vi.restoreAllMocks();
    expect(await total()).toBe(3_000);
  }, 60_000);
  it("si falla el segundo lote, el primero (atómico) queda confirmado completo y el error se propaga", async () => {
    await seedMany(12_000, 30);
    const orig = t.prisma.$transaction.bind(t.prisma);
    let n = 0;
    vi.spyOn(t.prisma, "$transaction").mockImplementation(((fn: unknown, o: unknown) => (++n === 2 ? Promise.reject(new Error("fallo en el 2.º lote")) : orig(fn as never, o as never))) as never);
    await expect(svc.purgeExpiredRateLimits()).rejects.toThrow("fallo en el 2.º lote");
    vi.restoreAllMocks();
    expect(await total()).toBe(7_000); // exactamente un lote completo de 5000 menos, nunca uno a medias
    expect(await svc.purgeExpiredRateLimits()).toEqual({ deleted: 7_000, batches: 2, complete: true }); // y la siguiente ejecución lo termina
  }, 60_000);
  it("no registra nada en consola ni devuelve claves: el resultado solo tiene tres campos numéricos/booleanos", async () => {
    await insert("login:secreto@example.com", 30);
    const res = await svc.purgeExpiredRateLimits();
    expect(Object.keys(res).sort()).toEqual(["batches", "complete", "deleted"]);
    expect(JSON.stringify(res)).not.toContain("secreto");
    expect(consoleSpies.flatMap((s) => s.mock.calls.flat()).map(String).join("")).toBe("");
  });
});
