import { beforeAll, describe, expect, it, vi } from "vitest";
import { setTestEnv } from "../helpers/mock-prisma";

/** Fase 19.9d — lista blanca de los códigos de error generales y de report.errors[].code en la respuesta HTTP. */
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
const runMock = vi.fn();
vi.mock("@/lib/auth/cron", () => ({ isAuthorizedCron: () => true }));

type Pub = typeof import("@/services/media-reconcile-public");
type Run = typeof import("@/services/media-reconcile-run.service");
let pub: Pub; let run: Run; let GET: (req: Request) => Promise<Response>;
let asset: typeof import("@/services/media-asset.service"); let lease: typeof import("@/services/media-lease.service");
beforeAll(async () => {
  setTestEnv();
  run = await import("@/services/media-reconcile-run.service");
  vi.doMock("@/services/media-reconcile-run.service", () => ({ ...run, mediaReconcileRunner: { run: runMock } }));
  pub = await import("@/services/media-reconcile-public");
  asset = await import("@/services/media-asset.service");
  lease = await import("@/services/media-lease.service");
  GET = (await import("@/app/api/cron/media-reconcile/run/route")).GET as never;
});

const U = "internal/UNKNOWN_CODE";
const SECRETS = /ai-wardrobe\/|https?:|cloudinary\.com|asset-secreto|user-secret|SELECT |password|stack/i;
const STATIC = [
  "TRUNCATED", "budget/TIME_EXHAUSTED", "detect/INTERNAL", "detect/INCOMPLETE", "db/DB_ERROR",
  "persist/INVALID_ARGUMENT", "persist/INCOMPLETE_DETECTION", "persist/TOO_MANY_CANDIDATES", "persist/RUN_NOT_ACTIVE", "persist/STALE_RUN",
  "persist/CONCURRENT_MODIFICATION", "persist/INTERNAL",
  "lease/INVALID_ARGUMENT", "lease/LOCK_UNAVAILABLE", "lease/LOCK_TIMEOUT", "lease/TOKEN_EXHAUSTED", "lease/LEASE_LOST",
  "retention/LOCK_TIMEOUT", "retention/LEASE_ERROR", "retention/LEASE_LOST", "retention/DEADLOCK", "retention/QUERY_TIMEOUT",
  "retention/FK_VIOLATION", "retention/TX_TIMEOUT", "retention/DB_ERROR", "retention/INTERNAL",
];
const INV = ["TIME_BUDGET", "PAGE_LIMIT", "MALFORMED_PAGE", "BAD_CURSOR", "MALFORMED_RESOURCE", "UNEXPECTED_RESOURCE", "CLOUDINARY_ERROR"];

describe("códigos exactos", () => {
  it.each(STATIC)("%s pasa tal cual", (c) => { expect(pub.publicErrorCodes([c])).toEqual([c]); });
  it("inventory/* y database/*: todas las combinaciones reales ámbito × código", () => {
    for (const s of ["upload", "authenticated"]) for (const c of [...INV, "CLOUDINARY_420"]) expect(pub.publicErrorCodes([`inventory/${s}/${c}`])).toEqual([`inventory/${s}/${c}`]);
    for (const s of ["wardrobe", "personal", "try-on", "sourcePhoto", "owners", "urls"]) for (const c of ["QUERY_TIMEOUT", "DB_ERROR", "P2010"]) expect(pub.publicErrorCodes([`database/${s}/${c}`])).toEqual([`database/${s}/${c}`]);
  });
  it("cubre lo que producen de verdad classifyFailure y reportErrorCodes", () => {
    const assetCodes = ["INVALID_ARGUMENT", "INCOMPLETE_DETECTION", "TOO_MANY_CANDIDATES", "RUN_NOT_ACTIVE", "STALE_RUN", "CONCURRENT_MODIFICATION"] as const;
    for (const c of assetCodes) expect(pub.isPublicErrorCode(run.classifyFailure(new asset.MediaAssetError(c), "persist"))).toBe(true);
    for (const c of ["INVALID_ARGUMENT", "LOCK_UNAVAILABLE", "LOCK_TIMEOUT", "TOKEN_EXHAUSTED"] as const) expect(pub.isPublicErrorCode(run.classifyFailure(new lease.MediaLeaseError(c), "persist"))).toBe(true);
    for (const stage of ["detect", "persist"] as const) expect(pub.isPublicErrorCode(run.classifyFailure(new Error("ai-wardrobe/u/x"), stage))).toBe(true);
    expect(pub.isPublicErrorCode(run.classifyFailure({ name: "PrismaClientKnownRequestError", code: "P2028" }, "persist"))).toBe(true);
    expect(pub.isPublicErrorCode(run.classifyFailure({ name: "PrismaClientValidationError" }, "persist"))).toBe(true); // db/DB_ERROR
    const rep = { errors: [{ stage: "inventory", scope: "upload", code: "CLOUDINARY_429" }, { stage: "database", scope: "owners", code: "QUERY_TIMEOUT" }, { stage: "database", scope: "urls", code: "P2024" }] };
    for (const c of run.reportErrorCodes(rep as never)) expect(pub.isPublicErrorCode(c)).toBe(true);
    expect(pub.isPublicErrorCode(run.reportErrorCodes({ errors: [] } as never)[0])).toBe(true); // detect/INCOMPLETE
    expect(pub.isPublicErrorCode(run.TIME_EXHAUSTED)).toBe(true);
  });
});

describe("familias acotadas", () => {
  it.each(["db/P2010", "db/P2028", "db/P1001", "db/P0000", "db/P9999"])("acepta %s", (c) => { expect(pub.publicErrorCodes([c])).toEqual([c]); });
  it.each(["db/P20", "db/P20280", "db/P2028-extra", "db/P2028 ", " db/P2028", "db/p2028", "db/P202８", "db/P-228", "db/P2.28", "db/P", "db/", "db/P2028\n", "db/P2028/x"])(
    "rechaza %j", (c) => { expect(pub.publicErrorCodes([c])).toEqual([U]); });
  it.each([100, 400, 420, 429, 503, 599])("acepta CLOUDINARY_%i", (n) => { const c = `inventory/upload/CLOUDINARY_${n}`; expect(pub.publicErrorCodes([c])).toEqual([c]); });
  it.each(["CLOUDINARY_99", "CLOUDINARY_600", "CLOUDINARY_000", "CLOUDINARY_1000", "CLOUDINARY_4.2", "CLOUDINARY_-42", "CLOUDINARY_+42", "CLOUDINARY_420x",
    "CLOUDINARY_ 420", "CLOUDINARY_NaN", "CLOUDINARY_Infinity", "CLOUDINARY_1e3", "CLOUDINARY_42０", "cloudinary_420"])("rechaza inventory/upload/%s", (c) => {
    expect(pub.publicErrorCodes([`inventory/upload/${c}`])).toEqual([U]);
  });
  it("CLOUDINARY_<http> y P#### solo valen en la etapa que los genera", () => {
    expect(pub.publicErrorCodes(["database/owners/CLOUDINARY_420", "inventory/upload/P2010", "database/owners/TIME_BUDGET", "inventory/upload/QUERY_TIMEOUT"])).toEqual([U]);
    expect(pub.publicErrorCodes(["CLOUDINARY_420", "P2010", "inventory/CLOUDINARY_420"])).toEqual([U]);
  });
  it("ámbito o etapa ajenos → desconocido", () => {
    expect(pub.publicErrorCodes(["inventory/private/TIME_BUDGET", "database/users/DB_ERROR", "storage/upload/TIME_BUDGET", "inventory/upload", "inventory/upload/TIME_BUDGET/x"])).toEqual([U]);
  });
});

describe("valores no autorizados", () => {
  it.each([
    ["mensaje de excepción", "Error: connect ECONNREFUSED 10.0.0.5:5432"], ["URL https", "https://res.cloudinary.com/demo/image/upload/x.jpg"],
    ["URL http", "http://evil.test/a"], ["publicId", "ai-wardrobe/user-secret-42/wardrobe/foto"], ["ruta", "/var/task/.next/server/chunk.js"],
    ["SQL", 'SELECT * FROM "User" WHERE password = $1'], ["SQLSTATE", "40P01"], ["asset id", "asset-secreto-123"], ["vacío", ""], ["con espacios", "lease/LOCK_TIMEOUT "],
    ["prefijo válido + sufijo", "lease/LOCK_TIMEOUT/ai-wardrobe/u"], ["minúsculas", "lease/lock_timeout"], ["retention no autorizado", "retention/NOPE"],
    ["retention/UNKNOWN_CODE (solo de la vista de retención)", "retention/UNKNOWN_CODE"], ["prototipo", "__proto__"], ["constructor", "constructor"],
  ])("%s → internal/UNKNOWN_CODE", (_n, v) => {
    const out = pub.publicErrorCodes([v]);
    expect(out).toEqual([U]);
    expect(JSON.stringify(out)).not.toMatch(SECRETS);
  });
  it("elementos no string y entradas que no son array nunca pasan a texto público", () => {
    expect(pub.publicErrorCodes([null, undefined, 5, {}, ["lease/LOCK_TIMEOUT"], true, Symbol("x"), () => "x", { toString: () => "lease/LOCK_TIMEOUT" }, new String("lease/LOCK_TIMEOUT")])).toEqual([U]);
    for (const v of [undefined, null, "lease/LOCK_TIMEOUT", 3, {}, { length: 1, 0: "lease/LOCK_TIMEOUT" }]) expect(pub.publicErrorCodes(v)).toEqual([]);
  });
});

describe("duplicados, orden y límite", () => {
  it("deduplica y conserva el orden de primera aparición; los ajenos colapsan en uno, donde apareció el primero", () => {
    expect(pub.publicErrorCodes(["lease/LOCK_TIMEOUT", "x", "retention/DEADLOCK", "lease/LOCK_TIMEOUT", "y", "persist/STALE_RUN", "retention/DEADLOCK"]))
      .toEqual(["lease/LOCK_TIMEOUT", U, "retention/DEADLOCK", "persist/STALE_RUN"]);
  });
  it("máximo 64: 63 primeros + TRUNCATED (nunca más de 64, ni TRUNCATED duplicado)", () => {
    const many = Array.from({ length: 200 }, (_, i) => `db/P${String(1000 + i).padStart(4, "0")}`);
    const out = pub.publicErrorCodes([...many, "TRUNCATED"]);
    expect(out).toHaveLength(64);
    expect(out.slice(0, 63)).toEqual(many.slice(0, 63));
    expect(out.at(-1)).toBe("TRUNCATED");
    expect(out.filter((c) => c === "TRUNCATED")).toHaveLength(1);
    expect(pub.publicErrorCodes(many.slice(0, 64))).toHaveLength(64); // 64 exactos: sin recorte
    expect(pub.publicErrorCodes(Array.from({ length: 500 }, (_, i) => `x${i}`))).toEqual([U]);
  });
  it("entrada enorme de valores raros no revienta ni crece", () => {
    expect(pub.publicErrorCodes(Array.from({ length: 5000 }, (_, i) => (i % 2 ? i : `https://x/${i}`)))).toEqual([U]);
  });
});

/** Informe completo y legítimo (todas las propiedades de MediaReconcileReport). */
const fullReport = (errors: unknown = []) => ({
  startedAt: "2026-11-20T10:00:00.123Z", durationMs: 1234, complete: false, inventoryStatus: "INCOMPLETE",
  inventoryComplete: { upload: true, authenticated: false }, graceHours: 24, pages: { upload: 3, authenticated: 2 }, resourcesExamined: 17,
  byKind: { wardrobe: 5, personal: 4, tryOn: 3, unknown: 2, quarantine: 1 },
  byCategory: { REFERENCED: 6, ORPHAN_CANDIDATE: 2, TOO_RECENT: 3, UNKNOWN: 2, INCOMPLETE: 3, QUARANTINED: 1 },
  candidatesWithheld: 1, orphanDetail: { ownerMissing: 1, personalCitedOnlyBySourcePhoto: 2 },
  protection: { referencedByUrlOnly: 2, ambiguousUrl: 1, missingMetadata: 3 }, quarantine: { wardrobe: 1, personal: 0, tryOn: 0, publicDelivery: 1 },
  metadata: { assetId: 15, version: 14, createdAt: 16, bytes: 13, format: 12 },
  urlReferences: { scanned: 40, own: 10, ownOutsidePrefix: 1, external: 28, ambiguous: 1 },
  brokenReferences: { total: 4, wardrobe: 1, personal: 2, tryOn: 1 }, referencesOutsidePrefix: 0,
  rateLimit: { allowed: 500, remaining: 120, resetAt: "2026-11-20T11:00:00.000Z" }, errors,
}) as never;
const KEYS = {
  top: ["byCategory", "byKind", "brokenReferences", "candidatesWithheld", "complete", "durationMs", "errors", "graceHours", "inventoryComplete", "inventoryStatus",
    "metadata", "orphanDetail", "pages", "protection", "quarantine", "rateLimit", "referencesOutsidePrefix", "resourcesExamined", "startedAt", "urlReferences"].sort(),
  inventoryComplete: ["authenticated", "upload"], pages: ["authenticated", "upload"], byKind: ["personal", "quarantine", "tryOn", "unknown", "wardrobe"],
  byCategory: ["INCOMPLETE", "ORPHAN_CANDIDATE", "QUARANTINED", "REFERENCED", "TOO_RECENT", "UNKNOWN"], orphanDetail: ["ownerMissing", "personalCitedOnlyBySourcePhoto"],
  protection: ["ambiguousUrl", "missingMetadata", "referencedByUrlOnly"], quarantine: ["personal", "publicDelivery", "tryOn", "wardrobe"],
  metadata: ["assetId", "bytes", "createdAt", "format", "version"], urlReferences: ["ambiguous", "external", "own", "ownOutsidePrefix", "scanned"],
  brokenReferences: ["personal", "total", "tryOn", "wardrobe"], rateLimit: ["allowed", "remaining", "resetAt"], error: ["code", "scope", "stage"],
};

describe("report.errors[].code", () => {
  const report = fullReport;
  it("sanitiza solo `code`; conserva estructura, stage, scope y los demás campos; no toca el original", () => {
    const errors = [
      { stage: "inventory", scope: "upload", code: "CLOUDINARY_420" }, { stage: "inventory", scope: "authenticated", code: "https://res.cloudinary.com/x" },
      { stage: "database", scope: "owners", code: "P2028" }, { stage: "database", scope: "urls", code: "P2028-extra" }, { stage: "database", scope: "wardrobe", code: "QUERY_TIMEOUT" },
    ];
    const original = report(errors);
    const snapshot = JSON.parse(JSON.stringify(original));
    const out = pub.publicReport(original)!;
    expect(out.errors).toEqual([
      { stage: "inventory", scope: "upload", code: "CLOUDINARY_420" }, { stage: "inventory", scope: "authenticated", code: U },
      { stage: "database", scope: "owners", code: "P2028" }, { stage: "database", scope: "urls", code: U }, { stage: "database", scope: "wardrobe", code: "QUERY_TIMEOUT" },
    ]);
    const { errors: _a, ...restOut } = out; const { errors: _b, ...restIn } = original as unknown as { errors: unknown };
    expect(restOut).toEqual(restIn); // un informe legítimo conserva exactamente los mismos valores
    expect(JSON.parse(JSON.stringify(original))).toEqual(snapshot); // el informe interno no se altera
    expect(out).not.toBe(original);
  });
  it("no deja pasar campos extra, stage/scope no controlados ni elementos malformados", () => {
    const out = pub.publicReport(report([
      { stage: "inventory", scope: "upload", code: "TIME_BUDGET", message: "ai-wardrobe/u/x", url: "https://x" },
      { stage: "storage", scope: "ai-wardrobe/u", code: "TIME_BUDGET" }, { stage: "database", scope: "owners", code: 42 }, null, "ai-wardrobe/x", 7,
    ]))!;
    expect(out.errors[0]).toEqual({ stage: "inventory", scope: "upload", code: "TIME_BUDGET" });
    expect(out.errors).toHaveLength(6);
    expect(JSON.stringify(out.errors)).not.toMatch(SECRETS);
    for (const e of out.errors.slice(1)) expect(e.code).toBe(U);
  });
  it("errors que no es un array → []; sin informe → null", () => {
    expect(pub.publicReport(report("https://x"))!.errors).toEqual([]);
    expect(pub.publicReport(report({ 0: { code: "x" } }))!.errors).toEqual([]);
    expect(pub.publicReport(null)).toBeNull();
    expect(pub.publicReport(undefined)).toBeNull();
  });
});

describe("proyección explícita del informe (19.9d.2)", () => {
  it("claves EXACTAS del informe público y de cada objeto anidado", () => {
    const out = pub.publicReport(fullReport([{ stage: "inventory", scope: "upload", code: "TIME_BUDGET" }]))! as unknown as Record<string, Record<string, unknown>>;
    expect(Object.keys(out).sort()).toEqual(KEYS.top);
    for (const k of ["inventoryComplete", "pages", "byKind", "byCategory", "orphanDetail", "protection", "quarantine", "metadata", "urlReferences", "brokenReferences", "rateLimit"] as const) {
      expect(Object.keys(out[k]!).sort()).toEqual(KEYS[k]);
    }
    expect(Object.keys((out.errors as unknown as object[])[0]!).sort()).toEqual(KEYS.error);
  });
  it("un informe legítimo sale con los mismos valores (contrato HTTP intacto), también con urlReferences y rateLimit nulos", () => {
    const legit = fullReport([{ stage: "database", scope: "owners", code: "QUERY_TIMEOUT" }]);
    expect(pub.publicReport(legit)).toEqual(legit);
    const nulls = { ...(legit as object), urlReferences: null, rateLimit: null, referencesOutsidePrefix: null, brokenReferences: { total: null, wardrobe: null, personal: null, tryOn: null } } as never;
    expect(pub.publicReport(nulls)).toEqual(nulls);
  });
  it("propiedades extra SENSIBLES en el informe y en cada objeto anidado no salen; el original no cambia", () => {
    const bad = { publicId: "ai-wardrobe/user-secret-42/wardrobe/foto", url: "https://res.cloudinary.com/x/a.jpg", ownerUserId: "user-secret-42", assetId: "asset-secreto", stack: "at x (/srv/app.js)", password: "hunter2", fencingToken: 987654, runId: "run-secreto" };
    const rep = fullReport([{ stage: "inventory", scope: "upload", code: "TIME_BUDGET", ...bad }]) as unknown as Record<string, unknown>;
    Object.assign(rep, bad);
    for (const k of ["inventoryComplete", "pages", "byKind", "byCategory", "orphanDetail", "protection", "quarantine", "metadata", "urlReferences", "brokenReferences", "rateLimit"]) Object.assign(rep[k] as object, bad);
    const snapshot = JSON.stringify(rep);
    const out = pub.publicReport(rep as never)!;
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/ai-wardrobe\/|https?:|user-secret|asset-secreto|hunter2|987654|run-secreto|at x|publicId|ownerUserId|fencingToken|runId|password/);
    expect(Object.keys(out).sort()).toEqual(KEYS.top);
    expect(JSON.stringify(rep)).toBe(snapshot); // sin mutar el informe original
    expect((out.byKind as object)).not.toBe(rep.byKind); // objetos nuevos, no referencias al original
    expect((out.errors[0] as object)).not.toBe((rep.errors as object[])[0]);
  });
  it("valores de tipo inesperado en campos permitidos nunca se copian tal cual", () => {
    const rep = fullReport() as unknown as Record<string, unknown>;
    Object.assign(rep, { startedAt: { x: "https://x" }, durationMs: "ai-wardrobe/u", complete: "yes", inventoryStatus: "https://x", graceHours: NaN, resourcesExamined: Infinity });
    rep.byKind = "ai-wardrobe/x"; rep.pages = null; rep.urlReferences = "https://x"; rep.rateLimit = { allowed: "x", remaining: {}, resetAt: 5 };
    (rep.metadata as Record<string, unknown>).assetId = "asset-secreto";
    const out = pub.publicReport(rep as never)! as unknown as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toMatch(/ai-wardrobe|https?:|asset-secreto/);
    expect(out).toMatchObject({ startedAt: "", durationMs: 0, complete: false, inventoryStatus: "INCOMPLETE", graceHours: 0, resourcesExamined: 0, byKind: { wardrobe: 0 }, pages: { upload: 0 } });
    expect(out.rateLimit).toEqual({ allowed: null, remaining: null, resetAt: null });
    expect((out.metadata as Record<string, number>).assetId).toBe(0);
    expect(Object.keys(out).sort()).toEqual(KEYS.top);
  });
  it("sin spread: ningún spread del informe ni de sus objetos anidados, sea cual sea el nombre de la variable", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/services/media-reconcile-public.ts", "utf8");
    // Cuerpo de publicReport (desde su declaración hasta el final del archivo): ni un solo `...`.
    const body = src.slice(src.indexOf("export function publicReport"));
    expect(body.length).toBeGreaterThan(500);
    expect(body).not.toMatch(/\.\.\./);
    // En todo el archivo, el único spread permitido es el de ARRAY de publicErrorCodes (recorte a 64).
    const all = src.match(/\.\.\./g) ?? [];
    expect(all).toHaveLength(1);
    expect(src).toMatch(/return \[\.\.\.out\.filter\(\(c\) => c !== TRUNCATED\)\.slice\(0, MAX_PUBLIC_ERROR_CODES - 1\), TRUNCATED\];/);
    expect(src.indexOf("return [...out.filter")).toBeLessThan(src.indexOf("export function publicReport"));
  });
  describe("fechas ISO UTC estrictas (startedAt y rateLimit.resetAt)", () => {
    const withDates = (startedAt: unknown, resetAt: unknown) => {
      const rep = fullReport() as unknown as Record<string, unknown>;
      rep.startedAt = startedAt; (rep.rateLimit as Record<string, unknown>).resetAt = resetAt;
      const out = pub.publicReport(rep as never)!;
      return { startedAt: out.startedAt, resetAt: out.rateLimit!.resetAt, rep };
    };
    it("las fechas legítimas de Date.toISOString() salen idénticas (cadena exacta)", () => {
      for (const iso of [new Date(0).toISOString(), "2026-11-20T10:00:00.123Z", new Date().toISOString(), "2024-02-29T23:59:59.999Z", new Date(Date.UTC(2099, 11, 31)).toISOString()]) {
        expect(withDates(iso, iso)).toMatchObject({ startedAt: iso, resetAt: iso });
      }
    });
    it("ISO UTC válido sin milisegundos o con fracción distinta también se conserva tal cual", () => {
      for (const iso of ["2026-11-20T10:00:00Z", "2026-11-20T10:00:00.5Z", "2026-11-20T10:00:00.123456Z"]) expect(withDates(iso, iso)).toMatchObject({ startedAt: iso, resetAt: iso });
    });
    it.each([
      ["fecha imposible (30 de febrero)", "2026-02-30T10:00:00.000Z"], ["día 31 de un mes de 30", "2026-04-31T10:00:00.000Z"], ["29 de febrero de un año no bisiesto", "2026-02-29T10:00:00.000Z"],
      ["hora 25", "2026-11-20T25:00:00.000Z"], ["segundos 60", "2026-11-20T10:00:60.000Z"], ["año anterior a 1970", "1969-12-31T23:59:59.000Z"],
      ["texto arbitrario", "ai-wardrobe/user-secret-42/wardrobe/foto"], ["URL", "https://res.cloudinary.com/x"], ["mensaje", "Error: connect ECONNREFUSED 10.0.0.5:5432"],
      ["sin zona horaria", "2026-11-20T10:00:00.000"], ["solo fecha", "2026-11-20"], ["offset +00:00", "2026-11-20T10:00:00.000+00:00"], ["offset +02:00", "2026-11-20T12:00:00.000+02:00"],
      ["offset -05:00", "2026-11-20T05:00:00.000-05:00"], ["z minúscula", "2026-11-20T10:00:00.000z"], ["con espacios", " 2026-11-20T10:00:00.000Z"], ["espacio final", "2026-11-20T10:00:00.000Z "],
      ["salto de línea final", "2026-11-20T10:00:00.000Z\n"], ["separador con espacio", "2026-11-20 10:00:00.000Z"], ["sufijo", "2026-11-20T10:00:00.000Zextra"],
      ["prefijo", "x2026-11-20T10:00:00.000Z"], ["dígitos de ancho completo", "２０２６-11-20T10:00:00.000Z"], ["epoch como texto", "1700000000000"], ["vacío", ""],
      ["fracción de más de 9 dígitos", "2026-11-20T10:00:00.1234567890Z"],
    ])("rechaza %s", (_n, v) => {
      expect(withDates(v, v)).toMatchObject({ startedAt: "", resetAt: null });
      const { startedAt, resetAt } = withDates(v, v); // solo la SALIDA (rep es la entrada)
      expect(JSON.stringify({ startedAt, resetAt })).not.toMatch(/user-secret|https?:|ECONNREFUSED/);
    });
    it("número, objeto, array, null, undefined y Date nunca pasan (neutros: \"\" y null)", () => {
      for (const v of [1700000000000, {}, { toISOString: () => "2026-11-20T10:00:00.000Z" }, ["2026-11-20T10:00:00.000Z"], null, undefined, true, new Date("2026-11-20T10:00:00.000Z"), new String("2026-11-20T10:00:00.000Z")]) {
        expect(withDates(v, v)).toMatchObject({ startedAt: "", resetAt: null });
      }
    });
    it("resetAt null legítimo sigue null y un startedAt inválido no afecta a un resetAt válido (y viceversa)", () => {
      expect(withDates("2026-11-20T10:00:00.000Z", null)).toMatchObject({ startedAt: "2026-11-20T10:00:00.000Z", resetAt: null });
      expect(withDates("basura", "2026-11-20T11:00:00.000Z")).toMatchObject({ startedAt: "", resetAt: "2026-11-20T11:00:00.000Z" });
      expect(withDates("2026-11-20T10:00:00.000Z", "basura")).toMatchObject({ startedAt: "2026-11-20T10:00:00.000Z", resetAt: null });
    });
    it("el informe original no se modifica", () => {
      const { rep } = withDates("basura", "https://x");
      expect(rep.startedAt).toBe("basura");
      expect((rep.rateLimit as Record<string, unknown>).resetAt).toBe("https://x");
    });
  });
});

describe("retention.errorCodes conserva su lista y comportamiento", () => {
  it("publicRetentionErrorCodes sigue devolviendo retention/UNKNOWN_CODE para lo ajeno (no internal/UNKNOWN_CODE)", async () => {
    const r = await import("@/services/media-retention-public");
    expect(r.publicRetentionErrorCodes(["retention/DEADLOCK", "lease/LOCK_TIMEOUT", "x"])).toEqual(["retention/DEADLOCK", "retention/UNKNOWN_CODE"]);
    expect([...r.PUBLIC_RETENTION_ERROR_CODES]).toHaveLength(9);
  });
});

describe("respuesta HTTP", () => {
  const ret = async (codes: string[]) => (await import("@/services/media-retention.service")).emptyRetentionResult("STOPPED", codes);
  it("errorCodes y report.errors saneados; retention.errorCodes con su propia lista; el resto de campos intactos; el original no se muta", async () => {
    const original = {
      outcome: "INCOMPLETE", finalized: true, persisted: null,
      errorCodes: ["inventory/upload/CLOUDINARY_420", "Error: ECONNREFUSED 10.0.0.5", "db/P2028", "retention/DEADLOCK", "https://res.cloudinary.com/x"],
      report: fullReport([{ stage: "inventory", scope: "upload", code: "CLOUDINARY_420" }, { stage: "inventory", scope: "upload", code: "ai-wardrobe/u/x", message: "https://x" }]),
      retention: await ret(["retention/DEADLOCK", "https://x/ai-wardrobe/u"]),
    };
    const before = JSON.stringify(original);
    runMock.mockResolvedValueOnce(original);
    const res = await GET(new Request("http://localhost/api/cron/media-reconcile/run"));
    const body = await res.json() as Record<string, unknown> & { report: { errors: unknown[]; complete: boolean }; retention: { errorCodes: string[] } };
    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["errorCodes", "finalized", "outcome", "persisted", "report", "retention"]);
    expect(body.errorCodes).toEqual(["inventory/upload/CLOUDINARY_420", U, "db/P2028", "retention/DEADLOCK"]);
    expect(body.report.errors).toEqual([{ stage: "inventory", scope: "upload", code: "CLOUDINARY_420" }, { stage: "inventory", scope: "upload", code: U }]);
    expect(body.report.complete).toBe(false);
    expect(body.retention.errorCodes).toEqual(["retention/DEADLOCK", "retention/UNKNOWN_CODE"]);
    expect(JSON.stringify(body)).not.toMatch(SECRETS);
    expect(JSON.stringify(original)).toBe(before); // los códigos internos siguen intactos (logs, persistencia, diagnóstico)
  });
  it("FAILED (500) con códigos internos y BUSY (sin campos nuevos)", async () => {
    runMock.mockResolvedValueOnce({ outcome: "FAILED", finalized: true, report: null, persisted: null, errorCodes: ["persist/STALE_RUN"], retention: null });
    const r = await GET(new Request("http://localhost/x"));
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ outcome: "FAILED", finalized: true, errorCodes: ["persist/STALE_RUN"], persisted: null, report: null, retention: null });
    runMock.mockResolvedValueOnce({ outcome: "BUSY", reason: "LEASE_HELD" });
    expect(await (await GET(new Request("http://localhost/x"))).json()).toEqual({ outcome: "BUSY", reason: "LEASE_HELD" });
  });
});

describe("la sanitización está solo en la frontera HTTP", () => {
  it("el orquestador sigue produciendo y registrando los códigos originales", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("src/services/media-reconcile-run.service.ts", "utf8")).not.toMatch(/media-reconcile-public|publicErrorCodes|UNKNOWN_CODE/);
    expect(readFileSync("src/services/media-reconcile.service.ts", "utf8")).not.toMatch(/media-reconcile-public|publicReport|UNKNOWN_CODE/);
  });
});
