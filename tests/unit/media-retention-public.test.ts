import { beforeAll, describe, expect, it, vi } from "vitest";
import { setTestEnv } from "../helpers/mock-prisma";

/** Fase 19.8c — vista pública de la retención y respuesta HTTP de /api/cron/media-reconcile/run (servicios simulados). */
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
const runMock = vi.fn();
vi.mock("@/lib/auth/cron", () => ({ isAuthorizedCron: () => true }));

type Pub = typeof import("@/services/media-retention-public");
type Ret = typeof import("@/services/media-retention.service");
let pub: Pub; let ret: Ret; let GET: (req: Request) => Promise<Response>;
beforeAll(async () => {
  setTestEnv();
  const real = await import("@/services/media-reconcile-run.service");
  vi.doMock("@/services/media-reconcile-run.service", () => ({ ...real, mediaReconcileRunner: { run: runMock } }));
  pub = await import("@/services/media-retention-public");
  ret = await import("@/services/media-retention.service");
  GET = (await import("@/app/api/cron/media-reconcile/run/route")).GET as never;
});

const SECRETS = /ai-wardrobe\/|https?:|asset-secreto|run-secreto|cloudinary|fencingToken|stack|owner-secreto/i;
const done = () => {
  const r = ret.emptyRetentionResult("DONE");
  r.assets = { ...r.assets, eligible: 3, batches: 1, complete: true, end: "COMPLETE", byRule: { CLEARED: 3, CLEARED_OWNER_MISSING: 0, ACTIVE_OWNER_MISSING: 0, ACTIVE: 0 } };
  r.runs = { ...r.runs, eligible: 1, batches: 1, complete: true, end: "COMPLETE", byStatus: { COMPLETED: 1, INCOMPLETE: 0, FAILED: 0, ABANDONED: 0 } };
  return r;
};
const body = async (retention: unknown, extra: object = {}) => {
  runMock.mockResolvedValueOnce({ outcome: "COMPLETED", finalized: true, report: { complete: true }, persisted: { created: 2 }, errorCodes: [], retention, ...extra });
  const res = await GET(new Request("http://localhost/api/cron/media-reconcile/run"));
  return { res, json: await res.json() as Record<string, unknown> };
};

describe("publicRetention", () => {
  it("sin resultado → null", () => {
    expect(pub.publicRetention(null)).toBeNull();
    expect(pub.publicRetention(undefined)).toBeNull();
  });
  it("copia exactamente los campos agregados del tipo real", () => {
    const p = pub.publicRetention(done())!;
    expect(Object.keys(p).sort()).toEqual(["assets", "countsAreLowerBound", "errorCodes", "mode", "runs", "status"]);
    expect(Object.keys(p.assets).sort()).toEqual(["batches", "byRule", "complete", "deleted", "deletedByRule", "eligible", "end"]);
    expect(Object.keys(p.runs).sort()).toEqual(["batches", "byStatus", "complete", "deleted", "deletedByStatus", "eligible", "end"]);
    expect(p).toMatchObject({ mode: "DRY_RUN", status: "DONE", countsAreLowerBound: true, assets: { eligible: 3, byRule: { CLEARED: 3 } }, runs: { eligible: 1, byStatus: { COMPLETED: 1 } } });
  });
  it("descarta propiedades extra (ids, URLs, tokens)", () => {
    const dirty = { ...done(), publicId: "ai-wardrobe/owner-secreto/x", fencingToken: 9, stack: "at x" } as never;
    (dirty as { assets: object }).assets = { ...(dirty as { assets: object }).assets, assetId: "asset-secreto" };
    expect(JSON.stringify(pub.publicRetention(dirty))).not.toMatch(SECRETS);
  });
});

describe("publicRetentionErrorCodes (lista blanca estricta)", () => {
  const REAL = ["retention/LOCK_TIMEOUT", "retention/LEASE_ERROR", "retention/LEASE_LOST", "retention/DEADLOCK", "retention/QUERY_TIMEOUT",
    "retention/FK_VIOLATION", "retention/TX_TIMEOUT", "retention/DB_ERROR", "retention/INTERNAL"];
  it("todos los códigos reales del servicio y del orquestador pasan tal cual", () => {
    for (const c of REAL) expect(pub.publicRetentionErrorCodes([c])).toEqual([c]);
    expect([...pub.PUBLIC_RETENTION_ERROR_CODES].sort()).toEqual([...REAL].sort());
  });
  it("cubre lo que realmente produce classifyRetentionError", async () => {
    const { MediaLeaseError } = await import("@/services/media-lease.service");
    const pg = (c: string) => ({ meta: { driverAdapterError: { cause: { originalCode: c } } } });
    const produced = [
      ret.classifyRetentionError(new MediaLeaseError("LOCK_TIMEOUT" as never)), ret.classifyRetentionError(new MediaLeaseError("OTHER" as never)),
      ret.classifyRetentionError(pg("40P01")), ret.classifyRetentionError(pg("55P03")), ret.classifyRetentionError(pg("57014")),
      ret.classifyRetentionError(pg("23503")), ret.classifyRetentionError({ code: "P2028" }), ret.classifyRetentionError(new Error("ai-wardrobe/u/x")),
    ];
    for (const c of produced) expect(pub.PUBLIC_RETENTION_ERROR_CODES.has(c)).toBe(true);
  });
  it.each([
    ["desconocido", "retention/NOPE"], ["URL https", "https://res.cloudinary.com/demo/image/upload/x.jpg"], ["URL http", "http://evil.test/x"],
    ["publicId", "ai-wardrobe/owner-secreto/wardrobe/foto"], ["ruta Cloudinary", "image/upload/v1/ai-wardrobe/u/x"],
    ["mensaje de excepción", "Error: fallo con asset-secreto"], ["prefijo válido + sufijo", "retention/DEADLOCK/ai-wardrobe/u"],
    ["mayúsculas/espacios", " retention/DEADLOCK"], ["vacío", ""],
  ])("%s → solo el código genérico UNKNOWN", (_n, bad) => {
    expect(pub.publicRetentionErrorCodes([bad])).toEqual([pub.UNKNOWN_RETENTION_ERROR_CODE]);
  });
  it("valores malformados (no texto) → UNKNOWN una sola vez; entrada no array → []", () => {
    expect(pub.publicRetentionErrorCodes([null, 5, {}, ["retention/DEADLOCK"], undefined, true])).toEqual([pub.UNKNOWN_RETENTION_ERROR_CODE]);
    for (const v of [undefined, null, "retention/DEADLOCK", 3, {}]) expect(pub.publicRetentionErrorCodes(v)).toEqual([]);
  });
  it("deduplica y mezcla autorizados con ajenos: autorizados + un único UNKNOWN", () => {
    expect(pub.publicRetentionErrorCodes(["retention/DEADLOCK", "retention/DEADLOCK", "x", "y", "retention/INTERNAL"]))
      .toEqual(["retention/DEADLOCK", "retention/INTERNAL", pub.UNKNOWN_RETENTION_ERROR_CODE]);
  });
  it("exceso de códigos: nunca más que el conjunto autorizado + UNKNOWN", () => {
    const many = [...Array.from({ length: 500 }, (_, i) => `retention/X${i}`), ...REAL, ...REAL];
    const out = pub.publicRetentionErrorCodes(many);
    expect(out).toHaveLength(REAL.length + 1);
    expect(out.filter((c) => c === pub.UNKNOWN_RETENTION_ERROR_CODE)).toHaveLength(1);
  });
  it("publicRetention: ningún dato no autorizado llega a retention.errorCodes", () => {
    const r = { ...ret.emptyRetentionResult("STOPPED", ["retention/DEADLOCK", "https://x/ai-wardrobe/u", "Error: asset-secreto", "retention/DEADLOCK"]) };
    expect(pub.publicRetention(r)!.errorCodes).toEqual(["retention/DEADLOCK", pub.UNKNOWN_RETENTION_ERROR_CODE]);
  });
});

describe("respuesta HTTP", () => {
  it("DONE: añade `retention` y conserva el resto de campos", async () => {
    const { res, json } = await body(done());
    expect(res.status).toBe(200);
    expect(Object.keys(json).sort()).toEqual(["errorCodes", "finalized", "outcome", "persisted", "report", "retention"]);
    expect(json).toMatchObject({ outcome: "COMPLETED", finalized: true, persisted: { created: 2 }, retention: { status: "DONE", mode: "DRY_RUN" } });
  });
  it("PARTIAL: recuentos inferiores y `end` de la fase", async () => {
    const r = done(); r.status = "PARTIAL"; r.assets.complete = false; r.assets.end = "MAX_BATCHES"; r.assets.batches = 10; r.assets.eligible = 2000;
    const { json } = await body(r);
    expect(json.retention).toMatchObject({ status: "PARTIAL", countsAreLowerBound: true, assets: { complete: false, end: "MAX_BATCHES", batches: 10, eligible: 2000 } });
  });
  it("HTTP: códigos ajenos en la retención → solo autorizados + UNKNOWN en la respuesta", async () => {
    const { json } = await body(ret.emptyRetentionResult("STOPPED", ["retention/DEADLOCK", "https://res.cloudinary.com/x", "ai-wardrobe/owner-secreto/a"]));
    expect((json.retention as { errorCodes: string[] }).errorCodes).toEqual(["retention/DEADLOCK", "retention/UNKNOWN_CODE"]);
    expect(JSON.stringify(json)).not.toMatch(SECRETS);
  });
  it("STOPPED: solo códigos genéricos, sin mensajes", async () => {
    const { json } = await body({ ...ret.emptyRetentionResult("STOPPED", ["retention/DEADLOCK"]), message: "ai-wardrobe/owner-secreto/x" }, { errorCodes: ["retention/DEADLOCK"] });
    expect(json.retention).toMatchObject({ status: "STOPPED", errorCodes: ["retention/DEADLOCK"] });
    expect(JSON.stringify(json)).not.toMatch(SECRETS);
  });
  it("SKIPPED: retención omitida por presupuesto", async () => {
    const { json } = await body(ret.emptyRetentionResult("SKIPPED"));
    expect(json.retention).toMatchObject({ status: "SKIPPED", assets: { end: "NOT_STARTED", eligible: 0 }, errorCodes: [] });
  });
  it("sin retención (no ejecutada) → retention: null", async () => {
    const { json } = await body(null);
    expect(json.retention).toBeNull();
  });
  it("LEASE_LOST: 500 con retención LEASE_LOST y sin identificadores", async () => {
    const lost = ret.emptyRetentionResult("LEASE_LOST", ["retention/LEASE_LOST"]);
    const { res, json } = await body(lost, { outcome: "LEASE_LOST", finalized: false, report: null, persisted: null, errorCodes: ["lease/LEASE_LOST", "retention/LEASE_LOST"] });
    expect(res.status).toBe(500);
    expect(json).toMatchObject({ outcome: "LEASE_LOST", retention: { status: "LEASE_LOST", errorCodes: ["retention/LEASE_LOST"] } });
    expect(JSON.stringify(json)).not.toMatch(SECRETS);
  });
  it("BUSY: sin campo retention (respuesta sin cambios)", async () => {
    runMock.mockResolvedValueOnce({ outcome: "BUSY", reason: "LEASE_HELD" });
    const res = await GET(new Request("http://localhost/api/cron/media-reconcile/run"));
    expect(await res.json()).toEqual({ outcome: "BUSY", reason: "LEASE_HELD" });
  });
});
