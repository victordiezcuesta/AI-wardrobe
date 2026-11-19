import { describe, expect, it } from "vitest";
import { LOGIN_MESSAGES, loginErrorMessage } from "@/features/authentication/login-errors";

/** Mensaje que muestra el formulario de login para cada resultado de signIn("credentials", { redirect: false }). */
describe("loginErrorMessage", () => {
  it("login correcto → sin mensaje", () => {
    expect(loginErrorMessage({ error: undefined })).toBeNull();
    expect(loginErrorMessage({ error: null, code: null })).toBeNull();
  });

  it("credenciales incorrectas (o usuario inexistente) → mensaje genérico", () => {
    expect(loginErrorMessage({ error: "CredentialsSignin", code: "credentials" })).toBe(LOGIN_MESSAGES.invalid);
    expect(loginErrorMessage({ error: "CredentialsSignin" })).toBe(LOGIN_MESSAGES.invalid);
  });

  it("límite superado → mensaje de espera", () => {
    expect(loginErrorMessage({ error: "CredentialsSignin", code: "rate_limited" })).toBe(LOGIN_MESSAGES.rateLimited);
    expect(LOGIN_MESSAGES.rateLimited).toMatch(/espera/i);
  });

  it("error del servidor o sin respuesta → mensaje de problema temporal, nunca «credenciales incorrectas»", () => {
    for (const r of [{ error: "Configuration" }, { error: "CallbackRouteError" }, { error: "MissingCSRF" }, undefined, null]) {
      expect(loginErrorMessage(r)).toBe(LOGIN_MESSAGES.unexpected);
    }
  });

  it("los mensajes no revelan si el email existe", () => {
    for (const m of Object.values(LOGIN_MESSAGES)) expect(m).not.toMatch(/no existe|no registrad|desconocid/i);
  });
});
