import { prisma } from "@/lib/prisma";
import type { AiTask } from "@/generated/prisma/client";

export const aiUsageRepository = {
  log: (data: { userId: string; task: AiTask; provider: string; model: string; inputTokens?: number | null; outputTokens?: number | null; success: boolean; latencyMs?: number }) =>
    prisma.aiUsageLog.create({ data }),
  countSince: (userId: string, since: Date, task?: AiTask) =>
    prisma.aiUsageLog.count({ where: { userId, createdAt: { gte: since }, ...(task && { task }) } }),
};
