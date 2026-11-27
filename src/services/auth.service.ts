import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { env } from "@/lib/env";
import { AppError, logError } from "@/lib/errors";
import { dbFailure, isUniqueViolationOn } from "@/lib/errors/db";
import { sendMail } from "@/lib/mail";
import { mailFailure, MailDeadlineError } from "@/lib/mail/failure";
import { prisma } from "@/lib/prisma";
import { userRepository } from "@/repositories/user.repository";
import { sessionRepository } from "@/repositories/session.repository";
import { tokenRepository, type TokenKind } from "@/repositories/token.repository";

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const TTL_MS: Record<TokenKind, number> = { VERIFY_EMAIL: 24 * 3600e3, RESET_PASSWORD: 3600e3 };

/**
 * Hash bcrypt válido (coste 12, mismo que las contraseñas reales) de un valor aleatorio descartado: ninguna contraseña
 * coincide con él. Se compara contra él cuando el email no existe o no tiene contraseña, para que esa ruta tarde lo mismo
 * que la de un usuario real y el tiempo de respuesta no revele qué emails están registrados. Debe ser un hash bien formado:
 * con uno mal formado, bcrypt devuelve false al instante sin hacer el trabajo.
 */
export const DUMMY_PASSWORD_HASH = "$2b$12$MiDUStheqcaKWCq4MxhhlepysZF7zb5laoLv3kiCN3VMi0qfL/V4e";

/** Restricción única del email en `User` (índice `User_email_key`, ver prisma/migrations/0001_init). */
const USER_EMAIL_UNIQUE = { table: "User", fields: ["email"], index: "User_email_key" } as const;

async function issueToken(email: string, kind: TokenKind): Promise<string> {
  const raw = randomBytes(32).toString("hex");
  await tokenRepository.replace(email, kind, sha256(raw), new Date(Date.now() + TTL_MS[kind]));
  return raw;
}

async function consumeToken(raw: string, kind: TokenKind): Promise<string> {
  // Consumo atómico de un solo uso (F.4): inexistente, caducado, de otra finalidad o ya consumido (también por una solicitud simultánea)
  // dan el mismo error, sin distinguirlos.
  const identifier = await tokenRepository.consume(sha256(raw), kind);
  if (identifier === null) throw new AppError("Enlace no válido o caducado", 400, "INVALID_TOKEN");
  return identifier;
}

export const authService = {
  /**
   * Registro. La ruta lo ejecuta en `after()`, DESPUÉS de responder (F.3): nada de lo que depende de la cuenta (consulta, bcrypt,
   * creación, token, correo) está en el camino síncrono, así que la respuesta no revela si el email existe. Los errores de base de datos
   * se propagan al callback de la ruta, que los registra saneados; el fallo de envío se trata en `sendVerification`.
   */
  async register(input: { email: string; password: string; name?: string }) {
    const existing = await userRepository.findByEmail(input.email);

    // Si existe y no ha verificado su email, reenviamos un nuevo enlace. Nunca se modifica una cuenta existente.
    if (existing) {
      if (!existing.emailVerified) {
        await this.sendVerification(input.email);
      }
      return;
    }

    const passwordHash = await bcrypt.hash(input.password, 12);
    try {
      await userRepository.create({ email: input.email, name: input.name, passwordHash });
    } catch (err) {
      // Carrera: otra solicitud creó esta cuenta entre la consulta y el `create`. SOLO una violación de la restricción única del EMAIL
      // se trata como «la cuenta ya existe» (`isUniqueViolationOn` la identifica por tabla y restricción, sin leer mensajes). La solicitud
      // que ganó es la que envía la verificación: reenviar aquí sustituiría su token (`replace`) y dejaría muerto el enlace de su correo.
      // Cualquier otro error (otra restricción, otro código de Prisma) se propaga: no se oculta.
      if (isUniqueViolationOn(err, USER_EMAIL_UNIQUE)) return;
      throw err;
    }
    await this.sendVerification(input.email);
  },

  async sendVerification(email: string) {
    const token = await issueToken(email, "VERIFY_EMAIL");
    const url = `${env().NEXT_PUBLIC_APP_URL}/verify-email?token=${token}`;
    // Mismo tratamiento que la recuperación (F.2 / F.2.1). Ya no se ejecuta antes de responder, así que un fallo de envío no puede
    // propagarse a un 500; tampoco se pierde: se registra saneado (`mailFailure`: sin destinatario, token, enlace ni texto del servidor).
    // Fallo confirmado → se intenta borrar exactamente el token recién creado (un token que nadie recibió no debe quedar guardado; quien
    // se registre de nuevo recibe otro enlace). Plazo total agotado → ENTREGA INCIERTA: el correo aún puede llegar, así que el token se
    // CONSERVA (caduca solo en 24 h). Los errores de base de datos de `issueToken` SÍ se propagan.
    try {
      await sendMail(email, "Confirma tu email en AI Wardrobe", `Confirma tu cuenta: ${url} \nEl enlace caduca en 24 horas.`);
    } catch (err) {
      if (err instanceof MailDeadlineError) {
        logError("auth.verify.mail_uncertain", mailFailure(err));
        return;
      }
      logError("auth.verify.mail", mailFailure(err));
      try {
        await tokenRepository.delete(sha256(token));
      } catch (cleanupErr) {
        logError("auth.verify.token_cleanup", dbFailure(cleanupErr)); // solo el código: nunca el mensaje (puede repetir el hash o el email)
      }
    }
  },

  async verifyEmail(rawToken: string) {
    const email = await consumeToken(rawToken, "VERIFY_EMAIL");
    await userRepository.markVerified(email);
  },

  async requestReset(email: string) {
    const user = await userRepository.findByEmail(email);
    if (!user?.passwordHash) return;
    const token = await issueToken(email, "RESET_PASSWORD");
    const url = `${env().NEXT_PUBLIC_APP_URL}/reset-password?token=${token}`;
    // El fallo de envío NO se propaga: la ruta ejecuta esto en `after()`, tras responder, y la respuesta pública no puede depender de
    // si la cuenta existe ni de si el correo salió (F.2). Tampoco se pierde: se registra saneado (`mailFailure`: sin destinatario,
    // token, enlace ni texto del servidor). Un token que nadie recibió no debe quedar guardado: se intenta borrar. Esto solo cubre un
    // proceso que sigue vivo; una interrupción (timeout de la plataforma, caída) puede dejarlo, y caduca por sí solo en 1 hora.
    // Los errores de base de datos de arriba (consulta, creación del token) SÍ se propagan.
    try {
      await sendMail(email, "Restablece tu contraseña", `Crea una nueva contraseña: ${url} \nEl enlace caduca en 1 hora.`);
    } catch (err) {
      if (err instanceof MailDeadlineError) {
        // ENTREGA INCIERTA: la aplicación dejó de esperar, pero el envío no se cancela y el correo todavía puede llegar. Se CONSERVA el
        // token (si se borrara, el enlace del correo tardío estaría muerto); caduca solo en 1 hora. Fallo confirmado → limpieza, abajo.
        logError("auth.reset.mail_uncertain", mailFailure(err));
        return;
      }
      logError("auth.reset.mail", mailFailure(err));
      try {
        await tokenRepository.delete(sha256(token));
      } catch (cleanupErr) {
        logError("auth.reset.token_cleanup", dbFailure(cleanupErr)); // solo el código: nunca el mensaje (puede repetir el hash o el email)
      }
    }
  },

  async resetPassword(rawToken: string, password: string) {
    const email = await consumeToken(rawToken, "RESET_PASSWORD");
    const passwordHash = await bcrypt.hash(password, 12);
    // Una sola transacción: si la contraseña cambia, ninguna sesión anterior (de quien la conociera) sigue activa.
    await prisma.$transaction([
      userRepository.setPassword(email, passwordHash),
      userRepository.markVerified(email), // recibir el enlace demuestra control del email
      sessionRepository.deleteAllForEmail(email),
    ]);
  },

  async verifyCredentials(email: string, password: string) {
    const user = await userRepository.findByEmail(email);
    // Comparación siempre ejecutada (con DUMMY_PASSWORD_HASH si no hay usuario) para igualar tiempos de respuesta.
    const hash = user?.passwordHash ?? DUMMY_PASSWORD_HASH;
    const ok = await bcrypt.compare(password, hash);
    if (!user || !ok) return null;
    if (!user.emailVerified) return null;
    return { id: user.id, email: user.email, name: user.name };
  },
};
