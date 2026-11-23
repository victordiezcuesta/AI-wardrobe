import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setTestEnv } from "../helpers/mock-prisma";

/**
 * Fase 19.9e — GET /api/cron/media-reconcile (detector de solo lectura) con detector y autenticación SIMULADOS (sin
 * Cloudinary ni PostgreSQL): el cuerpo pasa por publicReport (lista blanca de campos y de códigos, fechas ISO estrictas).
 */
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
const auth = vi.hoisted(() => ({ ok: true }));
vi.mock("@/lib/auth/cron", () => ({ isAuthorizedCron: () => auth.ok }));
const detect = vi.hoisted(() => vi.fn());
vi.mock("@/services/media-reconcile.service", async (orig) => ({ ...(await orig<object>()), detectOrphanMedia: (...a: unknown[]) => detect(...a) }));

let route: typeof import("@/app/api/cron/media-reconcile/route");
let svc: typeof import("@/services/media-reconcile.service");
beforeAll(async () => { setTestEnv(); route = await import("@/app/api/cron/media-reconcile/route"); svc = await import("@/services/media-reconcile.service"); });
let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { auth.ok = true; detect.mockReset(); errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined); });
afterEach(() => { errSpy.mockRestore(); });

const SECRETS = /ai-wardrobe\/|https?:|cloudinary\.com|user-secret|asset-secreto|hunter2|ECONNREFUSED|stack|fencingToken|run-secreto/i;
const U = "internal/UNKNOWN_CODE";
const report = (errors: unknown = [], extra: object = {}) => ({
  startedAt: "2026-11-20T10:00:00.123Z", durationMs: 1234, complete: false, inventoryStatus: "INCOMPLETE",
  inventoryComplete: { upload: true, authenticated: false }, graceHours: 24, pages: { upload: 3, authenticated: 2 }, resourcesExamined: 17,
  byKind: { wardrobe: 5, personal: 4, tryOn: 3, unknown: 2, quarantine: 1 },
  byCategory: { REFERENCED: 6, ORPHAN_CANDIDATE: 2, TOO_RECENT: 3, UNKNOWN: 2, INCOMPLETE: 3, QUARANTINED: 1 },
  candidatesWithheld: 1, orphanDetail: { ownerMissing: 1, personalCitedOnlyBySourcePhoto: 2 },
  protection: { referencedByUrlOnly: 2, ambiguousUrl: 1, missingMetadata: 3 }, quarantine: { wardrobe: 1, personal: 0, tryOn: 0, publicDelivery: 1 },
  metadata: { assetId: 15, version: 14, createdAt: 16, bytes: 13, format: 12 },
  urlReferences: { scanned: 40, own: 10, ownOutsidePrefix: 1, external: 28, ambiguous: 1 },
  brokenReferences: { total: 4, wardrobe: 1, personal: 2, tryOn: 1 }, referencesOutsidePrefix: 0,
  rateLimit: { allowed: 500, remaining: 120, resetAt: "2026-11-20T11:00:00.000Z" }, errors, ...extra,
});
const call = (headers: Record<string, string> = {}) => route.GET(new Request("http://localhost:3000/api/cron/media-reconcile?prefix=otra/&graceMs=0", { headers }));

describe("autenticación y contrato de estado", () => {
  it("sin autorización → 401 y no se llama al detector", async () => {
    auth.ok = false;
    const r = await call();
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: { code: "UNAUTHORIZED", message: "No autorizado" } });
    expect(detect).not.toHaveBeenCalled();
  });
  it("autorizado → 200; el detector recibe solo el presupuesto fijo (los parámetros de la URL se ignoran)", async () => {
    detect.mockResolvedValue(report());
    const r = await call({ authorization: "Bearer x" });
    expect(r.status).toBe(200);
    expect(detect).toHaveBeenCalledTimes(1);
    expect(detect).toHaveBeenCalledWith({ budgetMs: svc.DEFAULT_BUDGET_MS });
  });
  it("error inesperado del detector → 500 genérico, sin mensaje ni datos internos", async () => {
    detect.mockRejectedValue(new Error("fallo con ai-wardrobe/user-secret-42/wardrobe/x https://res.cloudinary.com/x"));
    const r = await call();
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: { code: "INTERNAL", message: "Error interno" } });
  });
});

describe("cuerpo = informe proyectado", () => {
  it("un informe legítimo sale idéntico (mismas claves y valores): el contrato no cambia", async () => {
    const legit = report([{ stage: "inventory", scope: "upload", code: "CLOUDINARY_420" }, { stage: "database", scope: "owners", code: "QUERY_TIMEOUT" }, { stage: "database", scope: "urls", code: "P2024" }]);
    detect.mockResolvedValue(legit);
    const body = await (await call()).json();
    expect(body).toEqual(legit);
    expect(Object.keys(body).sort()).toEqual(Object.keys(legit).sort());
  });
  it("report.errors[].code: desconocidos y cadenas maliciosas → internal/UNKNOWN_CODE; stage y scope válidos se conservan", async () => {
    detect.mockResolvedValue(report([
      { stage: "inventory", scope: "upload", code: "https://res.cloudinary.com/demo/image/upload/x.jpg" },
      { stage: "inventory", scope: "authenticated", code: "ai-wardrobe/user-secret-42/wardrobe/foto" },
      { stage: "database", scope: "owners", code: "Error: connect ECONNREFUSED 10.0.0.5:5432" },
      { stage: "database", scope: "urls", code: "P2028-extra" }, { stage: "inventory", scope: "upload", code: "CLOUDINARY_999" },
      { stage: "database", scope: "wardrobe", code: "P2028" }, { stage: "inventory", scope: "upload", code: "CLOUDINARY_429" },
    ]));
    const body = await (await call()).json() as { errors: { stage: string; scope: string; code: string }[] };
    expect(body.errors.map((e) => e.code)).toEqual([U, U, U, U, U, "P2028", "CLOUDINARY_429"]);
    expect(body.errors.map((e) => [e.stage, e.scope])).toEqual([["inventory", "upload"], ["inventory", "authenticated"], ["database", "owners"], ["database", "urls"], ["inventory", "upload"], ["database", "wardrobe"], ["inventory", "upload"]]);
    expect(JSON.stringify(body)).not.toMatch(SECRETS);
  });
  it("propiedades adicionales (en el informe, en objetos anidados y en errores) no salen", async () => {
    const bad = { publicId: "ai-wardrobe/user-secret-42/wardrobe/foto", url: "https://res.cloudinary.com/x/a.jpg", ownerUserId: "user-secret-42", assetId: "asset-secreto", stack: "at x", password: "hunter2", fencingToken: 987654, runId: "run-secreto" };
    const raw = report([{ stage: "inventory", scope: "upload", code: "TIME_BUDGET", ...bad }], { ...bad, candidates: [{ publicId: "ai-wardrobe/user-secret-42/wardrobe/foto" }] }) as Record<string, unknown>;
    for (const k of ["inventoryComplete", "pages", "byKind", "byCategory", "orphanDetail", "protection", "quarantine", "metadata", "urlReferences", "brokenReferences", "rateLimit"]) Object.assign(raw[k] as object, bad);
    detect.mockResolvedValue(raw);
    const body = await (await call()).json() as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toMatch(SECRETS);
    expect(Object.keys(body).sort()).toEqual(Object.keys(report()).sort());
    expect(body).not.toHaveProperty("candidates");
    expect(Object.keys((body.errors as object[])[0]!).sort()).toEqual(["code", "scope", "stage"]);
  });
  it("fechas no ISO UTC en startedAt y rateLimit.resetAt → neutros", async () => {
    detect.mockResolvedValue(report([], { startedAt: "https://x/ai-wardrobe/u", rateLimit: { allowed: 1, remaining: 0, resetAt: "2026-11-20T11:00:00+02:00" } }));
    const body = await (await call()).json() as { startedAt: string; rateLimit: { resetAt: string | null } };
    expect(body.startedAt).toBe("");
    expect(body.rateLimit.resetAt).toBeNull();
  });
  it("el informe original que devuelve el detector no se modifica", async () => {
    const raw = report([{ stage: "inventory", scope: "upload", code: "https://x" }], { publicId: "ai-wardrobe/u/x" });
    const snapshot = JSON.stringify(raw);
    detect.mockResolvedValue(raw);
    await call();
    expect(JSON.stringify(raw)).toBe(snapshot);
  });
  it("el informe es el único contenido: sin envoltorio ni campos nuevos", async () => {
    detect.mockResolvedValue(report());
    const body = await (await call()).json() as Record<string, unknown>;
    expect(Object.keys(body)).not.toContain("report");
    expect(Object.keys(body)).not.toContain("errorCodes");
    expect(body).toMatchObject({ complete: false, resourcesExamined: 17, graceHours: 24, byCategory: { ORPHAN_CANDIDATE: 2 } });
  });
});
