import { beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { setTestEnv } from "../helpers/mock-prisma";

/**
 * Fase 19.8a — retención DRY_RUN (unitario): límites puros, lotes, presupuesto, errores y SQL generado (capturado con
 * una transacción simulada). Sin base de datos: la semántica del SQL se prueba en PGlite y PostgreSQL real.
 */
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

type Mod = typeof import("@/services/media-retention.service");
let m: Mod; let MediaLeaseError: typeof import("@/services/media-lease.service").MediaLeaseError;
beforeAll(async () => {
  setTestEnv();
  m = await import("@/services/media-retention.service");
  MediaLeaseError = (await import("@/services/media-lease.service")).MediaLeaseError;
});

const D = 86_400_000; const H = 3_600_000;
const LEASE = { runId: "run-1", fencingToken: 7, leaseExpiresAt: new Date(), startedAt: new Date() };

describe("límites puros", () => {
  it("MediaAsset con graceHours 24: 30 d, 14 d (suelo sobre los 7 d de C1), 30 d y 180 d", () => {
    expect(m.assetRetentionMs("CLEARED", false, 24, 24)).toBe(30 * D);
    expect(m.assetRetentionMs("CLEARED", true, 24, 24)).toBe(14 * D);
    expect(m.assetRetentionMs("CANDIDATE", true, 24, 24)).toBe(30 * D);
    expect(m.assetRetentionMs("CONFIRMED", true, 24, 24)).toBe(30 * D);
    expect(m.assetRetentionMs("CANDIDATE", false, 24, 24)).toBe(180 * D);
    expect(m.assetRetentionMs("CONFIRMED", false, 24, 24)).toBe(180 * D);
  });
  it("suelo = max(14 d, 7 × max(GRACE_HOURS actual, graceHours de la última ejecución)) (C4)", () => {
    expect(m.assetFloorMs(24, 24)).toBe(14 * D);
    expect(m.assetFloorMs(24, 72)).toBe(21 * D); // manda la ejecución
    expect(m.assetFloorMs(96, 24)).toBe(28 * D); // manda el actual
    expect(m.assetRetentionMs("CLEARED", true, 24, 72)).toBe(21 * D);
    expect(m.assetRetentionMs("CLEARED", false, 24, 72)).toBe(30 * D); // 30 > 21
    expect(m.assetRetentionMs("CANDIDATE", false, 1000, 24)).toBe(7000 * H); // el suelo supera incluso los 180 d
  });
  it("allowlist: cualquier otro estado nunca es eliminable", () => {
    for (const s of ["ARCHIVED", "RUNNING", "", "cleared"]) expect(m.assetRetentionMs(s, false, 24, 24)).toBeNull();
    expect([...m.DELETABLE_ASSET_STATES]).toEqual(["CLEARED", "CANDIDATE", "CONFIRMED"]);
    expect([...m.DELETABLE_RUN_STATUSES]).toEqual(["COMPLETED", "INCOMPLETE", "FAILED", "ABANDONED"]);
  });
  it("MediaReconcileRun: 90 d COMPLETED, 30 d el resto; RUNNING y desconocidos nunca; sin suelo de gracia (C5); conservar 14", () => {
    expect(m.runRetentionMs("COMPLETED")).toBe(90 * D);
    for (const s of ["INCOMPLETE", "FAILED", "ABANDONED"]) expect(m.runRetentionMs(s)).toBe(30 * D);
    for (const s of ["RUNNING", "X"]) expect(m.runRetentionMs(s)).toBeNull();
    expect(m.runRetentionMs.length).toBe(1); // no recibe graceHours
    expect(m.RUN_KEEP_PER_STATUS).toBe(14);
  });
  it("cotas de lote: 2 s + 8 s + 2 s = 12 s; 200 filas, 10 lotes; lock_timeout 2 s, statement_timeout 5 s; modo DRY_RUN", () => {
    expect(m.RETENTION_BATCH_MAX_MS).toBe(12_000);
    expect([m.RETENTION_BATCH_SIZE, m.RETENTION_MAX_BATCHES]).toEqual([200, 10]);
    expect([m.RETENTION_LOCK_TIMEOUT_MS, m.RETENTION_STATEMENT_TIMEOUT_MS]).toEqual([2_000, 5_000]);
    expect(m.RETENTION_MODE).toBe("DRY_RUN");
  });
});

/** Lease simulado: ejecuta la operación con un tx que captura el SQL y devuelve filas guionizadas. */
function harness(o: { assets?: unknown[][]; runs?: unknown[][]; outcomes?: (unknown | ((i: number) => unknown))[]; msPerBatch?: number } = {}) {
  let now = 0;
  const sql: { text: string; values: unknown[] }[] = [];
  const opts: unknown[] = [];
  const assets = [...(o.assets ?? [[]])]; const runs = [...(o.runs ?? [[]])];
  let calls = 0;
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = Prisma.sql(strings as unknown as string[], ...(values as never[]));
      sql.push({ text: q.sql, values: q.values });
      if (q.sql.includes("set_config")) return [];
      if (q.sql.includes(`FROM "MediaAsset" a JOIN`)) return assets.length > 1 ? assets.shift() : assets[0];
      return runs.length > 1 ? runs.shift() : runs[0];
    },
  };
  const lease = {
    withLease: vi.fn(async (l: unknown, fn: (t: unknown) => Promise<unknown>, op: unknown) => {
      const i = calls++;
      opts.push(op);
      now += o.msPerBatch ?? 100;
      const scripted = o.outcomes?.[i];
      if (typeof scripted === "function") return scripted(i);
      if (scripted instanceof Error) throw scripted;
      if (scripted) return scripted;
      return { ok: true, value: await fn(tx), leaseExpiresAt: new Date() };
    }),
  };
  const svc = m.createMediaRetention({ lease: lease as never });
  const run = (budgetMs = 20_000) => svc.run(LEASE, { budgetMs, ttlMs: 360_000, graceHours: 24, clock: () => now });
  return { run, sql, opts, lease };
}
const arows = (n: number, rule = "CLEARED", offset = 0) =>
  Array.from({ length: n }, (_, i) => ({ delivery: "UPLOAD", publicId: `ai-wardrobe/u/wardrobe/p${String(i + offset).padStart(5, "0")}`, rule }));
const rrows = (n: number, status = "COMPLETED", offset = 0) => Array.from({ length: n }, (_, i) => ({ fencingToken: i + 1 + offset, status }));

describe("servicio DRY_RUN", () => {
  it("cada lote: withLease con TTL, lock_timeout 2 s, maxWait 2 s, timeout 8 s; statement_timeout 5 s; SKIP LOCKED; NINGUNA escritura", async () => {
    const h = harness({ assets: [[...arows(2), ...arows(1, "ACTIVE_OWNER_MISSING", 10)]], runs: [[...rrows(1), ...rrows(2, "ABANDONED", 5)]] });
    const r = await h.run();
    expect(r).toMatchObject({
      mode: "DRY_RUN", status: "DONE", errorCodes: [],
      assets: { eligible: 3, batches: 1, complete: true, byRule: { CLEARED: 2, ACTIVE_OWNER_MISSING: 1, CLEARED_OWNER_MISSING: 0, ACTIVE: 0 } },
      runs: { eligible: 3, batches: 1, complete: true, byStatus: { COMPLETED: 1, ABANDONED: 2, INCOMPLETE: 0, FAILED: 0 } },
    });
    for (const op of h.opts) expect(op).toEqual({ ttlMs: 360_000, lockTimeoutMs: 2_000, maxWaitMs: 2_000, timeoutMs: 8_000 });
    expect(h.sql.filter((q) => q.text.includes("set_config('statement_timeout'"))).toHaveLength(2);
    expect(h.sql.filter((q) => q.text.includes("set_config")).every((q) => q.values.includes("5000ms"))).toBe(true);
    const selects = h.sql.filter((q) => !q.text.includes("set_config"));
    expect(selects[0]!.text).toMatch(/FOR UPDATE OF a SKIP LOCKED/);
    expect(selects[0]!.text).toMatch(/ORDER BY a\."delivery", a\."publicId" COLLATE "C"/);
    expect(selects[0]!.text).toMatch(/a\."lastCandidateAt" </);
    expect(selects[0]!.text).not.toMatch(/updatedAt/);
    expect(selects[1]!.text).toMatch(/FOR UPDATE OF r SKIP LOCKED/);
    expect(selects[1]!.text).toMatch(/ORDER BY "fencingToken" DESC/);
    for (const q of h.sql) expect(q.text).not.toMatch(/\b(DELETE|UPDATE\s+"|INSERT|TRUNCATE|MERGE)\b/i);
  });

  it("M1/M2: estados desconocidos con DOS barreras (allowlist del enum e IS NOT NULL) y filtro previo indexable de 14 días", async () => {
    const h = harness();
    await h.run();
    const q = h.sql.find((x) => x.text.includes(`FROM "MediaAsset" a JOIN`))!;
    // 1. Allowlist explícita con los valores del enum (sin convertir la columna a texto: el índice sigue siendo usable).
    expect(q.text).toMatch(/a\."state" IN \([^,()]+::"MediaAssetState",\s*[^,()]+::"MediaAssetState",\s*[^,()]+::"MediaAssetState"\)/);
    expect(q.text).not.toMatch(/"state"::text/);
    expect(q.values.filter((v) => typeof v === "string" && ["CLEARED", "CANDIDATE", "CONFIRMED"].includes(v)).sort())
      .toEqual(["CANDIDATE", "CLEARED", "CONFIRMED"]);
    // 2. Protección NULL explícita sobre la regla (GREATEST ignora los NULL).
    expect(q.text).toMatch(/\(CASE[\s\S]+?END\) IS NOT NULL/);
    // Filtro previo indexable (14 días) y un único instante por sentencia para ambos.
    expect(q.text).toMatch(/WITH t AS \(SELECT \(clock_timestamp\(\) AT TIME ZONE 'UTC'\) AS "now"\)/);
    expect(q.text).toMatch(/a\."lastCandidateAt" < \(SELECT "now" FROM t\) - \(\S+::float8 \* interval '1 millisecond'\)\s+AND \(CASE/);
    expect(q.values).toContain(m.ASSET_FLOOR_MIN_MS);
    expect(q.text.match(/clock_timestamp\(\)/g)).toHaveLength(1);
  });

  it("paginación: 200 + 200 + 50 → 3 lotes con cursor (delivery, publicId) sobre la última fila", async () => {
    const h = harness({ assets: [arows(200), arows(200, "CLEARED", 200), arows(50, "CLEARED", 400)] });
    const r = await h.run();
    expect(r.assets).toMatchObject({ eligible: 450, batches: 3, complete: true });
    const selects = h.sql.filter((q) => q.text.includes(`FROM "MediaAsset" a JOIN`));
    expect(selects[0]!.text).not.toMatch(/> \(/);
    expect(selects[1]!.values).toContain(arows(200)[199]!.publicId);
    expect(selects[2]!.values).toContain(arows(200, "CLEARED", 200)[199]!.publicId);
  });

  it("como máximo 10 lotes por fase (2000 filas) → PARTIAL; la fase de ejecuciones se hace igualmente", async () => {
    const h = harness({ assets: [arows(200)], runs: [rrows(3)] });
    const r = await h.run(1_000_000);
    expect(r).toMatchObject({ status: "PARTIAL", assets: { eligible: 2000, batches: 10, complete: false }, runs: { eligible: 3, batches: 1, complete: true } });
  });

  it("presupuesto: un lote solo empieza si cabe entero (12 s); < 12 s → SKIPPED sin ninguna transacción", async () => {
    const skip = harness();
    expect(await skip.run(11_999)).toMatchObject({ status: "SKIPPED", assets: { batches: 0 }, runs: { batches: 0 } });
    expect(skip.lease.withLease).not.toHaveBeenCalled();
    const one = harness({ assets: [arows(200)], msPerBatch: 12_000 });
    expect(await one.run(20_000)).toMatchObject({ status: "PARTIAL", assets: { batches: 1, eligible: 200 }, runs: { batches: 0 } });
    expect(one.lease.withLease).toHaveBeenCalledTimes(1);
    const exact = harness({ msPerBatch: 12_000 });
    expect(await exact.run(12_000)).toMatchObject({ status: "PARTIAL", assets: { batches: 1, complete: true }, runs: { batches: 0 } });
  });

  it("LEASE_LOST entre lotes → se detiene sin más transacciones", async () => {
    const h = harness({ assets: [arows(200)], outcomes: [undefined, { ok: false, reason: "LEASE_LOST" }] });
    const r = await h.run();
    expect(r).toMatchObject({ status: "LEASE_LOST", errorCodes: ["retention/LEASE_LOST"], assets: { batches: 1, eligible: 200 } });
    expect(h.lease.withLease).toHaveBeenCalledTimes(2);
  });

  it("LOCK_TIMEOUT esperando la fila del lock → STOPPED retention/LOCK_TIMEOUT, sin reintento", async () => {
    const h = harness({ outcomes: [{ ok: false, reason: "LOCK_TIMEOUT" }] });
    expect(await h.run()).toMatchObject({ status: "STOPPED", errorCodes: ["retention/LOCK_TIMEOUT"] });
    expect(h.lease.withLease).toHaveBeenCalledTimes(1);
  });

  const pg = (code: string) => Object.assign(new Error(`fallo con ai-wardrobe/secreto`), {
    name: "PrismaClientKnownRequestError", code: "P2010", meta: { driverAdapterError: { cause: { kind: "postgres", originalCode: code } } },
  });
  it.each([
    ["interbloqueo 40P01", () => pg("40P01"), "retention/DEADLOCK"],
    ["lock_timeout 55P03", () => pg("55P03"), "retention/LOCK_TIMEOUT"],
    ["statement_timeout 57014", () => pg("57014"), "retention/QUERY_TIMEOUT"],
    ["clave foránea 23503", () => pg("23503"), "retention/FK_VIOLATION"],
    ["transacción de Prisma P2028", () => Object.assign(new Error("x"), { name: "PrismaClientKnownRequestError", code: "P2028" }), "retention/TX_TIMEOUT"],
    ["lock_timeout dentro de withLease", () => new MediaLeaseError("LOCK_TIMEOUT"), "retention/LOCK_TIMEOUT"],
    ["otro error de base de datos", () => Object.assign(new Error("x"), { name: "PrismaClientKnownRequestError", code: "P2010" }), "retention/DB_ERROR"],
    ["error inesperado", () => new Error("ai-wardrobe/u/wardrobe/secreto"), "retention/INTERNAL"],
  ])("%s → STOPPED con código genérico, un solo intento (sin reintentos)", async (_n, err, code) => {
    const h = harness({ outcomes: [err()] });
    const r = await h.run();
    expect(r).toMatchObject({ status: "STOPPED", errorCodes: [code] });
    expect(JSON.stringify(r)).not.toMatch(/secreto|ai-wardrobe/);
    expect(h.lease.withLease).toHaveBeenCalledTimes(1);
  });
});
