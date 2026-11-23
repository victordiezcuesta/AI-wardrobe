import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  RETENTION_APPLY_CONFIRMATION, RETENTION_APPLY_ENABLED, RETENTION_APPLY_ENVIRONMENT, RETENTION_ENV_VARS, resolveRetentionMode,
} from "@/services/media-retention-config";

/** Fase 19.8b-1 — resolutor del modo de retención: solo la combinación EXACTA y completa permite APPLY. */
const OK = { MEDIA_RETENTION_MODE: "APPLY", MEDIA_RETENTION_APPLY_CONFIRM: RETENTION_APPLY_CONFIRMATION, VERCEL_ENV: "production" };
const without = (k: keyof typeof OK) => { const e: Record<string, string> = { ...OK }; delete e[k]; return e; };

describe("constantes", () => {
  it("la constante real de la aplicación sigue DESACTIVADA", () => {
    expect(RETENTION_APPLY_ENABLED).toBe(false);
    const src = readFileSync("src/services/media-retention-config.ts", "utf8");
    expect(src).toMatch(/export const RETENTION_APPLY_ENABLED: boolean = false;/);
  });
  it("frase de confirmación versionada y sin aspecto de secreto; entorno autorizado: production; nombres de variables", () => {
    expect(RETENTION_APPLY_CONFIRMATION).toBe("apply-media-retention-policy-v1");
    expect(RETENTION_APPLY_CONFIRMATION).toMatch(/policy-v\d+$/);
    expect(RETENTION_APPLY_ENVIRONMENT).toBe("production");
    expect(RETENTION_ENV_VARS).toEqual({ mode: "MEDIA_RETENTION_MODE", confirm: "MEDIA_RETENTION_APPLY_CONFIRM", environment: "VERCEL_ENV" });
  });
  it("la función es pura: no lee process.env ni contiene SQL o escrituras", () => {
    const src = readFileSync("src/services/media-retention-config.ts", "utf8").replace(/^\s*(\*|\/\/).*$/gm, "");
    expect(src).not.toMatch(/process\.env|import\s/);
    expect(src).not.toMatch(/\b(DELETE|INSERT|UPDATE|TRUNCATE|\$queryRaw|\$executeRaw|prisma)\b/i);
  });
});

describe("combinación exacta", () => {
  it("enabled=true + las tres variables exactas → APPLY", () => {
    expect(resolveRetentionMode(OK, true)).toEqual({ mode: "APPLY", valid: true, reason: null });
  });
  it("enabled=false con todo correcto → DRY_RUN (APPLY_DISABLED_IN_CODE); también con la constante real", () => {
    expect(resolveRetentionMode(OK, false)).toEqual({ mode: "DRY_RUN", valid: true, reason: "APPLY_DISABLED_IN_CODE" });
    expect(resolveRetentionMode(OK, RETENTION_APPLY_ENABLED)).toMatchObject({ mode: "DRY_RUN", reason: "APPLY_DISABLED_IN_CODE" });
  });
  it("enabled solo vale con true estricto (no valores «verdaderos»)", () => {
    for (const en of ["true", 1, "1", {}, [], undefined, null, "yes"]) {
      expect(resolveRetentionMode(OK, en)).toMatchObject({ mode: "DRY_RUN", reason: "APPLY_DISABLED_IN_CODE" });
    }
  });
});

describe("configuración ausente o parcial", () => {
  it("todas ausentes → DRY_RUN por defecto (válida)", () => {
    expect(resolveRetentionMode({}, true)).toEqual({ mode: "DRY_RUN", valid: true, reason: "MODE_NOT_SET" });
  });
  it.each([
    ["MEDIA_RETENTION_MODE", "CONFIRM_WITHOUT_APPLY"],
    ["MEDIA_RETENTION_APPLY_CONFIRM", "CONFIRM_MISSING"],
    ["VERCEL_ENV", "ENVIRONMENT_NOT_AUTHORIZED"],
  ] as const)("falta solo %s → DRY_RUN (%s)", (k, reason) => {
    expect(resolveRetentionMode(without(k), true)).toEqual({ mode: "DRY_RUN", valid: false, reason });
  });
  it("MODE=DRY_RUN exacto → DRY_RUN válido; con confirmación sobrante → inválido", () => {
    expect(resolveRetentionMode({ MEDIA_RETENTION_MODE: "DRY_RUN" }, true)).toEqual({ mode: "DRY_RUN", valid: true, reason: "MODE_DRY_RUN" });
    expect(resolveRetentionMode({ ...OK, MEDIA_RETENTION_MODE: "DRY_RUN" }, true)).toEqual({ mode: "DRY_RUN", valid: false, reason: "CONFIRM_WITHOUT_APPLY" });
  });
});

describe("valores no exactos (nunca se normalizan)", () => {
  it.each(["", " ", "APPLY ", " APPLY", "APPLY\n", "\tAPPLY", "apply", "Apply", "APPLIED", "APPLY_NOW", "true", "1", "DRY_RUN ", "dry_run"])(
    "MEDIA_RETENTION_MODE=%j → DRY_RUN (MODE_INVALID)", (v) => {
      expect(resolveRetentionMode({ ...OK, MEDIA_RETENTION_MODE: v }, true)).toEqual({ mode: "DRY_RUN", valid: false, reason: "MODE_INVALID" });
    });
  it.each(["", " ", ` ${RETENTION_APPLY_CONFIRMATION}`, `${RETENTION_APPLY_CONFIRMATION} `, `${RETENTION_APPLY_CONFIRMATION}\n`,
    RETENTION_APPLY_CONFIRMATION.toUpperCase(), "apply-media-retention-policy-v2", "apply-media-retention-policy", "yes", "APPLY"])(
    "MEDIA_RETENTION_APPLY_CONFIRM=%j → DRY_RUN (CONFIRM_INVALID)", (v) => {
      expect(resolveRetentionMode({ ...OK, MEDIA_RETENTION_APPLY_CONFIRM: v }, true)).toEqual({ mode: "DRY_RUN", valid: false, reason: "CONFIRM_INVALID" });
    });
  it.each(["", "preview", "development", "Production", "PRODUCTION", " production", "production ", "prod", "test"])(
    "VERCEL_ENV=%j → DRY_RUN (ENVIRONMENT_NOT_AUTHORIZED)", (v) => {
      expect(resolveRetentionMode({ ...OK, VERCEL_ENV: v }, true)).toEqual({ mode: "DRY_RUN", valid: false, reason: "ENVIRONMENT_NOT_AUTHORIZED" });
    });
  it("valores que no son texto → nunca APPLY", () => {
    for (const v of [1, true, null, ["APPLY"], { toString: () => "APPLY" }]) {
      expect(resolveRetentionMode({ ...OK, MEDIA_RETENTION_MODE: v }, true).mode).toBe("DRY_RUN");
      expect(resolveRetentionMode({ ...OK, MEDIA_RETENTION_APPLY_CONFIRM: v }, true).mode).toBe("DRY_RUN");
      expect(resolveRetentionMode({ ...OK, VERCEL_ENV: v }, true).mode).toBe("DRY_RUN");
    }
  });
});

describe("robustez", () => {
  it("entorno ilegible o no objeto → DRY_RUN (ENV_UNAVAILABLE) sin lanzar", () => {
    const throwing = new Proxy({}, { get() { throw new Error("no"); } });
    for (const env of [null, undefined, "APPLY", 42, throwing]) {
      expect(resolveRetentionMode(env, true)).toEqual({ mode: "DRY_RUN", valid: false, reason: "ENV_UNAVAILABLE" });
    }
  });
  it("el resultado nunca contiene valores del entorno y es inmutable", () => {
    const secretish = "valor-raro-9f8e7d";
    for (const env of [{ ...OK, MEDIA_RETENTION_MODE: secretish }, { ...OK, MEDIA_RETENTION_APPLY_CONFIRM: secretish }, { ...OK, VERCEL_ENV: secretish }]) {
      const r = resolveRetentionMode(env, true);
      expect(JSON.stringify(r)).not.toContain(secretish);
      expect(Object.isFrozen(r)).toBe(true);
    }
    expect(Object.keys(resolveRetentionMode(OK, true)).sort()).toEqual(["mode", "reason", "valid"]);
  });
  it("no modifica el entorno recibido", () => {
    const env = Object.freeze({ ...OK });
    expect(() => resolveRetentionMode(env, true)).not.toThrow();
    expect(env).toEqual(OK);
  });
});

describe("búsqueda exhaustiva: solo UNA combinación permite APPLY", () => {
  it("ninguna combinación parcial o aproximada de modo × confirmación × entorno × enabled da APPLY", () => {
    const A = undefined;
    const modes = [A, "", " ", "APPLY", " APPLY", "APPLY ", "apply", "Apply", "DRY_RUN", "APPLIED", "1", 1];
    const confirms = [A, "", RETENTION_APPLY_CONFIRMATION, ` ${RETENTION_APPLY_CONFIRMATION}`, `${RETENTION_APPLY_CONFIRMATION} `,
      RETENTION_APPLY_CONFIRMATION.toUpperCase(), "apply-media-retention-policy-v2", "x"];
    const envs = [A, "", "production", "Production", " production", "preview", "development"];
    const enableds: unknown[] = [true, false, "true", 1, A];
    const applies: string[] = [];
    let n = 0;
    for (const m of modes) for (const c of confirms) for (const v of envs) for (const en of enableds) {
      const env: Record<string, unknown> = {};
      if (m !== A) env.MEDIA_RETENTION_MODE = m;
      if (c !== A) env.MEDIA_RETENTION_APPLY_CONFIRM = c;
      if (v !== A) env.VERCEL_ENV = v;
      const r = resolveRetentionMode(env, en);
      if (r.mode === "APPLY") applies.push(JSON.stringify({ m, c, v, en }));
      else expect(r.reason).not.toBeNull();
      n++;
    }
    expect(n).toBe(12 * 8 * 7 * 5);
    expect(applies).toEqual([JSON.stringify({ m: "APPLY", c: RETENTION_APPLY_CONFIRMATION, v: "production", en: true })]);
  });
});
