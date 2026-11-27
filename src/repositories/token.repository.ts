import { prisma } from "@/lib/prisma";

export type TokenKind = "VERIFY_EMAIL" | "RESET_PASSWORD";

/**
 * La cuenta a la que pertenece el token (su `identifier`, el email) ya no existe: no se crea ningún token, porque quedaría huérfano. El
 * mensaje no contiene el identificador. El llamador lo propaga como cualquier otro error interno.
 */
export class TokenOwnerMissingError extends Error {
  constructor() {
    super("No existe la cuenta del token");
    this.name = "TokenOwnerMissingError";
  }
}

export const tokenRepository = {
  /**
   * Sustituye los tokens de una cuenta y finalidad por uno nuevo, de forma SERIALIZADA (F.4).
   *
   * Antes eran dos sentencias sueltas (`deleteMany` y `create`): dos solicitudes simultáneas podían dejar varios tokens vivos o borrar el
   * recién creado por la otra, y un fallo del `create` dejaba la cuenta sin el token anterior. Ahora, en UNA transacción interactiva:
   *   1. se bloquea la fila de la cuenta (`FOR NO KEY UPDATE`): las demás sustituciones de esa cuenta esperan a que esta termine;
   *   2. se borran los tokens anteriores de esa cuenta y finalidad;
   *   3. se crea el nuevo. Si esto falla, el borrado se revierte.
   * Se usa el bloqueo de la fila `User` (y no un advisory lock) porque además lo toma `account.service.delete` (`FOR UPDATE`, antes de borrar
   * los tokens): el orden es siempre User → VerificationToken, sin interbloqueos, y una sustitución que llega tras el borrado de la cuenta no
   * encuentra la fila y no deja un token huérfano. `FOR NO KEY UPDATE` basta para entrar en conflicto con ese `FOR UPDATE` y consigo
   * mismo, y no bloquea las inserciones con clave foránea (sesiones, perfil, armario…), que toman `FOR KEY SHARE`.
   * Dentro de la transacción solo se usa `tx`. Serializa por CUENTA, no por finalidad; el resultado de cada finalidad es independiente.
   * Garantía: nunca más de un token por cuenta y finalidad a la vez. Si dos solicitudes son simultáneas, solo el último token confirmado
   * es válido: el correo con el anterior llega con un enlace muerto (no se puede evitar con un único token activo).
   */
  async replace(identifier: string, kind: TokenKind, tokenHash: string, expires: Date) {
    return prisma.$transaction(async (tx) => {
      const owner = await tx.$queryRaw`SELECT 1 FROM "User" WHERE "email" = ${identifier} FOR NO KEY UPDATE`;
      if (!Array.isArray(owner) || owner.length === 0) throw new TokenOwnerMissingError();
      await tx.verificationToken.deleteMany({ where: { identifier, kind } });
      return tx.verificationToken.create({ data: { identifier, kind, token: tokenHash, expires } });
    });
  },
  find: (tokenHash: string, kind: TokenKind) =>
    prisma.verificationToken.findFirst({ where: { token: tokenHash, kind } }),
  /**
   * Consumo de UN SOLO USO (F.4): devuelve el `identifier` si ESTA llamada consumió el token, o `null` si no existe, es de otra finalidad,
   * está caducado o ya lo consumió otra. Lee la fila para obtener el identificador y después la borra con un `DELETE` condicionado
   * (hash, finalidad y caducidad futura): solo se considera consumido si borró EXACTAMENTE una fila. En PostgreSQL (READ COMMITTED) un
   * segundo `DELETE` simultáneo espera al bloqueo de la fila y, al reevaluar, ya no la encuentra (0 filas): solo uno gana. Un token
   * caducado no se borra aquí (como antes); el identificador es inmutable, así que leerlo antes no abre ninguna carrera.
   */
  async consume(tokenHash: string, kind: TokenKind, now: Date = new Date()): Promise<string | null> {
    const record = await prisma.verificationToken.findFirst({ where: { token: tokenHash, kind } });
    if (!record) return null;
    const { count } = await prisma.verificationToken.deleteMany({ where: { token: tokenHash, kind, expires: { gt: now } } });
    return count === 1 ? record.identifier : null;
  },
  /** Borrado por hash EXACTO (limpieza de un fallo SMTP confirmado, F.2 / F.3). */
  delete: (tokenHash: string) => prisma.verificationToken.deleteMany({ where: { token: tokenHash } }),
};
