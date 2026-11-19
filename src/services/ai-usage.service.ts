import { env } from "@/lib/env";
import { tooMany } from "@/lib/errors";
import { aiUsageRepository } from "@/repositories/ai-usage.repository";
import type { AiTask } from "@/generated/prisma/client";

const startOfDay = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d; };

/** Una sola definición de la cuota (límite, ámbito y error), compartida por `assertQuota` y `reserve`. */
const limitFor = (quotaTask?: AiTask) => (quotaTask === "TRY_ON" ? env().TRYON_DAILY_LIMIT_PER_USER : env().AI_DAILY_LIMIT_PER_USER);
const quotaExceeded = () => tooMany(Math.ceil((startOfDay().getTime() + 86_400_000 - Date.now()) / 1000));

export const aiUsageService = {
  /** Corta antes de llamar al proveedor si el usuario ya agotó su cuota diaria. */
  async assertQuota(userId: string, task?: AiTask) {
    const used = await aiUsageRepository.countSince(userId, startOfDay(), task);
    if (used >= limitFor(task)) throw quotaExceeded();
  },
  log: aiUsageRepository.log,

  /**
   * Reserva atómica de una unidad (comprobar + consumir en un paso; ver el repositorio). `quotaTask` es la cuota que
   * se consulta, con el mismo significado que en `assertQuota` (sin valor: la cuota general). Lanza 429 si no queda.
   */
  async reserve(userId: string, entry: { task: AiTask; provider: string; model: string }, quotaTask?: AiTask): Promise<string> {
    const id = await aiUsageRepository.reserve({ userId, since: startOfDay(), task: quotaTask }, limitFor(quotaTask), entry);
    if (!id) throw quotaExceeded();
    return id;
  },
  /** El análisis terminó: la reserva pasa a ser el registro real (la unidad sigue consumida). */
  complete: aiUsageRepository.complete,
  /** Se sabe con certeza que no se completó nada facturable: se devuelve la unidad. */
  release: aiUsageRepository.release,
};
