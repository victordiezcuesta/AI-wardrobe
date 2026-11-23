import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, SESSION_EXPIRED_MESSAGE } from "@/utils/api";
import {
  PASSWORD_MESSAGES, createPasswordChangeSubmitter, passwordChangeError, postPasswordChange, validatePasswordChange,
  type PasswordValues,
} from "@/features/profile/change-password";

/** Fase 20.3c — lógica del formulario de cambio de contraseña (sin React): validación, envío y errores. */
const OK: PasswordValues = { currentPassword: "Clave-actual-1", newPassword: "Nueva-clave-1", confirmPassword: "Nueva-clave-1" };
const v = (o: Partial<PasswordValues> = {}): PasswordValues => ({ ...OK, ...o });
const withNew = (p: string) => v({ newPassword: p, confirmPassword: p });

describe("validatePasswordChange", () => {
  it("datos correctos → sin errores", () => {
    expect(validatePasswordChange(OK)).toEqual({});
  });

  it("campos vacíos → error en actual, nueva y (si difiere) confirmación", () => {
    const e = validatePasswordChange({ currentPassword: "", newPassword: "", confirmPassword: "" });
    expect(e.currentPassword).toBe(PASSWORD_MESSAGES.currentRequired);
    expect(e.newPassword).toBeTruthy();
    expect(e.confirmPassword).toBeUndefined(); // vacía = vacía; el error útil es el de la nueva
    expect(validatePasswordChange(v({ confirmPassword: "" })).confirmPassword).toBe(PASSWORD_MESSAGES.mismatch);
  });

  it("la actual admite hasta 128 caracteres y NO tiene el tope de 72 bytes", () => {
    expect(validatePasswordChange(v({ currentPassword: "x".repeat(128) })).currentPassword).toBeUndefined();
    expect(validatePasswordChange(v({ currentPassword: "😀".repeat(128) })).currentPassword).toBeUndefined(); // 512 bytes, 128 puntos de código
    expect(validatePasswordChange(v({ currentPassword: "x".repeat(129) })).currentPassword).toBe(PASSWORD_MESSAGES.currentTooLong);
    expect(validatePasswordChange(v({ currentPassword: "😀".repeat(129) })).currentPassword).toBe(PASSWORD_MESSAGES.currentTooLong);
  });

  it.each([
    ["menos de 10 caracteres", "Corta1a"],
    ["sin minúscula", "SINMINUSCULA1"],
    ["sin mayúscula", "sinmayuscula1"],
    ["sin número", "SinNumeroAqui"],
    ["más de 128 caracteres", `Aa1${"x".repeat(126)}`],
    ["73 bytes ASCII", `Aa1${"x".repeat(70)}`],
    ["73 bytes con ñ", `${"ñ".repeat(34)}Aa1xy`],
    ["75 bytes con emoji", `${"😀".repeat(18)}Aa1`],
  ])("nueva contraseña inválida: %s", (_n, p) => {
    expect(validatePasswordChange(withNew(p)).newPassword).toBeTruthy();
  });

  it.each([
    ["72 bytes ASCII", `Aa1${"x".repeat(69)}`],
    ["72 bytes con ñ", `${"ñ".repeat(34)}Aa1x`],
    ["72 bytes con emoji", `${"😀".repeat(17)}Aa1x`],
    ["10 caracteres", "Aa1xxxxxxx"],
  ])("nueva contraseña válida en el límite: %s", (_n, p) => {
    expect(validatePasswordChange(withNew(p))).toEqual({});
  });

  it("más de 128 caracteres en la nueva → mensaje en español del esquema (no el texto en inglés de Zod)", () => {
    expect(validatePasswordChange(withNew(`Aa1${"x".repeat(126)}`)).newPassword).toBe("La contraseña no puede superar los 128 caracteres");
  });

  it("el mensaje del límite de bytes es el del esquema del servidor", () => {
    expect(validatePasswordChange(withNew(`Aa1${"x".repeat(70)}`)).newPassword).toContain("72 bytes UTF-8");
  });

  it("confirmación distinta → error solo en la confirmación", () => {
    expect(validatePasswordChange(v({ confirmPassword: "Nueva-clave-2" }))).toEqual({ confirmPassword: PASSWORD_MESSAGES.mismatch });
  });

  it("no exige que la nueva difiera de la actual (lo decide el servidor)", () => {
    expect(validatePasswordChange(v({ currentPassword: OK.newPassword }))).toEqual({});
  });
});

describe("passwordChangeError", () => {
  const api = (status: number, code?: string, issues?: { path: string; message: string }[]) => new ApiError("mensaje interno del servidor", status, issues, code);

  it.each([
    [api(401, "UNAUTHORIZED"), { message: PASSWORD_MESSAGES.unauthorized }],
    [api(403, "BAD_PASSWORD"), { field: "currentPassword", message: PASSWORD_MESSAGES.badPassword }],
    [api(409, "NO_LOCAL_PASSWORD"), { message: PASSWORD_MESSAGES.noLocalPassword }],
    [api(409, "CONFLICT"), { message: PASSWORD_MESSAGES.conflict }],
    [api(422, "SAME_PASSWORD"), { field: "newPassword", message: PASSWORD_MESSAGES.samePassword }],
    [api(422, "VALIDATION"), { message: PASSWORD_MESSAGES.validation }],
    [api(422, "VALIDATION", [{ path: "newPassword", message: "Mínimo 10 caracteres" }]), { field: "newPassword", message: "Mínimo 10 caracteres" }],
    [api(422, "VALIDATION", [{ path: "currentPassword", message: "Required" }]), { field: "currentPassword", message: "Required" }],
    [api(429, "RATE_LIMITED"), { message: PASSWORD_MESSAGES.rateLimited }],
  ])("%#: código y estado → mensaje", (err, expected) => {
    expect(passwordChangeError(err)).toEqual(expected);
  });

  it("el 401 de api() (mensaje de sesión caducada) también se traduce", () => {
    expect(passwordChangeError(new ApiError(SESSION_EXPIRED_MESSAGE, 401, undefined, "UNAUTHORIZED")).message).toBe(PASSWORD_MESSAGES.unauthorized);
  });

  it("500, otros estados, errores de red y errores desconocidos → mensaje genérico sin detalles internos", () => {
    for (const err of [api(500, "INTERNAL"), api(502), api(403, "BAD_ORIGIN"), api(409), api(422, undefined, [{ path: "otra", message: "x" }]), new TypeError("Failed to fetch: ECONNRESET 10.0.0.5"), new Error("secreto"), "texto", null, undefined]) {
      const r = passwordChangeError(err);
      if (err instanceof ApiError && err.status === 422) { expect(r.message).toBe(PASSWORD_MESSAGES.validation); continue; }
      expect(r).toEqual({ message: PASSWORD_MESSAGES.generic });
      expect(r.message).not.toMatch(/ECONNRESET|secreto|interno|10\.0/);
    }
  });

  it("todos los mensajes son comprensibles y no mencionan hashes, sid ni detalles técnicos", () => {
    for (const m of Object.values(PASSWORD_MESSAGES)) expect(m).not.toMatch(/hash|sid|bcrypt|token|prisma|stack/i);
  });
});

describe("createPasswordChangeSubmitter", () => {
  it("envía exclusivamente currentPassword y newPassword (nunca la confirmación)", async () => {
    const post = vi.fn(async () => ({ ok: true }));
    const r = await createPasswordChangeSubmitter(post)(OK);
    expect(r).toEqual({ status: "success" });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith({ currentPassword: OK.currentPassword, newPassword: OK.newPassword });
    expect(Object.keys((post.mock.calls[0] as unknown[])[0] as object).sort()).toEqual(["currentPassword", "newPassword"]);
  });

  it("datos inválidos → no se envía nada", async () => {
    const post = vi.fn(async () => ({}));
    const r = await createPasswordChangeSubmitter(post)(v({ confirmPassword: "otra" }));
    expect(r).toEqual({ status: "invalid", errors: { confirmPassword: PASSWORD_MESSAGES.mismatch } });
    expect(post).not.toHaveBeenCalled();
  });

  it("no permite envíos duplicados mientras hay uno en curso, y vuelve a permitirlos después", async () => {
    let finish!: () => void;
    const post = vi.fn(() => new Promise<unknown>((res) => { finish = () => res({ ok: true }); }));
    const submit = createPasswordChangeSubmitter(post);
    const first = submit(OK);
    expect(await submit(OK)).toBeNull();   // duplicado ignorado
    expect(await submit(v({ currentPassword: "" }))).toBeNull(); // ni siquiera se valida
    expect(post).toHaveBeenCalledTimes(1);
    finish();
    expect(await first).toEqual({ status: "success" });
    const second = submit(OK);
    finish();
    expect(await second).toEqual({ status: "success" });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("tras un fallo también se libera el bloqueo", async () => {
    const post = vi.fn().mockRejectedValueOnce(new ApiError("x", 500, undefined, "INTERNAL")).mockResolvedValueOnce({ ok: true });
    const submit = createPasswordChangeSubmitter(post);
    expect(await submit(OK)).toEqual({ status: "error", message: PASSWORD_MESSAGES.generic });
    expect(await submit(OK)).toEqual({ status: "success" });
  });
});

describe("postPasswordChange + api() con fetch simulado (sin red)", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const stub = (status: number, body: unknown) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };
  const error = (code: string, message = "msg", issues?: unknown) => ({ error: { code, message, ...(issues ? { issues } : {}) } });

  it("hace POST /api/account/password con un JSON de solo dos campos", async () => {
    const f = stub(200, { ok: true });
    expect(await createPasswordChangeSubmitter(postPasswordChange)(OK)).toEqual({ status: "success" });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/account/password");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ currentPassword: OK.currentPassword, newPassword: OK.newPassword });
  });

  it.each([
    [401, error("UNAUTHORIZED"), { status: "error", message: PASSWORD_MESSAGES.unauthorized }],
    [403, error("BAD_PASSWORD"), { status: "error", field: "currentPassword", message: PASSWORD_MESSAGES.badPassword }],
    [409, error("NO_LOCAL_PASSWORD"), { status: "error", message: PASSWORD_MESSAGES.noLocalPassword }],
    [409, error("CONFLICT"), { status: "error", message: PASSWORD_MESSAGES.conflict }],
    [422, error("SAME_PASSWORD"), { status: "error", field: "newPassword", message: PASSWORD_MESSAGES.samePassword }],
    [422, error("VALIDATION", "Datos no válidos", [{ path: "newPassword", message: "Incluye un número" }]), { status: "error", field: "newPassword", message: "Incluye un número" }],
    [429, error("RATE_LIMITED"), { status: "error", message: PASSWORD_MESSAGES.rateLimited }],
    [500, error("INTERNAL", "Error interno"), { status: "error", message: PASSWORD_MESSAGES.generic }],
  ])("HTTP %i %#: respuesta real de api() → resultado del formulario", async (status, body, expected) => {
    stub(status, body);
    expect(await createPasswordChangeSubmitter(postPasswordChange)(OK)).toEqual(expected);
  });

  it("error de red (fetch rechaza) y respuesta que no es JSON → mensaje genérico", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    expect(await createPasswordChangeSubmitter(postPasswordChange)(OK)).toEqual({ status: "error", message: PASSWORD_MESSAGES.generic });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>502</html>", { status: 502 })));
    expect(await createPasswordChangeSubmitter(postPasswordChange)(OK)).toEqual({ status: "error", message: PASSWORD_MESSAGES.generic });
  });
});
