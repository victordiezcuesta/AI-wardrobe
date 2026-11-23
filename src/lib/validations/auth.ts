import { z } from "zod";

export const passwordSchema = z
  .string()
  .min(10, "Mínimo 10 caracteres")
  .max(128, "La contraseña no puede superar los 128 caracteres")
  // bcrypt solo usa los primeros 72 BYTES UTF-8: se rechaza lo que los supere en vez de truncarlo en silencio.
  // `string.length` cuenta unidades UTF-16, no bytes («ñ» son 2 bytes y «😀» 4).
  .refine((value) => new TextEncoder().encode(value).length <= 72, "La contraseña no puede superar los 72 bytes UTF-8 (los caracteres con tilde o los emojis ocupan más de 1 byte)")
  .regex(/[a-z]/, "Incluye una minúscula")
  .regex(/[A-Z]/, "Incluye una mayúscula")
  .regex(/[0-9]/, "Incluye un número");

/**
 * Email normalizado (recortado y en minúsculas) y con un máximo de 254 caracteres (RFC 5321). El orden importa: la longitud
 * se mide DESPUÉS de normalizar, y el rechazo ocurre en la validación (422), antes de cualquier consulta, hash o contador.
 */
const emailSchema = z.string().trim().toLowerCase().max(254, "El email no puede superar los 254 caracteres").email();
/** Los tokens de verificación y restablecimiento son siempre `randomBytes(32).toString("hex")`: 64 caracteres. */
const tokenSchema = z.string().min(20).max(64);

export const registerSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  email: emailSchema,
  password: passwordSchema,
});
export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});
export const forgotSchema = z.object({ email: emailSchema });
export const resetSchema = z.object({ token: tokenSchema, password: passwordSchema });
export const verifySchema = z.object({ token: tokenSchema });

/**
 * Cambio de contraseña desde la sesión (20.3b). La contraseña ACTUAL solo se limita a 128 caracteres, sin el tope de 72
 * bytes: una credencial antigua válida (el login no aplica ese límite) no debe quedar bloqueada. La nueva usa passwordSchema
 * completo (mínimo, composición, 128 caracteres y 72 bytes UTF-8).
 */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});
