import { beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { setTestEnv } from "../helpers/mock-prisma";

/**
 * Fase 19.9c — segunda barrera de APPLY EN EL SERVICIO. Este archivo NO simula la configuración: usa el valor real de
 * RETENTION_APPLY_ENABLED (false). Instancia createMediaRetention() directamente (sin singleton ni orquestador) con un
 * lease simulado que captura TODO el SQL: con `mode: "APPLY"` no puede salir ni un DELETE.
 */
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

type Svc = typeof import("@/services/media-retention.service");
type Cfg = typeof import("@/services/media-retention-config");
let m: Svc; let cfg: Cfg;
beforeAll(async () => { setTestEnv(); m = await import("@/services/media-retention.service"); cfg = await import("@/services/media-retention-config"); });

const LEASE = { runId: "run-1", fencingToken: 7, leaseExpiresAt: new Date(), startedAt: new Date() };
const WRITE = /\b(DELETE|INSERT|TRUNCATE|MERGE)\b|\bUPDATE\s+"/i;

function rig(assetBatches: number[] = [200, 5], runBatches: number[] = [3]) {
  const sql: string[] = [];
  const assets = assetBatches.map((n) => Array.from({ length: n }, (_, i) => ({ delivery: "UPLOAD", publicId: `p${i}`, rule: "CLEARED" })));
  const runs = runBatches.map((n) => Array.from({ length: n }, (_, i) => ({ fencingToken: i + 1, status: "FAILED" })));
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = Prisma.sql(strings as unknown as string[], ...(values as never[]));
      sql.push(q.sql);
      if (q.sql.includes("set_config")) return [];
      // Una sentencia destructiva (que no debe existir) devolvería filas como si hubiera borrado.
      if (q.sql.includes(`FROM "MediaAsset" a JOIN`)) return assets.length > 1 ? assets.shift() : assets[0] ?? [];
      return runs.length > 1 ? runs.shift() : runs[0] ?? [];
    },
  };
  const lease = { withLease: vi.fn(async (_l: unknown, fn: (t: unknown) => Promise<unknown>) => ({ ok: true, value: await fn(tx), leaseExpiresAt: new Date() })) };
  const svc = m.createMediaRetention({ lease: lease as never });
  const run = (mode?: unknown, extra: object = {}) => svc.run(LEASE, { budgetMs: 1_000_000, ttlMs: 360_000, graceHours: 24, mode: mode as never, ...extra });
  return { run, sql, lease };
}

describe("RETENTION_APPLY_ENABLED = false → el servicio nunca ejecuta APPLY", () => {
  it("la constante es la del resolutor (misma fuente), sigue en false y el servicio no define otra", async () => {
    const { readFileSync } = await import("node:fs");
    expect(cfg.RETENTION_APPLY_ENABLED).toBe(false);
    const src = readFileSync("src/services/media-retention.service.ts", "utf8");
    expect(src).toMatch(/import \{ RETENTION_APPLY_ENABLED \} from "@\/services\/media-retention-config"/);
    expect(src).not.toMatch(/(const|let|var)\s+RETENTION_APPLY_ENABLED|process\.env/);
    expect(readFileSync("src/services/media-retention-config.ts", "utf8")).toMatch(/export const RETENTION_APPLY_ENABLED: boolean = false;/);
  });

  it('createMediaRetention().run con mode: "APPLY" → ni un DELETE; el modo informado es DRY_RUN', async () => {
    const r = rig();
    const res = await r.run("APPLY");
    expect(res).toMatchObject({ mode: "DRY_RUN", status: "DONE", assets: { eligible: 205, deleted: 0 }, runs: { eligible: 3, deleted: 0 } });
    expect(res.assets.deletedByRule).toEqual({ CLEARED: 0, CLEARED_OWNER_MISSING: 0, ACTIVE_OWNER_MISSING: 0, ACTIVE: 0 });
    expect(res.runs.deletedByStatus).toEqual({ COMPLETED: 0, INCOMPLETE: 0, FAILED: 0, ABANDONED: 0 });
    expect(r.sql.length).toBeGreaterThan(0);
    for (const q of r.sql) expect(q).not.toMatch(WRITE);
  });

  it("la barrera también rige con presupuesto 0 (SKIPPED) y sin filas elegibles: el modo informado es DRY_RUN y no hay escrituras", async () => {
    expect((await rig().run("APPLY", { budgetMs: 0 }))).toMatchObject({ mode: "DRY_RUN", status: "SKIPPED" });
    const r = rig([0], [0]);
    expect(await r.run("APPLY")).toMatchObject({ mode: "DRY_RUN", status: "DONE", assets: { eligible: 0 } });
    for (const q of r.sql) expect(q).not.toMatch(WRITE);
  });

  it("DRY_RUN conserva exactamente su comportamiento: mismo SQL y mismo resultado que APPLY degradado", async () => {
    const a = rig(); const b = rig();
    const dry = await a.run("DRY_RUN"); const downgraded = await b.run("APPLY");
    expect(downgraded).toEqual(dry);
    expect(b.sql).toEqual(a.sql);
    expect(await rig().run(undefined)).toEqual(dry);
  });

  it("una operación de lote que fallara se comunica igual: STOPPED en DRY_RUN, sin DELETE", async () => {
    const lease = { withLease: vi.fn(async () => { throw new Error("ai-wardrobe/u/x"); }) };
    const res = await m.createMediaRetention({ lease: lease as never }).run(LEASE, { budgetMs: 1_000_000, ttlMs: 360_000, graceHours: 24, mode: "APPLY" });
    expect(res).toMatchObject({ mode: "DRY_RUN", status: "STOPPED", errorCodes: ["retention/INTERNAL"] });
    expect(JSON.stringify(res)).not.toMatch(/ai-wardrobe/);
  });

  it.each([
    ["modo no exacto", "apply"], ["con espacios", " APPLY "], ["verdadero", true], ["número", 1], ["objeto", { toString: () => "APPLY" }],
    ["String object", new String("APPLY")], ["array", ["APPLY"]],
  ])("valor raro (%s) → DRY_RUN y sin escrituras", async (_n, mode) => {
    const r = rig(); const res = await r.run(mode);
    expect(res.mode).toBe("DRY_RUN");
    for (const q of r.sql) expect(q).not.toMatch(WRITE);
  });

  it("ningún campo extra de las opciones ni el entorno pueden saltarse la barrera", async () => {
    vi.stubEnv("MEDIA_RETENTION_MODE", "APPLY"); vi.stubEnv("MEDIA_RETENTION_APPLY_CONFIRM", "apply-media-retention-policy-v1"); vi.stubEnv("VERCEL_ENV", "production");
    try {
      const r = rig();
      const res = await r.run("APPLY", { enabled: true, applyEnabled: true, RETENTION_APPLY_ENABLED: true, force: true });
      expect(res.mode).toBe("DRY_RUN");
      for (const q of r.sql) expect(q).not.toMatch(WRITE);
    } finally { vi.unstubAllEnvs(); }
  });

  it("`mode` se lee UNA sola vez (sin ventana TOCTOU con un getter que cambie de valor)", async () => {
    let reads = 0;
    const opts = { budgetMs: 1_000_000, ttlMs: 360_000, graceHours: 24, get mode() { reads++; return reads === 1 ? "DRY_RUN" : "APPLY"; } };
    const r = rig();
    const res = await m.createMediaRetention({ lease: { withLease: vi.fn(async (_l: unknown, fn: (t: unknown) => Promise<unknown>) => ({ ok: true, value: await fn({ $queryRaw: async (s: TemplateStringsArray, ...v: unknown[]) => { const q = Prisma.sql(s as unknown as string[], ...(v as never[])); r.sql.push(q.sql); return []; } }), leaseExpiresAt: new Date() })) } as never }).run(LEASE, opts as never);
    expect(reads).toBe(1);
    expect(res.mode).toBe("DRY_RUN");
    for (const q of r.sql) expect(q).not.toMatch(WRITE);
  });

  it("con APPLY degradado la primera sentencia es el statement_timeout local y nunca aparece DELETE ni la forma MATERIALIZED de APPLY", async () => {
    const r = rig();
    await r.run("APPLY");
    expect(r.sql[0]).toContain("set_config"); // la primera sentencia de un lote es el statement_timeout local
    expect(r.sql.filter((q) => /\bDELETE\b/i.test(q))).toEqual([]);
    expect(r.sql.filter((q) => q.includes("MATERIALIZED"))).toEqual([]); // la forma de los lotes APPLY
  });
});
