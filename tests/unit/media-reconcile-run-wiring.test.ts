import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setTestEnv } from "../helpers/mock-prisma";

/**
 * Fase 19.8d — cableado REAL de la aplicación: `mediaReconcileRunner` (con process.env) debe pasar siempre DRY_RUN al
 * servicio de retención mientras RETENTION_APPLY_ENABLED sea false, aunque el entorno pida APPLY con todo correcto.
 * Sin PostgreSQL, Neon ni Cloudinary: el servicio de lease, el detector y la retención se simulan.
 */
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
const detectMock = vi.fn();
vi.mock("@/services/media-reconcile.service", async (orig) => ({ ...(await orig<object>()), detectOrphanMediaDetailed: (...a: unknown[]) => detectMock(...a) }));
const retentionRun = vi.fn();
vi.mock("@/services/media-retention.service", async (orig) => ({ ...(await orig<object>()), createMediaRetention: () => ({ run: (...a: unknown[]) => retentionRun(...a) }) }));

const STARTED = new Date("2026-11-20T10:00:00Z");
const LEASE = { runId: "run-secreto", fencingToken: 987654, leaseExpiresAt: new Date("2026-11-20T10:06:00Z"), startedAt: STARTED };
const APPLY_ENV = { MEDIA_RETENTION_MODE: "APPLY", MEDIA_RETENTION_APPLY_CONFIRM: "apply-media-retention-policy-v1", VERCEL_ENV: "production" };

let m: typeof import("@/services/media-reconcile-run.service");
let lease: typeof import("@/services/media-lease.service");
let ret: typeof import("@/services/media-retention.service");
beforeAll(async () => {
  setTestEnv();
  m = await import("@/services/media-reconcile-run.service");
  lease = await import("@/services/media-lease.service");
  ret = await import("@/services/media-retention.service");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); retentionRun.mockReset(); detectMock.mockReset(); });

function arrange(over: { acquire?: unknown } = {}) {
  const svc = lease.mediaLeaseService;
  vi.spyOn(svc, "acquire").mockResolvedValue((over.acquire ?? { status: "ACQUIRED", lease: LEASE, abandoned: 0 }) as never);
  vi.spyOn(svc, "finishWith").mockResolvedValue({ ok: true, value: { created: 0 }, finishedAt: new Date() } as never);
  vi.spyOn(svc, "release").mockResolvedValue({ released: true, runFinalized: true } as never);
  detectMock.mockResolvedValue({ report: { complete: true, inventoryStatus: "COMPLETE", errors: [] }, candidates: [] });
  retentionRun.mockResolvedValue(ret.emptyRetentionResult("DONE"));
  return svc;
}
const modePassed = () => (retentionRun.mock.calls[0]![1] as { mode: unknown }).mode;

describe("mediaReconcileRunner (cableado real) → modo de retención", () => {
  it.each([
    ["sin configuración", {}],
    ["MODE=APPLY sin más", { MEDIA_RETENTION_MODE: "APPLY" }],
    ["APPLY + confirmación correcta + production (constante en false)", APPLY_ENV],
    ["configuración incompleta", { MEDIA_RETENTION_MODE: "APPLY", VERCEL_ENV: "production" }],
    ["configuración inválida", { MEDIA_RETENTION_MODE: " apply ", MEDIA_RETENTION_APPLY_CONFIRM: "?" }],
    ["DRY_RUN explícito", { MEDIA_RETENTION_MODE: "DRY_RUN" }],
  ])("%s → la retención recibe DRY_RUN", async (_n, env) => {
    arrange();
    for (const k of ["MEDIA_RETENTION_MODE", "MEDIA_RETENTION_APPLY_CONFIRM", "VERCEL_ENV"]) vi.stubEnv(k, undefined as never);
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const res = await m.mediaReconcileRunner.run();
    expect(retentionRun).toHaveBeenCalledTimes(1);
    expect(modePassed()).toBe("DRY_RUN");
    expect(res).toMatchObject({ outcome: "COMPLETED", retention: { mode: "DRY_RUN" } });
  });

  it("la constante sigue en false y no hay forma de pasarle otra al resolutor desde la aplicación", async () => {
    const cfg = await import("@/services/media-retention-config");
    expect(cfg.RETENTION_APPLY_ENABLED).toBe(false);
    expect(m.configuredRetentionMode.length).toBe(1);
    expect(m.configuredRetentionMode(APPLY_ENV)).toBe("DRY_RUN");
  });

  it("BUSY no ejecuta retención ni detección", async () => {
    arrange({ acquire: { status: "BUSY", reason: "LEASE_HELD" } });
    vi.stubEnv("MEDIA_RETENTION_MODE", "APPLY");
    expect(await m.mediaReconcileRunner.run()).toEqual({ outcome: "BUSY", reason: "LEASE_HELD" });
    expect(retentionRun).not.toHaveBeenCalled();
  });

  it("LEASE_LOST de la retención conserva su comportamiento (sin detección ni finishWith)", async () => {
    const svc = arrange();
    retentionRun.mockResolvedValue(ret.emptyRetentionResult("LEASE_LOST", ["retention/LEASE_LOST"]));
    const res = await m.mediaReconcileRunner.run();
    expect(res).toMatchObject({ outcome: "LEASE_LOST" });
    expect(detectMock).not.toHaveBeenCalled();
    expect(svc.finishWith).not.toHaveBeenCalled();
    expect(modePassed()).toBe("DRY_RUN");
  });

  it("detección INCOMPLETE y FAILED conservan su cierre; el modo sigue siendo DRY_RUN", async () => {
    const svc = arrange();
    detectMock.mockResolvedValueOnce({ report: { complete: false, inventoryStatus: "INCOMPLETE", errors: [] }, candidates: [] });
    expect(await m.mediaReconcileRunner.run()).toMatchObject({ outcome: "INCOMPLETE", finalized: true });
    detectMock.mockRejectedValueOnce(new Error("https://res.cloudinary.com/x ai-wardrobe/u/y"));
    retentionRun.mockClear();
    const failed = await m.mediaReconcileRunner.run();
    expect(failed).toMatchObject({ outcome: "FAILED", errorCodes: ["detect/INTERNAL"] });
    expect(JSON.stringify(failed)).not.toMatch(/cloudinary|ai-wardrobe\//);
    expect(modePassed()).toBe("DRY_RUN");
    expect(svc.release).toHaveBeenCalledTimes(2);
  });

  it("no se filtran valores de configuración en el resultado ni en los logs", async () => {
    arrange();
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const [k, v] of Object.entries(APPLY_ENV)) vi.stubEnv(k, v);
    retentionRun.mockResolvedValue(ret.emptyRetentionResult("STOPPED", ["retention/DEADLOCK"]));
    const res = await m.mediaReconcileRunner.run();
    const text = JSON.stringify(res) + err.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).not.toMatch(/apply-media-retention-policy-v1|MEDIA_RETENTION_APPLY_CONFIRM|run-secreto|987654/);
    expect(text).not.toMatch(/"mode":"APPLY"/);
  });
});
