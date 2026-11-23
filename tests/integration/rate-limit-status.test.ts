import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { startTestDb, type TestDb } from "../helpers/db";
import { prismaProxy, setTestEnv } from "../helpers/mock-prisma";

/**
 * Fase 19.12d — rateLimitStatus: consulta de solo lectura sobre PGlite (SQL real y reloj de PostgreSQL). Se comprueba la
 * semántica frente a `rateLimit` y, de forma explícita, que no escribe: ni filas nuevas, ni cambios de contador, ventana
 * o versión de fila (xmin), ni sentencias distintas de SELECT.
 */
const holder = vi.hoisted(() => ({ prisma: null as PrismaClient | null, sql: [] as string[], other: [] as string[] }));
/** Registra el SQL de $queryRaw y cualquier otro acceso de escritura del cliente que usa el limitador. */
vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy({}, {
    get(_t, prop) {
      const client = holder.prisma as unknown as Record<string | symbol, unknown>;
      const v = client[prop];
      if (prop === "$queryRaw") {
        return (strings: TemplateStringsArray, ...values: unknown[]) => {
          holder.sql.push(strings.join("?"));
          return (v as (...a: unknown[]) => unknown).call(client, strings, ...values);
        };
      }
      if (typeof v === "function") return (...a: unknown[]) => { holder.other.push(String(prop)); return (v as (...x: unknown[]) => unknown).apply(client, a); };
      return v;
    },
  }),
}));

let t: TestDb;
let rl: typeof import("@/lib/rate-limit");
beforeAll(async () => { setTestEnv(); t = await startTestDb(); holder.prisma = t.prisma; rl = await import("@/lib/rate-limit"); }, 60_000);
afterAll(async () => { await t?.stop(); });
beforeEach(async () => { await t.prisma.$executeRawUnsafe(`DELETE FROM "RateLimit"`); holder.sql.length = 0; holder.other.length = 0; });

type Row = { key: string; count: number; windowStart: Date; xmin: string };
const rows = () => t.prisma.$queryRawUnsafe<Row[]>(`SELECT "key", "count", "windowStart", xmin::text AS xmin FROM "RateLimit" ORDER BY "key"`);
const expire = (key: string, secondsAgo: number) => t.prisma.$executeRawUnsafe(`UPDATE "RateLimit" SET "windowStart" = NOW() - INTERVAL '${secondsAgo} seconds' WHERE "key" = '${key}'`);
const seed = (key: string, count: number, secondsAgo = 0) =>
  t.prisma.$executeRawUnsafe(`INSERT INTO "RateLimit" ("key", "count", "windowStart") VALUES ('${key}', ${count}, NOW() - INTERVAL '${secondsAgo} seconds')`);

describe("semántica", () => {
  it("contador inexistente → false y no se crea la fila", async () => {
    expect(await rl.rateLimitStatus("t:nuevo", 3, 60)).toBe(false);
    expect(await rows()).toEqual([]);
  });
  it("dentro de la ventana y por debajo del límite → false", async () => {
    await seed("t:k", 2);
    expect(await rl.rateLimitStatus("t:k", 3, 60)).toBe(false);
  });
  it("exactamente en el límite → true (el siguiente rateLimit lanzaría 429)", async () => {
    await seed("t:k", 3);
    expect(await rl.rateLimitStatus("t:k", 3, 60)).toBe(true);
    await expect(rl.rateLimit("t:k", 3, 60)).rejects.toMatchObject({ status: 429, code: "RATE_LIMITED" });
  });
  it("por encima del límite → true", async () => {
    await seed("t:k", 9);
    expect(await rl.rateLimitStatus("t:k", 3, 60)).toBe(true);
  });
  it("ventana expirada aunque el contador supere el límite → false y la fila queda intacta", async () => {
    await seed("t:k", 50, 120); // 2 minutos, ventana de 60 s
    const before = await rows();
    expect(await rl.rateLimitStatus("t:k", 3, 60)).toBe(false);
    expect(await rows()).toEqual(before); // sin reiniciar la ventana ni el contador
  });
  it("claramente dentro de la ventana (30 s de 60) → true; claramente fuera (90 s de 60) → false", async () => {
    await seed("t:dentro", 5, 30); // márgenes amplios: la prueba no depende de que se ejecute en menos de un segundo
    await seed("t:fuera", 5, 90);
    expect(await rl.rateLimitStatus("t:dentro", 3, 60)).toBe(true);
    expect(await rl.rateLimitStatus("t:fuera", 3, 60)).toBe(false);
  });
  it("coincide con rateLimit en cada paso: tras `limit` intentos → true; antes → false", async () => {
    for (let i = 1; i <= 4; i++) {
      await rl.rateLimit("t:sync", 4, 60);
      expect(await rl.rateLimitStatus("t:sync", 4, 60), `tras ${i} intentos`).toBe(i >= 4);
    }
    await expect(rl.rateLimit("t:sync", 4, 60)).rejects.toMatchObject({ status: 429 });
  });
  it("tras expirar, el siguiente rateLimit abre la ventana nueva y status vuelve a false", async () => {
    await seed("t:k", 3);
    await expire("t:k", 120);
    expect(await rl.rateLimitStatus("t:k", 3, 60)).toBe(false);
    await expect(rl.rateLimit("t:k", 3, 60)).resolves.toBeUndefined();
    expect((await rows())[0]).toMatchObject({ count: 1 });
    expect(await rl.rateLimitStatus("t:k", 3, 60)).toBe(false);
  });
  it("claves independientes y consulta con ventana distinta usa SU ventana", async () => {
    await seed("t:a", 5, 30);
    expect(await rl.rateLimitStatus("t:b", 3, 60)).toBe(false);
    expect(await rl.rateLimitStatus("t:a", 3, 60)).toBe(true);
    expect(await rl.rateLimitStatus("t:a", 3, 10)).toBe(false); // con ventana de 10 s, 30 s ya expiró
  });
  it("límites válidos extremos: 1 (el primer intento ya lo alcanza) y el máximo entero de la columna", async () => {
    await seed("t:uno", 1);
    expect(await rl.rateLimitStatus("t:uno", 1, 60)).toBe(true);
    expect(await rl.rateLimitStatus("t:uno", 2, 60)).toBe(false);
    expect(await rl.rateLimitStatus("t:uno", 2_147_483_647, 2_147_483_647)).toBe(false); // sin error de tipado en la base de datos
    await seed("t:alto", 2_147_483_647);
    expect(await rl.rateLimitStatus("t:alto", 2_147_483_647, 60)).toBe(true);
  });
  it("con parámetros válidos, `false` coincide con «rateLimit no rechaza» y `true` con «rateLimit rechaza»", async () => {
    for (const [count, secondsAgo] of [[0, 10], [1, 10], [2, 10], [3, 10], [4, 10], [3, 120], [9, 120]] as const) {
      await t.prisma.$executeRawUnsafe(`DELETE FROM "RateLimit"`);
      await seed("t:eq", count, secondsAgo);
      const status = await rl.rateLimitStatus("t:eq", 3, 60);
      const rejected = await rl.rateLimit("t:eq", 3, 60).then(() => false, () => true);
      expect(rejected, `count=${count}, hace ${secondsAgo}s`).toBe(status);
    }
  });
});

describe("no escribe nunca", () => {
  it("consultas repetidas no cambian ninguna fila (contador, ventana ni versión xmin)", async () => {
    await seed("t:uno", 3); await seed("t:dos", 1); await seed("t:viejo", 99, 600);
    const before = await rows();
    for (let i = 0; i < 20; i++) {
      await rl.rateLimitStatus("t:uno", 3, 60); await rl.rateLimitStatus("t:dos", 3, 60); await rl.rateLimitStatus("t:viejo", 3, 60); await rl.rateLimitStatus("t:no-existe", 3, 60);
    }
    expect(await rows()).toEqual(before); // incluye xmin: cualquier UPDATE/INSERT lo habría cambiado
  });
  it("la tabla no gana filas por consultar claves inexistentes (ni siquiera con el límite válido más bajo)", async () => {
    for (const k of ["a", "b", "c"]) { await rl.rateLimitStatus(`t:${k}`, 1, 60); await rl.rateLimitStatus(`t:${k}`, 1, 1); }
    expect(await rows()).toEqual([]);
  });
  it("ejecuta una única sentencia SELECT: sin INSERT/UPDATE/DELETE, sin FOR UPDATE, sin otras llamadas del cliente", async () => {
    await seed("t:k", 2);
    holder.sql.length = 0; holder.other.length = 0;
    await rl.rateLimitStatus("t:k", 3, 60);
    expect(holder.sql).toHaveLength(1);
    expect(holder.sql[0]).toMatch(/^\s*SELECT\b/i);
    expect(holder.sql[0]).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|FOR\s+UPDATE|FOR\s+SHARE|ON\s+CONFLICT)\b/i);
    expect(holder.other).toEqual([]); // ni $executeRaw, ni $transaction, ni accesos a modelos
  });
  it("no llama a rateLimit (que sí escribe): el INSERT de rateLimit no aparece", async () => {
    holder.sql.length = 0;
    await rl.rateLimitStatus("t:x", 3, 60);
    expect(holder.sql.join("\n")).not.toMatch(/INSERT INTO "RateLimit"/);
    expect(await rows()).toEqual([]);
  });
});

describe("parámetros inválidos: error antes de consultar, nunca false", () => {
  const BAD: [string, unknown][] = [
    ["0", 0], ["negativo", -1], ["negativo grande", -1000], ["decimal", 2.5], ["decimal pequeño", 0.5], ["NaN", Number.NaN], ["Infinity", Infinity], ["-Infinity", -Infinity],
    ["por encima del entero de la columna", 2_147_483_648], ["número seguro enorme", Number.MAX_SAFE_INTEGER], ["texto numérico", "3"], ["null", null], ["undefined", undefined], ["bigint", 3n], ["objeto", {}], ["booleano", true],
  ];
  const noQueryNoWrite = async () => {
    expect(holder.sql).toEqual([]);   // ninguna consulta
    expect(holder.other).toEqual([]); // ningún otro acceso del cliente
    expect(await rows()).toEqual([]); // y la tabla sigue vacía
  };
  it.each(BAD)("limit %s → TypeError sin tocar la base de datos", async (_n, limit) => {
    await expect(rl.rateLimitStatus("t:k", limit as number, 60)).rejects.toThrow(TypeError);
    await noQueryNoWrite();
  });
  it.each(BAD)("windowSec %s → TypeError sin tocar la base de datos", async (_n, windowSec) => {
    await expect(rl.rateLimitStatus("t:k", 3, windowSec as number)).rejects.toThrow(TypeError);
    await noQueryNoWrite();
  });
  it("también con una fila que ya superaría el límite: lanza, no devuelve false (ni true)", async () => {
    await seed("t:k", 99);
    holder.sql.length = 0; holder.other.length = 0;
    const before = await rows();
    await expect(rl.rateLimitStatus("t:k", 0, 60)).rejects.toThrow(TypeError);
    await expect(rl.rateLimitStatus("t:k", 3, 0)).rejects.toThrow(TypeError);
    expect(holder.sql).toEqual([]);
    expect(await rows()).toEqual(before);
  });
  it("los mensajes nombran el parámetro y no incluyen la clave", async () => {
    await expect(rl.rateLimitStatus("login:secreto@x.com", 0, 60)).rejects.toThrow(/`limit`/);
    await expect(rl.rateLimitStatus("login:secreto@x.com", 3, 0)).rejects.toThrow(/`windowSec`/);
    await expect(rl.rateLimitStatus("login:secreto@x.com", 0, 60)).rejects.not.toThrow(/secreto/);
  });
  it("rateLimit() no cambia: sigue aceptando los mismos parámetros que antes", async () => {
    await expect(rl.rateLimit("t:legado", 3, 60)).resolves.toBeUndefined();
    await expect(rl.rateLimit("t:legado-2", 0, 60)).rejects.toMatchObject({ status: 429 }); // límite 0 rechaza siempre (comportamiento previo)
  });
});

describe("errores de base de datos", () => {
  it("se propagan tal cual (sin fallback a «no bloqueado»)", async () => {
    const real = holder.prisma;
    const failing = { $queryRaw: () => { throw Object.assign(new Error("db caída"), { code: "P1001" }); } } as unknown as PrismaClient;
    holder.prisma = failing;
    try {
      await expect(rl.rateLimitStatus("t:k", 3, 60)).rejects.toMatchObject({ code: "P1001" });
    } finally { holder.prisma = real; }
  });
  it("un rechazo asíncrono también se propaga", async () => {
    const real = holder.prisma;
    holder.prisma = { $queryRaw: () => Promise.reject(new Error("timeout")) } as unknown as PrismaClient;
    try { await expect(rl.rateLimitStatus("t:k", 3, 60)).rejects.toThrow("timeout"); } finally { holder.prisma = real; }
  });
});
