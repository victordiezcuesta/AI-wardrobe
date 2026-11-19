import { createHash, randomBytes } from "node:crypto";
import { authConfig } from "@/lib/auth/config";
import { logError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { sessionRepository } from "@/repositories/session.repository";

/** Vida de la sesión: la misma que el JWT (14 días renovables). */
export const SESSION_MAX_AGE_MS = authConfig.session.maxAge * 1000;
/** Como mucho una escritura de renovación al día por sesión (equivale al `updateAge` de Auth.js). */
export const SESSION_UPDATE_AGE_MS = 24 * 3600 * 1000;
/**
 * La fila se fija a `ahora + maxAge + updateAge` y se renueva cuando le quedan menos de `maxAge`.
 * Así, tras cualquier validación en el instante t, la fila caduca en t + 14 días o más tarde: nunca antes que un JWT
 * renovado en ese momento (que caduca en t + 14 días). Quien decide la caducidad efectiva es el JWT; la fila solo
 * puede alargarla como mucho un día, nunca acortarla.
 */
const ROW_LIFETIME_MS = SESSION_MAX_AGE_MS + SESSION_UPDATE_AGE_MS;

const hash = (sid: string) => createHash("sha256").update(sid).digest("hex");

export interface SessionClaims { sub?: string | null; sid?: unknown }

export const sessionService = {
  /** Crea la sesión al iniciar sesión y devuelve el `sid` (32 bytes aleatorios) que irá dentro del JWT. */
  async start(userId: string, now = new Date()): Promise<string> {
    const sid = randomBytes(32).toString("base64url");
    await prisma.$transaction([
      sessionRepository.deleteExpiredForUser(userId, now), // limpieza oportunista: la tabla no crece sin límite
      sessionRepository.create(userId, hash(sid), new Date(now.getTime() + ROW_LIFETIME_MS)),
    ]);
    return sid;
  },

  /**
   * ¿Sigue viva la sesión de este JWT? Exige `sid`, que la fila exista, que pertenezca al mismo usuario y que no haya
   * caducado. Como la fila depende del usuario con borrado en cascada, una sesión válida implica que la cuenta existe.
   * Renueva la caducidad de la fila como mucho una vez al día.
   */
  async validate(claims: SessionClaims, now = new Date()): Promise<boolean> {
    if (typeof claims.sid !== "string" || !claims.sid || !claims.sub) return false;
    const tokenHash = hash(claims.sid);
    const row = await sessionRepository.find(tokenHash);
    if (!row || row.userId !== claims.sub || row.expires.getTime() <= now.getTime()) return false;
    if (row.expires.getTime() - now.getTime() < SESSION_MAX_AGE_MS) {
      // La sesión ya está validada (existe, es suya y no ha caducado). La renovación es opcional: si falla, se registra y
      // se reintentará en la próxima petición; quedan al menos ~13 días de margen. Los errores de la LECTURA anterior
      // no se capturan: se propagan y Auth.js los trata como sesión inexistente.
      await sessionRepository.extend(tokenHash, new Date(now.getTime() + ROW_LIFETIME_MS)).catch((e) => logError("session.extend", e));
    }
    return true;
  },

  /** Revoca una única sesión (la del dispositivo que cierra sesión). Idempotente. */
  async revoke(sid: unknown): Promise<void> {
    if (typeof sid !== "string" || !sid) return;
    await sessionRepository.delete(hash(sid));
  },
};
