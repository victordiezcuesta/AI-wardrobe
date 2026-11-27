import { passwordSchema } from "@/lib/validations/auth";
import { api, ApiError } from "@/utils/api";
import { groupIssues } from "@/utils/issues";

/**
 * Lógica del formulario «Cambiar contraseña» (20.3c), sin React: validación en cliente, envío sin duplicados y traducción de
 * los errores de POST /api/account/password a mensajes. El servidor sigue siendo la autoridad; esto solo evita viajes inútiles.
 */
export interface PasswordValues { currentPassword: string; newPassword: string; confirmPassword: string }
export type PasswordField = keyof PasswordValues;
/** Todos los mensajes de cada campo (varias reglas de contraseña a la vez), en orden de llegada y sin repetidos. */
export type FieldErrors = Partial<Record<PasswordField, string[]>>;
const PASSWORD_FIELDS: readonly PasswordField[] = ["currentPassword", "newPassword", "confirmPassword"];

export const EMPTY_VALUES: PasswordValues = { currentPassword: "", newPassword: "", confirmPassword: "" };

export const PASSWORD_MESSAGES = {
  currentRequired: "Introduce tu contraseña actual.",
  currentTooLong: "La contraseña actual no puede superar los 128 caracteres.",
  mismatch: "Las contraseñas no coinciden.",
  badPassword: "La contraseña actual no es correcta.",
  noLocalPassword: "Esta cuenta no dispone de contraseña local, así que no puedes cambiarla desde aquí.",
  conflict: "Tu contraseña o tu sesión han cambiado mientras se procesaba la solicitud. Vuelve a intentarlo.",
  samePassword: "La nueva contraseña debe ser diferente de la actual.",
  validation: "Los datos no son válidos. Revisa los campos e inténtalo de nuevo.",
  unauthorized: "Tu sesión ha caducado o no es válida. Vuelve a iniciar sesión.",
  rateLimited: "Has alcanzado el límite de intentos. Espera un rato antes de volver a intentarlo.",
  generic: "No hemos podido cambiar la contraseña. Inténtalo de nuevo más tarde.",
  success: "Contraseña actualizada. Se han cerrado tus otras sesiones.",
} as const;

/** Mismo criterio que Zod (puntos de código), para que cliente y servidor coincidan con emojis. */
const length = (s: string) => [...s].length;

/** Reglas del cliente. La nueva contraseña usa `passwordSchema` (mínimo, composición, 128 caracteres y 72 bytes UTF-8). */
export function validatePasswordChange(v: PasswordValues): FieldErrors {
  const errors: FieldErrors = {};
  if (v.currentPassword.length === 0) errors.currentPassword = [PASSWORD_MESSAGES.currentRequired];
  else if (length(v.currentPassword) > 128) errors.currentPassword = [PASSWORD_MESSAGES.currentTooLong];
  const parsed = passwordSchema.safeParse(v.newPassword);
  if (!parsed.success) {
    // Todas las reglas incumplidas, no solo la primera (mínimo, mayúscula, minúscula, número…).
    const all = groupIssues(parsed.error.issues.map((i) => ({ path: "newPassword", message: i.message }))).fields.newPassword;
    errors.newPassword = all?.length ? all : [PASSWORD_MESSAGES.validation];
  }
  if (v.confirmPassword !== v.newPassword) errors.confirmPassword = [PASSWORD_MESSAGES.mismatch];
  return errors;
}

/** `errors` = todos los mensajes de campo cuando el servidor rechazó la validación; `field`/`message` = el primero (compatibilidad). */
export interface PasswordError { field?: PasswordField; message: string; errors?: FieldErrors }

/** Mensaje (y campo, si procede) para un fallo del envío. Nunca muestra detalles internos de errores 5xx o de red. */
export function passwordChangeError(err: unknown): PasswordError {
  if (!(err instanceof ApiError)) return { message: PASSWORD_MESSAGES.generic };
  switch (err.status) {
    case 401: return { message: PASSWORD_MESSAGES.unauthorized };
    case 403: return err.code === "BAD_PASSWORD" ? { field: "currentPassword", message: PASSWORD_MESSAGES.badPassword } : { message: PASSWORD_MESSAGES.generic };
    case 409:
      if (err.code === "NO_LOCAL_PASSWORD") return { message: PASSWORD_MESSAGES.noLocalPassword };
      if (err.code === "CONFLICT") return { message: PASSWORD_MESSAGES.conflict };
      return { message: PASSWORD_MESSAGES.generic };
    case 422: {
      if (err.code === "SAME_PASSWORD") return { field: "newPassword", message: PASSWORD_MESSAGES.samePassword };
      // Solo los campos que el formulario envía; los demás `path` (o los vacíos) no se atribuyen a ningún campo.
      const { fields } = groupIssues(err.issues, { fields: ["currentPassword", "newPassword"] });
      const first = (["currentPassword", "newPassword"] as const).find((f) => fields[f]?.length);
      if (!first) return { message: PASSWORD_MESSAGES.validation };
      const errors: FieldErrors = {};
      for (const f of PASSWORD_FIELDS) if (fields[f]?.length) errors[f] = fields[f];
      return { field: first, message: fields[first]![0]!, errors };
    }
    case 429: return { message: PASSWORD_MESSAGES.rateLimited };
    default: return { message: PASSWORD_MESSAGES.generic };
  }
}

export type SubmitResult =
  | { status: "success" }
  | { status: "invalid"; errors: FieldErrors }
  | { status: "error"; field?: PasswordField; message: string; errors?: FieldErrors };

export type PostPasswordChange = (body: { currentPassword: string; newPassword: string }) => Promise<unknown>;

export const postPasswordChange: PostPasswordChange = (body) => api("/api/account/password", { method: "POST", json: body });

/**
 * Envío con protección frente a duplicados: mientras hay una petición en curso, nuevas llamadas devuelven `null` sin validar
 * ni enviar nada. Solo se envían `currentPassword` y `newPassword` (la confirmación nunca sale del navegador).
 */
export function createPasswordChangeSubmitter(post: PostPasswordChange) {
  let inFlight = false;
  return async function submit(values: PasswordValues): Promise<SubmitResult | null> {
    if (inFlight) return null;
    const errors = validatePasswordChange(values);
    if (Object.keys(errors).length > 0) return { status: "invalid", errors };
    inFlight = true;
    try {
      await post({ currentPassword: values.currentPassword, newPassword: values.newPassword });
      return { status: "success" };
    } catch (e) {
      return { status: "error", ...passwordChangeError(e) };
    } finally {
      inFlight = false;
    }
  };
}
