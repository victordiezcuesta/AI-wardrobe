import { env } from "@/lib/env";
import { tooMany } from "@/lib/errors";
import { aiUsageRepository } from "@/repositories/ai-usage.repository";
import type { AiTask } from "@/generated/prisma/client";

const startOfDay = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d; };

export const aiUsageService = {
  /** Corta antes de llamar al proveedor si el usuario ya agotó su cuota diaria. */
  async assertQuota(userId: string, task?: AiTask) {
    const limit = task === "TRY_ON" ? env().TRYON_DAILY_LIMIT_PER_USER : env().AI_DAILY_LIMIT_PER_USER;
    const used = await aiUsageRepository.countSince(userId, startOfDay(), task);
    if (used >= limit) throw tooMany(Math.ceil((startOfDay().getTime() + 86_400_000 - Date.now()) / 1000));
  },
  log: aiUsageRepository.log,
};
