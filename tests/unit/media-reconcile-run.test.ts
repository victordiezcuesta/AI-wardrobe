import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setTestEnv } from "../helpers/mock-prisma";

/**
 * Fase 19.7 — orquestador (unitario): lease, detector y persistencia simulados. Comprueba el flujo, los cierres, los
 * reintentos acotados, la normalización de códigos y que nada sensible sale en el resultado ni en los logs.
 */
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

type Mod = typeof import("@/services/media-reconcile-run.service");
type Asset = typeof import("@/services/media-asset.service");
type LeaseMod = typeof import("@/services/media-lease.service");
let m: Mod; let asset: Asset; let leaseMod: LeaseMod;
beforeAll(async () => {
  setTestEnv();
  m = await import("@/services/media-reconcile-run.service");
  asset = await import("@/services/media-asset.service");
  leaseMod = await import("@/services/media-lease.service");
});

/** Datos que NUNCA pueden salir en el resultado ni en los logs. */
const SECRET_PUBLIC_ID = "ai-wardrobe/user-secret-42/wardrobe/foto-privada";
const SECRET = /user-secret-42|foto-privada|ai-wardrobe\/|asset-secreto|https?:\/\/|run-secreto|987654/;
const STARTED_AT = new Date("2026-11-20T10:00:00.123Z");
const LEASE = { runId: "run-secreto", fencingToken: 987654, leaseExpiresAt: new Date("2026-11-20T10:06:00.123Z"), startedAt: STARTED_AT };

function report(over: Record<string, unknown> = {}) {
  return {
    startedAt: STARTED_AT.toISOString(), durationMs: 1, complete: true, inventoryStatus: "COMPLETE", inventoryComplete: { upload: true, authenticated: true },
    graceHours: 24, pages: { upload: 1, authenticated: 1 }, resourcesExamined: 1,
    byKind: { wardrobe: 1, personal: 0, tryOn: 0, unknown: 0, quarantine: 0 },
    byCategory: { REFERENCED: 0, ORPHAN_CANDIDATE: 1, TOO_RECENT: 0, UNKNOWN: 0, INCOMPLETE: 0, QUARANTINED: 0 },
    candidatesWithheld: 0, orphanDetail: { ownerMissing: 0, personalCitedOnlyBySourcePhoto: 0 },
    protection: { referencedByUrlOnly: 0, ambiguousUrl: 0, missingMetadata: 0 }, quarantine: { wardrobe: 0, personal: 0, tryOn: 0, publicDelivery: 0 },
    metadata: { assetId: 1, version: 1, createdAt: 1, bytes: 1, format: 1 }, urlReferences: null,
    brokenReferences: { total: 0, wardrobe: 0, personal: 0, tryOn: 0 }, referencesOutsidePrefix: 0, rateLimit: null, errors: [],
    ...over,
  } as never;
}
const candidate = { publicId: SECRET_PUBLIC_ID, delivery: "upload", kind: "wardrobe", ownerUserId: "user-secret-42", ownerMissing: false,
  assetId: "asset-secreto", version: 1, bytes: 1, format: "jpg", resourceCreatedAt: new Date("2026-01-01T00:00:00Z") } as const;
const RETENTION_DONE = {
  mode: "DRY_RUN", status: "DONE", errorCodes: [] as string[],
  assets: { eligible: 3, batches: 1, complete: true, byRule: { CLEARED: 3, CLEARED_OWNER_MISSING: 0, ACTIVE_OWNER_MISSING: 0, ACTIVE: 0 } },
  runs: { eligible: 1, batches: 1, complete: true, byStatus: { COMPLETED: 1, INCOMPLETE: 0, FAILED: 0, ABANDONED: 0 } },
};
const SUMMARY = { created: 1, reset: 0, observed: 0, confirmed: 0, unchanged: 0, cleared: 0, ownerMissing: 0, skippedOwnerDeleted: 0 };

function setup(over: { detection?: unknown; finish?: unknown[]; release?: unknown[]; acquire?: unknown; detectError?: unknown; clock?: () => number; retention?: unknown } = {}) {
  const tx = { marker: "tx" };
  const finishQueue = [...(over.finish ?? [{ ok: true, value: SUMMARY, finishedAt: new Date() }])];
  const releaseQueue = [...(over.release ?? [{ released: true, runFinalized: true }])];
  const calls = { detect: [] as unknown[], persist: [] as unknown[], finish: [] as unknown[][], release: [] as unknown[][], acquire: [] as unknown[] };
  const next = (q: unknown[]) => { const v = q.length > 1 ? q.shift() : q[0]; if (v instanceof Error) throw v; return v; };
  const deps = {
    lease: {
      acquire: vi.fn(async (opts: unknown) => { calls.acquire.push(opts); return (over.acquire ?? { status: "ACQUIRED", lease: LEASE, abandoned: 0 }) as never; }),
      finishWith: vi.fn(async (...args: unknown[]) => {
        calls.finish.push(args);
        const v = next(finishQueue) as { ok?: boolean; run?: boolean } | undefined;
        if (v && v.ok) return { ...v, value: await (args[2] as (t: unknown) => Promise<unknown>)(tx) } as never; // ejecuta persist dentro
        return v as never;
      }),
      release: vi.fn(async (...args: unknown[]) => { calls.release.push(args); return next(releaseQueue) as never; }),
    },
    detect: vi.fn(async (opts: unknown) => {
      calls.detect.push(opts);
      if (over.detectError) throw over.detectError;
      return (over.detection ?? { report: report(), candidates: [candidate] }) as never;
    }),
    persist: vi.fn(async (t: unknown, input: unknown) => { calls.persist.push({ t, input }); return SUMMARY; }) as never,
    clock: over.clock,
    retention: over.retention as never,
  };
  return { runner: m.createMediaReconcileRunner(deps as never), deps, calls, tx };
}

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined); });
afterEach(() => { errSpy.mockRestore(); vi.useRealTimers(); });
const logged = () => (errSpy.mock.calls as unknown[][]).flat().map(String).join("\n");
/** Ni el resultado ni los logs contienen identificadores, URLs, runId ni fencingToken. */
function expectNoSecrets(result: unknown) {
  expect(JSON.stringify(result)).not.toMatch(SECRET);
  expect(logged()).not.toMatch(SECRET);
}

describe("lease ocupado", () => {
  it.each(["LEASE_HELD", "LOCK_TIMEOUT"] as const)("BUSY (%s): ni detección, ni persistencia, ni cierre", async (reason) => {
    const { runner, deps } = setup({ acquire: { status: "BUSY", reason } });
    expect(await runner.run()).toEqual({ outcome: "BUSY", reason });
    expect(deps.detect).not.toHaveBeenCalled();
    expect(deps.lease.finishWith).not.toHaveBeenCalled();
    expect(deps.lease.release).not.toHaveBeenCalled();
  });
});

describe("flujo completo", () => {
  it("el detector recibe EXACTAMENTE lease.startedAt (no Date.now) y la persistencia el mismo instante, runId y detección", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2031-05-05T00:00:00Z")); // el reloj de Node no se parece en nada al de PostgreSQL
    const { runner, calls, tx, deps } = setup();
    const r = await runner.run();
    expect(r).toMatchObject({ outcome: "COMPLETED", finalized: true, persisted: SUMMARY, errorCodes: [] });
    const d = calls.detect[0] as { now: Date; graceMs: number; budgetMs: number; queryBudgetMs: number };
    expect(d.now).toBe(STARTED_AT);
    expect(d).toEqual({ now: STARTED_AT, graceMs: m.GRACE_MS, budgetMs: m.INVENTORY_BUDGET_MS, queryBudgetMs: m.QUERY_BUDGET_MS });
    expect(calls.acquire[0]).toMatchObject({ graceHours: m.GRACE_HOURS, ttlMs: 360_000 });
    const p = calls.persist[0] as { t: unknown; input: { runId: string; startedAt: Date; detection: { candidates: unknown[] } } };
    expect(p.t).toBe(tx); // dentro de la transacción de finishWith
    expect(p.input.startedAt).toBe(STARTED_AT);
    expect(p.input.runId).toBe(LEASE.runId);
    expect(calls.finish[0]![0]).toBe(LEASE);
    expect(calls.finish[0]![1]).toMatchObject({ errorCodes: [] });
    expect(deps.lease.release).not.toHaveBeenCalled(); // finishWith ya cierra y libera
    expectNoSecrets(r);
  });
});

describe("detección incompleta o fallida: nunca se persiste", () => {
  it.each([
    ["inventario incompleto", { complete: false, inventoryStatus: "INCOMPLETE", errors: [{ stage: "inventory", scope: "upload", code: "TIME_BUDGET" }] }, false, ["inventory/upload/TIME_BUDGET"]],
    ["inventario completo, consulta de PostgreSQL agotada", { complete: false, errors: [{ stage: "database", scope: "owners", code: "QUERY_TIMEOUT" }] }, true, ["database/owners/QUERY_TIMEOUT"]],
    ["incompleta sin errores (defensivo)", { complete: false, inventoryStatus: "INCOMPLETE" }, false, ["detect/INCOMPLETE"]],
  ])("%s → release INCOMPLETE, sin finishWith ni persist", async (_n, over, inventoryComplete, codes) => {
    const { runner, deps, calls } = setup({ detection: { report: report(over), candidates: [] } });
    const r = await runner.run();
    expect(r).toMatchObject({ outcome: "INCOMPLETE", finalized: true, persisted: null, errorCodes: codes });
    expect(deps.lease.finishWith).not.toHaveBeenCalled();
    expect(deps.persist).not.toHaveBeenCalled();
    expect(calls.release[0]![1]).toMatchObject({ status: "INCOMPLETE", inventoryComplete, errorCodes: codes });
    expectNoSecrets(r);
  });

  it("el detector lanza (mensaje con datos internos) → FAILED detect/INTERNAL, sin el mensaje", async () => {
    const { runner, deps, calls } = setup({ detectError: new Error(`fallo con ${SECRET_PUBLIC_ID} https://res.cloudinary.com/x`) });
    const r = await runner.run();
    expect(r).toEqual({ outcome: "FAILED", finalized: true, report: null, persisted: null, errorCodes: ["detect/INTERNAL"], retention: null });
    expect(calls.release[0]![1]).toMatchObject({ status: "FAILED", inventoryComplete: false, errorCodes: ["detect/INTERNAL"] });
    expect(deps.persist).not.toHaveBeenCalled();
    expectNoSecrets(r);
  });

  it("más de 10.000 candidatas → FAILED persist/TOO_MANY_CANDIDATES sin abrir la transacción", async () => {
    const many = Array.from({ length: asset.MAX_CANDIDATES + 1 }, () => candidate);
    const { runner, deps, calls } = setup({ detection: { report: report(), candidates: many } });
    const r = await runner.run();
    expect(r).toMatchObject({ outcome: "FAILED", finalized: true, errorCodes: ["persist/TOO_MANY_CANDIDATES"] });
    expect(deps.lease.finishWith).not.toHaveBeenCalled();
    expect(calls.release[0]![1]).toMatchObject({ status: "FAILED", inventoryComplete: true });
    expectNoSecrets(r);
  });
});

describe("finishWith: lease, timeouts y fallos de persistencia", () => {
  it("LEASE_LOST → nada persistido; se intenta cerrar FAILED (lease/LEASE_LOST)", async () => {
    const { runner, calls } = setup({ finish: [{ ok: false, reason: "LEASE_LOST" }] });
    const r = await runner.run();
    expect(r).toMatchObject({ outcome: "LEASE_LOST", finalized: true, persisted: null, errorCodes: ["lease/LEASE_LOST"] });
    expect(calls.persist).toEqual([]);
    expect(calls.release[0]![1]).toMatchObject({ status: "FAILED", inventoryComplete: true, errorCodes: ["lease/LEASE_LOST"] });
  });

  it("LEASE_LOST y release también LEASE_LOST (otra ejecución tiene el lock) → finalized false, sin reintento", async () => {
    const { runner, calls } = setup({ finish: [{ ok: false, reason: "LEASE_LOST" }], release: [{ released: false, reason: "LEASE_LOST" }] });
    expect(await runner.run()).toMatchObject({ outcome: "LEASE_LOST", finalized: false });
    expect(calls.release).toHaveLength(1);
  });

  it("LOCK_TIMEOUT una vez → un único reintento que completa", async () => {
    const { runner, calls } = setup({ finish: [{ ok: false, reason: "LOCK_TIMEOUT" }, { ok: true, value: null, finishedAt: new Date() }] });
    expect(await runner.run()).toMatchObject({ outcome: "COMPLETED", finalized: true });
    expect(calls.finish).toHaveLength(2);
    expect(calls.persist).toHaveLength(1);
  });

  it("LOCK_TIMEOUT dos veces → FAILED lease/LOCK_TIMEOUT tras un solo reintento", async () => {
    const { runner, calls } = setup({ finish: [{ ok: false, reason: "LOCK_TIMEOUT" }] });
    expect(await runner.run()).toMatchObject({ outcome: "FAILED", errorCodes: ["lease/LOCK_TIMEOUT"], finalized: true });
    expect(calls.finish).toHaveLength(2);
    expect(calls.persist).toEqual([]);
  });

  it.each([
    ["error de la persistencia", () => new asset.MediaAssetError("STALE_RUN"), "persist/STALE_RUN"],
    ["timeout de bloqueo dentro de la transacción", () => new leaseMod.MediaLeaseError("LOCK_TIMEOUT"), "lease/LOCK_TIMEOUT"],
    ["error de Prisma que repite argumentos", () => Object.assign(new Error(`Invalid query: ${SECRET_PUBLIC_ID}`), { name: "PrismaClientKnownRequestError", code: "P2010" }), "db/P2010"],
    ["error de Prisma sin código", () => Object.assign(new Error(`argumento ${SECRET_PUBLIC_ID}`), { name: "PrismaClientValidationError" }), "db/DB_ERROR"],
    ["error inesperado", () => new Error(`algo con ${SECRET_PUBLIC_ID}`), "persist/INTERNAL"],
  ])("finishWith lanza (%s) → transacción deshecha; release FAILED con código genérico", async (_n, err, code) => {
    const { runner, calls } = setup({ finish: [err()] });
    const r = await runner.run();
    expect(r).toMatchObject({ outcome: "FAILED", finalized: true, persisted: null, errorCodes: [code] });
    expect(calls.release[0]![1]).toMatchObject({ status: "FAILED", inventoryComplete: true, errorCodes: [code] });
    expectNoSecrets(r);
  });
});

describe("release: un único reintento acotado", () => {
  const incomplete = { detection: { report: report({ complete: false, inventoryStatus: "INCOMPLETE", errors: [{ stage: "inventory", scope: "upload", code: "X" }] }), candidates: [] } };
  it("lanza y luego cierra → finalized true con 2 llamadas", async () => {
    const { runner, calls } = setup({ ...incomplete, release: [new Error(`db ${SECRET_PUBLIC_ID}`), { released: true, runFinalized: true }] });
    const r = await runner.run();
    expect(r).toMatchObject({ outcome: "INCOMPLETE", finalized: true });
    expect(calls.release).toHaveLength(2);
    expectNoSecrets(r);
  });
  it.each([
    ["LOCK_TIMEOUT dos veces", [{ released: false, reason: "LOCK_TIMEOUT" }]],
    ["lanza dos veces", [new Error("x")]],
  ])("%s → finalized false tras exactamente 2 intentos", async (_n, release) => {
    const { runner, calls } = setup({ ...incomplete, release });
    expect(await runner.run()).toMatchObject({ outcome: "INCOMPLETE", finalized: false });
    expect(calls.release).toHaveLength(2);
    expect(logged()).toMatch(/sin cerrar/);
  });
  it("release devuelve runFinalized false (la ejecución ya no estaba RUNNING) → finalized false", async () => {
    const { runner } = setup({ ...incomplete, release: [{ released: true, runFinalized: false }] });
    expect(await runner.run()).toMatchObject({ finalized: false });
  });
});

describe("M1: presupuesto temporal con reloj simulado (ninguna operación empieza si no cabe)", () => {
  type Res = unknown;
  type Step = { res: Res; ms: number };
  /**
   * Banco determinista: cada dependencia avanza un reloj simulado lo que se le indica (por defecto, su cota máxima) y
   * registra cuándo empezó y terminó. Nada espera de verdad.
   */
  function timed(o: { acquireMs?: number; detect?: "complete" | "incomplete" | "throw"; finish?: Step[]; release?: Step[]; retention?: boolean }) {
    let now = 1_000_000; const t0 = now;
    const ops: { op: string; start: number; end: number }[] = [];
    const take = async <T,>(op: string, ms: number, v: () => T | Promise<T>) => {
      const start = now - t0; now += ms; ops.push({ op, start, end: now - t0 }); return v();
    };
    const queue = (steps: Step[]) => { const q = [...steps]; return () => (q.length > 1 ? q.shift()! : q[0]!); };
    const nextFinish = queue(o.finish ?? [{ res: { ok: true, value: SUMMARY, finishedAt: new Date() }, ms: m.LEASE_OP_MAX_MS }]);
    const nextRelease = queue(o.release ?? [{ res: { released: true, runFinalized: true }, ms: m.LEASE_OP_MAX_MS }]);
    const budgets: { budgetMs: number; queryBudgetMs: number }[] = [];
    const retentionBudgets: number[] = [];
    const deps = {
      clock: () => now,
      lease: {
        acquire: () => take("acquire", o.acquireMs ?? m.LEASE_OP_MAX_MS, () => ({ status: "ACQUIRED", lease: LEASE, abandoned: 0 })),
        finishWith: async () => { const st = nextFinish(); return take("finishWith", st.ms, () => { if (st.res instanceof Error) throw st.res; return st.res; }); },
        release: async () => { const st = nextRelease(); return take("release", st.ms, () => { if (st.res instanceof Error) throw st.res; return st.res; }); },
      },
      detect: async (opts: { budgetMs: number; queryBudgetMs: number }) => {
        budgets.push(opts);
        // Peor caso: agota inventario + lecturas y además el desfase máximo previsto.
        return take("detect", opts.budgetMs + opts.queryBudgetMs + m.DETECT_OVERRUN_MS, () => {
          if (o.detect === "throw") throw new Error("x");
          return { report: report(o.detect === "incomplete" ? { complete: false, errors: [{ stage: "inventory", scope: "upload", code: "X" }] } : {}), candidates: [candidate] };
        });
      },
      persist: async () => SUMMARY,
      // Peor caso de la retención: consume TODO su presupuesto si cabe un lote (12 s); si no, se omite al instante.
      retention: o.retention ? {
        run: async (_l: unknown, opts: { budgetMs: number }) => {
          retentionBudgets.push(opts.budgetMs);
          return take("retention", opts.budgetMs >= 12_000 ? opts.budgetMs : 0, () => RETENTION_DONE);
        },
      } : undefined,
    };
    return { runner: m.createMediaReconcileRunner(deps as never), ops, budgets, retentionBudgets };
  }
  const LT = (ms = m.LEASE_OP_MAX_MS) => ({ res: { ok: false, reason: "LOCK_TIMEOUT" }, ms });
  const RLT = (ms = m.LEASE_OP_MAX_MS) => ({ res: { released: false, reason: "LOCK_TIMEOUT" }, ms });
  /** Invariante: toda operación iniciada cabía entera antes de HARD_DEADLINE_MS (< 300 s). */
  const expectWithinBudget = (ops: { start: number; end: number }[]) => {
    for (const x of ops) expect(x.end, JSON.stringify(x)).toBeLessThanOrEqual(m.HARD_DEADLINE_MS);
    expect(Math.max(0, ...ops.map((x) => x.end))).toBeLessThan(m.RUN_MAX_DURATION_MS);
  };

  it("peor caso: acquire, detección, finishWith y release agotan su cota → termina en 290 s exactos; el reintento de release no empieza", async () => {
    const { runner, ops, budgets } = timed({ finish: [{ res: new Error("x"), ms: m.LEASE_OP_MAX_MS }], release: [RLT()] });
    const r = await runner.run();
    expect(budgets[0]).toMatchObject({ budgetMs: 290_000 - 42_000 - 2 * 42_000 - 5_000 - 30_000, queryBudgetMs: 30_000 }); // inventario 129 s
    expect(ops.map((x) => [x.op, x.end])).toEqual([["acquire", 42_000], ["detect", 206_000], ["finishWith", 248_000], ["release", 290_000]]);
    expect(r).toMatchObject({ outcome: "FAILED", finalized: false, errorCodes: ["persist/INTERNAL", "budget/TIME_EXHAUSTED"] });
    expectWithinBudget(ops);
  });

  it("caso normal (acquire rápido): detección con sus 180 s completos y un reintento de finishWith que sí cabe", async () => {
    const { runner, ops, budgets } = timed({ acquireMs: 100, finish: [LT(12_000), { res: { ok: true, value: SUMMARY, finishedAt: new Date() }, ms: m.LEASE_OP_MAX_MS }] });
    expect(await runner.run()).toMatchObject({ outcome: "COMPLETED", finalized: true });
    expect(budgets[0]).toMatchObject({ budgetMs: m.INVENTORY_BUDGET_MS, queryBudgetMs: m.QUERY_BUDGET_MS });
    expect(ops.filter((x) => x.op === "finishWith")).toHaveLength(2);
    expectWithinBudget(ops);
  });

  it("LOCK_TIMEOUT que agota su cota: el reintento de finishWith NO empieza (no cabría con su release); se cierra FAILED", async () => {
    const { runner, ops } = timed({ finish: [LT()] });
    const r = await runner.run();
    expect(ops.map((x) => x.op)).toEqual(["acquire", "detect", "finishWith", "release"]);
    expect(r).toMatchObject({ outcome: "FAILED", finalized: true, errorCodes: ["lease/LOCK_TIMEOUT"] });
    expectWithinBudget(ops);
  });

  it("acquire anormalmente lento (170 s): no se empieza la detección; se cierra FAILED budget/TIME_EXHAUSTED y el lease se libera", async () => {
    const { runner, ops, budgets } = timed({ acquireMs: 170_000 });
    expect(await runner.run()).toMatchObject({ outcome: "FAILED", finalized: true, report: null, errorCodes: ["budget/TIME_EXHAUSTED"] });
    expect(budgets).toEqual([]);
    expect(ops.map((x) => x.op)).toEqual(["acquire", "release"]);
    expectWithinBudget(ops);
  });

  it("acquire más allá de toda cota (260 s): ni detección ni release; finalized false (se recupera al caducar el lease)", async () => {
    const { runner, ops } = timed({ acquireMs: 260_000 });
    expect(await runner.run()).toMatchObject({ outcome: "FAILED", finalized: false, errorCodes: ["budget/TIME_EXHAUSTED"] });
    expect(ops.map((x) => x.op)).toEqual(["acquire"]);
  });

  it("todas las combinaciones permitidas terminan antes de 290 s (< 300 s) y sin operaciones que no cupieran", async () => {
    const OK_F = { res: { ok: true, value: SUMMARY, finishedAt: new Date() }, ms: m.LEASE_OP_MAX_MS };
    const finishes: Step[][] = [[OK_F], [LT(2_000), OK_F], [LT(12_000), LT(12_000)], [LT(), OK_F], [{ res: new Error("x"), ms: m.LEASE_OP_MAX_MS }],
      [{ res: { ok: false, reason: "LEASE_LOST" }, ms: m.LEASE_OP_MAX_MS }]];
    const releases: Step[][] = [[{ res: { released: true, runFinalized: true }, ms: m.LEASE_OP_MAX_MS }], [RLT(), RLT()], [RLT(2_000), RLT(2_000)],
      [{ res: new Error("x"), ms: 1_000 }, { res: { released: true, runFinalized: true }, ms: m.LEASE_OP_MAX_MS }]];
    let combos = 0;
    for (const acquireMs of [0, 1_000, 20_000, 42_000, 120_000]) {
      for (const detect of ["complete", "incomplete", "throw"] as const) {
        for (const finish of finishes) {
          for (const release of releases) {
            const { runner, ops } = timed({ acquireMs, detect, finish, release });
            const r = await runner.run();
            expectWithinBudget(ops);
            // Si la ejecución no quedó cerrada, o se agotó el presupuesto o release no lo consiguió: recuperable al caducar.
            if (r.outcome !== "BUSY" && !r.finalized) {
              expect(r.errorCodes.includes("budget/TIME_EXHAUSTED") || ops.filter((x) => x.op === "release").length > 0).toBe(true);
            }
            combos++;
          }
        }
      }
    }
    expect(combos).toBe(5 * 3 * 6 * 4);
  });

  it("retención: con acquire normal recibe 20 s y aun consumiéndolos enteros la detección conserva 150 s de inventario", async () => {
    const { runner, ops, budgets, retentionBudgets } = timed({ acquireMs: 100, retention: true });
    expect(await runner.run()).toMatchObject({ outcome: "COMPLETED" });
    expect(retentionBudgets).toEqual([m.RETENTION_MAX_BUDGET_MS]);
    expect(budgets[0]).toMatchObject({ budgetMs: m.INVENTORY_BUDGET_MS, queryBudgetMs: m.QUERY_BUDGET_MS });
    expect(ops.map((x) => x.op)).toEqual(["acquire", "retention", "detect", "finishWith"]);
    expectWithinBudget(ops);
  });

  it("retención: solo recibe el tiempo sobrante (acquire de 5 s → 16 s; de 10 s → 11 s, no cabe un lote y no consume nada)", async () => {
    const five = timed({ acquireMs: 5_000, retention: true });
    await five.runner.run();
    expect(five.retentionBudgets).toEqual([290_000 - 5_000 - 185_000 - 84_000]);
    expect(five.budgets[0]).toMatchObject({ budgetMs: m.INVENTORY_BUDGET_MS }); // la detección no se recorta
    const ten = timed({ acquireMs: 10_000, retention: true });
    await ten.runner.run();
    expect(ten.retentionBudgets).toEqual([11_000]);
    expect(ten.ops.find((x) => x.op === "retention")).toMatchObject({ start: 10_000, end: 10_000 });
    expect(ten.budgets[0]).toMatchObject({ budgetMs: m.INVENTORY_BUDGET_MS });
  });

  it("con la retención agotando su presupuesto, todas las combinaciones siguen terminando antes de 290 s", async () => {
    const OK_F = { res: { ok: true, value: SUMMARY, finishedAt: new Date() }, ms: m.LEASE_OP_MAX_MS };
    let combos = 0;
    for (const acquireMs of [0, 5_000, 9_000, 20_000, 42_000]) {
      for (const detect of ["complete", "incomplete", "throw"] as const) {
        for (const finish of [[OK_F], [LT(12_000), OK_F], [{ res: new Error("x"), ms: m.LEASE_OP_MAX_MS }]] as Step[][]) {
          for (const release of [[RLT(), RLT()], [{ res: { released: true, runFinalized: true }, ms: m.LEASE_OP_MAX_MS }]] as Step[][]) {
            const { runner, ops } = timed({ acquireMs, detect, finish, release, retention: true });
            await runner.run();
            expectWithinBudget(ops);
            const ret = ops.find((x) => x.op === "retention")!;
            expect(ret.end - ret.start).toBeLessThanOrEqual(m.RETENTION_MAX_BUDGET_MS);
            combos++;
          }
        }
      }
    }
    expect(combos).toBe(5 * 3 * 3 * 2);
  });
});

describe("modo de retención (19.8d) en el orquestador", () => {
  const withMode = (mode: unknown, extra: object = {}) => {
    const calls: Array<Record<string, unknown>> = [];
    const retention = { run: vi.fn(async (_l: unknown, o: Record<string, unknown>) => { calls.push(o); return RETENTION_DONE; }) };
    const s = setup({ retention });
    const runner = m.createMediaReconcileRunner({ ...s.deps, retention, retentionMode: typeof mode === "function" ? mode : () => mode, ...extra } as never);
    return { runner, calls, deps: s.deps };
  };

  it("sin proveedor de modo → DRY_RUN", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const s = setup({ retention: { run: async (_l: unknown, o: Record<string, unknown>) => { calls.push(o); return RETENTION_DONE; } } });
    await s.runner.run();
    expect(calls[0]!.mode).toBe("DRY_RUN");
  });
  it("el servicio recibe el modo del proveedor ('DRY_RUN' o, solo si el proveedor lo devuelve, 'APPLY')", async () => {
    const a = withMode("DRY_RUN"); await a.runner.run(); expect(a.calls[0]!.mode).toBe("DRY_RUN");
    const b = withMode("APPLY"); await b.runner.run(); expect(b.calls[0]!.mode).toBe("APPLY");
  });
  it.each([["lanza", () => { throw new Error("ai-wardrobe/x"); }], ["minúsculas", "apply"], ["undefined", undefined], ["objeto", {}], ["null", null]])(
    "proveedor inválido (%s) → DRY_RUN", async (_n, v) => {
      const r = withMode(v); const res = await r.runner.run();
      expect(r.calls[0]!.mode).toBe("DRY_RUN");
      expect(res).toMatchObject({ outcome: "COMPLETED" });
      expect(JSON.stringify(res)).not.toMatch(/ai-wardrobe\//);
    });
  const FULL = { MEDIA_RETENTION_MODE: "APPLY", MEDIA_RETENTION_APPLY_CONFIRM: "apply-media-retention-policy-v1", VERCEL_ENV: "production" };
  it.each([
    ["sin configuración", {}], ["solo MODE=APPLY", { MEDIA_RETENTION_MODE: "APPLY" }], ["APPLY + confirmación sin entorno", { ...FULL, VERCEL_ENV: "preview" }],
    ["configuración COMPLETA y correcta (constante en false)", FULL], ["DRY_RUN explícito", { MEDIA_RETENTION_MODE: "DRY_RUN" }],
    ["modo inválido", { MEDIA_RETENTION_MODE: "apply" }], ["confirmación errónea", { ...FULL, MEDIA_RETENTION_APPLY_CONFIRM: "x" }],
    ["entorno ilegible", null],
  ])("configuredRetentionMode: %s → DRY_RUN", (_n, env) => {
    expect(m.configuredRetentionMode(env)).toBe("DRY_RUN");
  });
});

describe("retención DRY_RUN (19.8a) dentro del orquestador", () => {
  const retentionOf = (result: unknown) => {
    const calls: unknown[][] = [];
    return { calls, dep: { run: vi.fn(async (...a: unknown[]) => { calls.push(a); if (result instanceof Error) throw result; return result; }) } };
  };
  const stoppedLogs = () => (errSpy.mock.calls as unknown[][]).map((c) => String(c[0])).filter((l) => l.includes("Retención") && l.includes("STOPPED"));
  const summaryArg = (args: unknown[]) => (args[1] as { summary: { retention?: unknown; report?: unknown } }).summary;

  it("se ejecuta tras acquire y ANTES de la detección, con el lease, 20 s, TTL 360 s y GRACE_HOURS; el resultado va al summary", async () => {
    const r = retentionOf(RETENTION_DONE);
    const order: string[] = [];
    const { runner, deps, calls } = setup({ retention: r.dep });
    deps.detect.mockImplementationOnce(async () => { order.push("detect"); return { report: report(), candidates: [candidate] } as never; });
    r.dep.run.mockImplementationOnce(async (...a: unknown[]) => { order.push("retention"); r.calls.push(a); return RETENTION_DONE; });
    const res = await runner.run();
    expect(order).toEqual(["retention", "detect"]);
    expect(r.calls[0]![0]).toBe(LEASE);
    expect(r.calls[0]![1]).toMatchObject({ budgetMs: m.RETENTION_MAX_BUDGET_MS, ttlMs: 360_000, graceHours: m.GRACE_HOURS });
    expect(res).toMatchObject({ outcome: "COMPLETED", errorCodes: [] });
    expect(summaryArg(calls.finish[0]!)).toEqual({ report: report(), retention: RETENTION_DONE });
    expect(calls.finish[0]![1]).toMatchObject({ errorCodes: [] });
  });

  it("error de retención (STOPPED) → la detección continúa; el código queda en errorCodes de la ejecución y del resultado", async () => {
    const stopped = { ...RETENTION_DONE, status: "STOPPED", errorCodes: ["retention/DEADLOCK"] };
    const { runner, deps, calls } = setup({ retention: retentionOf(stopped).dep });
    const res = await runner.run();
    expect(deps.detect).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ outcome: "COMPLETED", finalized: true, errorCodes: ["retention/DEADLOCK"] });
    expect(calls.finish[0]![1]).toMatchObject({ errorCodes: ["retention/DEADLOCK"], summary: { retention: stopped } });
  });

  it("STOPPED → un único log sanitizado (modo, códigos, lotes) sin ids/URLs/mensajes; la detección continúa y COMPLETED", async () => {
    const stopped = { ...RETENTION_DONE, status: "STOPPED", errorCodes: ["retention/DEADLOCK", "retention/LOCK_TIMEOUT"] };
    const { runner, deps } = setup({ retention: retentionOf(stopped).dep });
    errSpy.mockClear();
    const res = await runner.run();
    expect(deps.detect).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ outcome: "COMPLETED", finalized: true });
    const logs = stoppedLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("DRY_RUN");
    expect(logs[0]).toContain("retention/DEADLOCK,retention/LOCK_TIMEOUT");
    expect(JSON.parse(logs[0]!).message).not.toMatch(/ai-wardrobe|https?:|asset-secreto|owner|cloudinary/i);
  });

  it("retención que lanza con mensaje sensible → log STOPPED solo con retention/INTERNAL", async () => {
    const { runner } = setup({ retention: retentionOf(new Error("https://res.cloudinary.com/ai-wardrobe/u/x")).dep });
    errSpy.mockClear();
    await runner.run();
    const logs = stoppedLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("retention/INTERNAL");
    expect(JSON.parse(logs[0]!).message).not.toMatch(/ai-wardrobe|https?:|cloudinary/i);
  });

  it.each(["DONE", "PARTIAL", "SKIPPED"])("%s no genera log de STOPPED", async (status) => {
    const { runner } = setup({ retention: retentionOf({ ...RETENTION_DONE, status }).dep });
    errSpy.mockClear();
    const res = await runner.run();
    expect(res).toMatchObject({ outcome: "COMPLETED" });
    expect(stoppedLogs().length > 0).toBe(false);
  });

  it("LEASE_LOST no se registra como STOPPED y conserva su cierre", async () => {
    const lost = { ...RETENTION_DONE, status: "LEASE_LOST", errorCodes: ["retention/LEASE_LOST"] };
    const { runner } = setup({ retention: retentionOf(lost).dep, release: [{ released: false, reason: "LEASE_LOST" }] });
    errSpy.mockClear();
    const res = await runner.run();
    expect(res).toMatchObject({ outcome: "LEASE_LOST" });
    expect(stoppedLogs().length > 0).toBe(false);
  });

  it("la retención lanza (inesperado) → STOPPED retention/INTERNAL y la detección continúa", async () => {
    const { runner, deps } = setup({ retention: retentionOf(new Error("ai-wardrobe/u/x")).dep });
    const res = await runner.run();
    expect(deps.detect).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ outcome: "COMPLETED", errorCodes: ["retention/INTERNAL"] });
    expect(JSON.stringify(res)).not.toMatch(/ai-wardrobe/);
  });

  it("LEASE_LOST en la retención → se detiene TODA la ejecución: sin detección ni finishWith; cierre FAILED con los dos códigos", async () => {
    const lost = { ...RETENTION_DONE, status: "LEASE_LOST", errorCodes: ["retention/LEASE_LOST"] };
    const { runner, deps, calls } = setup({ retention: retentionOf(lost).dep, release: [{ released: false, reason: "LEASE_LOST" }] });
    const res = await runner.run();
    expect(res).toMatchObject({ outcome: "LEASE_LOST", finalized: false, errorCodes: ["lease/LEASE_LOST", "retention/LEASE_LOST"] });
    expect(deps.detect).not.toHaveBeenCalled();
    expect(deps.lease.finishWith).not.toHaveBeenCalled();
    expect(calls.release[0]![1]).toMatchObject({ status: "FAILED", summary: { retention: lost } });
  });

  it.each([
    ["detección INCOMPLETE", { detection: { report: report({ complete: false, inventoryStatus: "INCOMPLETE", errors: [{ stage: "inventory", scope: "upload", code: "X" }] }), candidates: [] } }],
    ["el detector lanza", { detectError: new Error("x") }],
    ["finishWith lanza (persistencia)", { finish: [new Error("x")] }],
    ["finishWith LEASE_LOST", { finish: [{ ok: false, reason: "LEASE_LOST" }] }],
  ])("%s → los recuentos de retención se conservan en el summary del cierre", async (_n, over) => {
    const { runner, calls } = setup({ retention: retentionOf(RETENTION_DONE).dep, ...over });
    await runner.run();
    expect(summaryArg(calls.release[0]!)).toMatchObject({ retention: RETENTION_DONE });
  });

});

describe("códigos de error", () => {
  const VALID = (c: string) => typeof c === "string" && c.length >= 1 && c.length <= 120 && /^[A-Za-z0-9_./:-]+$/.test(c);
  const codes = (n: number) => Array.from({ length: n }, (_, i) => `c${i}`);
  it("sanea, recorta a 120 y elimina duplicados, vacíos y valores que no son texto", () => {
    expect(m.normalizeErrorCodes(["a/b", "a/b", "", "con espacios y ñ", 5 as never, null as never, "x".repeat(500)]))
      .toEqual(["a/b", "con_espacios_y__", "x".repeat(120)]);
    expect(m.normalizeErrorCodes(["x/1", "x/1", "x/2", "x/1"])).toEqual(["x/1", "x/2"]);
    expect(m.normalizeErrorCodes(["a b", "a_b"])).toEqual(["a_b"]); // iguales tras sanear → uno solo
  });
  it("entradas vacías o inválidas → [] (nunca lanza)", () => {
    for (const v of [[], null, undefined, "c1", 5, {}, ["", "", undefined, 3]]) expect(m.normalizeErrorCodes(v as never)).toEqual([]);
  });
  it("63 únicos → los 63, sin TRUNCATED", () => {
    expect(m.normalizeErrorCodes(codes(63))).toEqual(codes(63));
  });
  it("exactamente 64 únicos → los 64 (incluido c63), sin TRUNCATED", () => {
    const out = m.normalizeErrorCodes(codes(64));
    expect(out).toEqual(codes(64));
    expect(out).toContain("c63");
    expect(out).not.toContain("TRUNCATED");
  });
  it("64 únicos con duplicados intercalados → los 64, sin TRUNCATED (los duplicados no cuentan)", () => {
    expect(m.normalizeErrorCodes([...codes(64), ...codes(64), "c0"])).toEqual(codes(64));
  });
  it("65 únicos → los 63 primeros y TRUNCATED (64 en total)", () => {
    expect(m.normalizeErrorCodes(codes(65))).toEqual([...codes(63), "TRUNCATED"]);
  });
  it("200 únicos → los 63 primeros y TRUNCATED; un TRUNCATED de entrada no se duplica", () => {
    const many = m.normalizeErrorCodes(codes(200));
    expect(many).toEqual([...codes(63), "TRUNCATED"]);
    for (const c of many) expect(VALID(c)).toBe(true);
    expect(m.normalizeErrorCodes(["TRUNCATED", ...codes(70)])).toEqual([...codes(63), "TRUNCATED"]);
  });
  it("muchos errores del informe → release recibe códigos válidos (≤ 64, ≤ 120)", async () => {
    const errors = Array.from({ length: 300 }, (_, i) => ({ stage: "inventory", scope: "upload", code: `E${i}${"z".repeat(150)}` }));
    const { runner, calls } = setup({ detection: { report: report({ complete: false, errors }), candidates: [] } });
    await runner.run();
    const codes = (calls.release[0]![1] as { errorCodes: string[] }).errorCodes;
    expect(codes.length).toBeLessThanOrEqual(64);
    expect(codes.every(VALID)).toBe(true);
  });
});

describe("coherencia de tiempos y periodo de gracia", () => {
  it("TTL ≥ maxDuration + 60 s; maxDuration de la ruta = RUN_MAX_DURATION_MS; presupuestos dentro de la duración", async () => {
    const route = await import("@/app/api/cron/media-reconcile/run/route");
    expect(route.maxDuration * 1000).toBe(m.RUN_MAX_DURATION_MS);
    expect(m.LEASE_TTL_MS).toBe(360_000);
    expect(m.LEASE_TTL_MS).toBeGreaterThanOrEqual(m.RUN_MAX_DURATION_MS + m.LEASE_MARGIN_MS);
    expect(m.LEASE_MARGIN_MS).toBeGreaterThanOrEqual(60_000);
    expect(m.DETECT_BUDGET_MS).toBe(180_000);
    expect(m.INVENTORY_BUDGET_MS + m.QUERY_BUDGET_MS).toBe(m.DETECT_BUDGET_MS);
    // Fecha límite dura: 300 s − 10 s de margen. Cota de una operación del lease: 10 s (maxWait) + 30 s (timeout) + 2 s.
    expect(m.HARD_DEADLINE_MS).toBe(290_000);
    expect(m.HARD_DEADLINE_MS).toBeLessThan(m.RUN_MAX_DURATION_MS);
    expect(m.LEASE_OP_MAX_MS).toBe(42_000);
    // Camino normal (acquire ≈ 0): la detección recibe sus 180 s y aun así caben finishWith + release.
    expect(m.DETECT_BUDGET_MS + m.DETECT_OVERRUN_MS + 2 * m.LEASE_OP_MAX_MS).toBeLessThanOrEqual(m.HARD_DEADLINE_MS);
    // Peor caso: acquire agota su cota; la detección se acorta hasta que vuelve a caber todo, sin bajar del mínimo.
    const worstInventory = m.HARD_DEADLINE_MS - m.LEASE_OP_MAX_MS - 2 * m.LEASE_OP_MAX_MS - m.DETECT_OVERRUN_MS - m.QUERY_BUDGET_MS;
    expect(worstInventory).toBeGreaterThanOrEqual(m.MIN_INVENTORY_BUDGET_MS);
    expect(m.LEASE_OP_MAX_MS + worstInventory + m.QUERY_BUDGET_MS + m.DETECT_OVERRUN_MS + 2 * m.LEASE_OP_MAX_MS).toBe(m.HARD_DEADLINE_MS);
  });
  it("las cotas usadas coinciden con las transacciones reales de media-lease.service (maxWait 10 s, timeout 30 s)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/services/media-lease.service.ts", "utf8");
    const tx = /const TX = \{[^}]*maxWait: ([\d_]+), timeout: ([\d_]+) \}/.exec(src);
    expect(tx, "media-lease.service ya no define TX como se esperaba: revisa LEASE_TX_* del orquestador").not.toBeNull();
    expect(Number(tx![1]!.replace(/_/g, ""))).toBe(m.LEASE_TX_MAX_WAIT_MS);
    expect(Number(tx![2]!.replace(/_/g, ""))).toBe(m.LEASE_TX_TIMEOUT_MS);
    expect(m.LOCK_TIMEOUT_MS).toBeLessThan(m.LEASE_TX_TIMEOUT_MS);
  });
  it("una única configuración de gracia: horas (acquire) y ms (detector) coinciden y respetan los límites del esquema", async () => {
    const det = await import("@/services/media-reconcile.service");
    expect(m.GRACE_HOURS * 3_600_000).toBe(m.GRACE_MS);
    expect(det.effectiveGraceMs(m.GRACE_MS)).toBe(m.GRACE_MS); // el detector no la altera
    expect(m.GRACE_HOURS).toBeGreaterThanOrEqual(1);
    expect(m.GRACE_HOURS).toBeLessThanOrEqual(8760);
  });
  it("el servicio no usa Date.now() salvo como reloj local por defecto del presupuesto", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/services/media-reconcile-run.service.ts", "utf8").replace(/^\s*(\*|\/\/).*$/gm, "");
    expect(src.match(/Date\.now\(\)/g)).toHaveLength(1);
    expect(src).toMatch(/clock \?\? \(\(\) => Date\.now\(\)\)/);
    expect(src).not.toMatch(/new Date\(\)/);
    expect(src).not.toMatch(/@\/lib\/cloudinary|destroy|delete_resources|deleteMany/);
  });
});
