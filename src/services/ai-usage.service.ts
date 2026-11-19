import { env } from "@/lib/env";
import { logError, tooMany } from "@/lib/errors";
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
  /** La operación terminó: la reserva pasa a ser el registro real (la unidad sigue consumida). */
  complete: aiUsageRepository.complete,
  /** Se sabe con certeza que no se completó nada facturable: se devuelve la unidad. */
  release: aiUsageRepository.release,

  /**
   * Ciclo completo de UNA operación de IA síncrona con UNA unidad de cuota (incluidos sus reintentos internos):
   * 1) reserva atómica (429 si no queda cuota; no se ejecuta nada);
   * 2) `op` llama a la IA y anota con `meter.record` cada respuesta recibida (tokens);
   * 3) éxito → la reserva queda como uso real (`success=true`, tokens y latencia sumados);
   *    error sin ninguna respuesta recibida y que `notBilled` confirma como no facturado → se devuelve la unidad;
   *    cualquier otro error (dudoso o posterior a una respuesta) → consumida con `success=false`.
   * El error original se relanza sin cambios.
   */
  async runReserved<T>(
    userId: string,
    entry: { task: AiTask; provider: string; model: string },
    opts: { quotaTask?: AiTask; notBilled: (err: unknown) => boolean },
    op: (meter: UsageMeter) => Promise<T>,
  ): Promise<T> {
    const reservation = await this.reserve(userId, entry, opts.quotaTask);
    const started = Date.now();
    const usage = { inputTokens: 0, outputTokens: 0 };
    let responded = false;
    const meter: UsageMeter = {
      record(u) {
        responded = true;
        usage.inputTokens += u.inputTokens ?? 0;
        usage.outputTokens += u.outputTokens ?? 0;
      },
    };
    let result: T;
    try {
      result = await op(meter);
    } catch (err) {
      if (!responded && opts.notBilled(err)) {
        await this.release(reservation).catch((e) => logError("ai_usage.release", e));
      } else {
        await this.complete(reservation, { ...usage, success: false, latencyMs: Date.now() - started }).catch((e) => logError("ai_usage.complete", e));
      }
      throw err;
    }
    await this.complete(reservation, { ...usage, success: true, latencyMs: Date.now() - started });
    return result;
  },
};

/** Anota cada respuesta recibida del proveedor dentro de una operación reservada. */
export interface UsageMeter { record(usage: { inputTokens: number | null; outputTokens: number | null }): void }
