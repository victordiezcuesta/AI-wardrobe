/**
 * Errores del login que pueden llegar al cliente. Auth.js solo deja pasar al navegador los errores «seguros»
 * (`CredentialsSignin` y su `code`); cualquier otro llega como `error=Configuration`, sin detalles internos.
 */

/** `code` de `CredentialsSignin` cuando se supera el límite de intentos (lo fija `authorize()` en src/lib/auth). */
export const LOGIN_RATE_LIMITED_CODE = "rate_limited";

export const LOGIN_MESSAGES = {
  /** Genérico a propósito: no distingue usuario inexistente, contraseña incorrecta ni email sin confirmar. */
  invalid: "Email o contraseña incorrectos, o el email aún no está confirmado.",
  rateLimited: "Has hecho demasiados intentos de inicio de sesión. Espera unos minutos antes de volver a intentarlo.",
  unexpected: "No hemos podido iniciar sesión por un problema temporal. Inténtalo de nuevo en unos minutos.",
} as const;

/** Lo que devuelve `signIn("credentials", { redirect: false })` de next-auth/react (o undefined si no hubo respuesta). */
export interface SignInOutcome { error?: string | null; code?: string | null }

/** Mensaje para el formulario, o null si el login ha ido bien. */
export function loginErrorMessage(res: SignInOutcome | undefined | null): string | null {
  if (!res) return LOGIN_MESSAGES.unexpected;
  if (!res.error) return null;
  if (res.error === "CredentialsSignin") {
    return res.code === LOGIN_RATE_LIMITED_CODE ? LOGIN_MESSAGES.rateLimited : LOGIN_MESSAGES.invalid;
  }
  return LOGIN_MESSAGES.unexpected; // Configuration u otros: fallo del servidor, no de las credenciales
}
