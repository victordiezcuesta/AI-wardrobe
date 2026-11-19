import { prisma } from "@/lib/prisma";
import type { AiTask, Prisma } from "@/generated/prisma/client";

type UsageScope = { userId: string; since: Date; task?: AiTask };
const scopeWhere = ({ userId, since, task }: UsageScope): Prisma.AiUsageLogWhereInput => ({ userId, createdAt: { gte: since }, ...(task && { task }) });

export const aiUsageRepository = {
  log: (data: { userId: string; task: AiTask; provider: string; model: string; inputTokens?: number | null; outputTokens?: number | null; success: boolean; latencyMs?: number }) =>
    prisma.aiUsageLog.create({ data }),
  countSince: (userId: string, since: Date, task?: AiTask) =>
    prisma.aiUsageLog.count({ where: scopeWhere({ userId, since, task }) }),

  /**
   * Comprueba la cuota e inserta la reserva de forma ATÓMICA: un advisory lock por usuario (liberado al terminar la
   * transacción) serializa las reservas concurrentes del mismo usuario, así que dos peticiones no pueden ver a la vez
   * «queda 1» y consumirla las dos. Devuelve el id de la reserva, o null si no queda cuota.
   * La reserva es una fila normal de AiUsageLog (success=false hasta confirmarse): cuenta para la cuota desde ya.
   */
  reserve: (scope: UsageScope, limit: number, entry: { task: AiTask; provider: string; model: string }) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ai-quota:${scope.userId}`}, 0))`;
      const used = await tx.aiUsageLog.count({ where: scopeWhere(scope) });
      if (used >= limit) return null;
      const row = await tx.aiUsageLog.create({ data: { userId: scope.userId, ...entry, success: false }, select: { id: true } });
      return row.id;
    }),

  /** Convierte la reserva en el registro del uso real. */
  complete: (id: string, usage: { inputTokens?: number | null; outputTokens?: number | null; latencyMs?: number; success: boolean }) =>
    prisma.aiUsageLog.updateMany({ where: { id }, data: usage }),

  /** Devuelve la unidad: borra SOLO esa reserva (idempotente: una segunda llamada no borra nada). */
  release: (id: string) => prisma.aiUsageLog.deleteMany({ where: { id } }),
};
