import { z } from "zod";
import { env } from "@/lib/env";
import { AppError, logError } from "@/lib/errors";

/** JSON Schema sin la clave "$schema", que algunos proveedores rechazan en modo estricto. */
function jsonSchemaFor(schema: z.ZodType) {
  const { $schema: _omit, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

export interface ChatUsage { inputTokens: number | null; outputTokens: number | null }
export interface ChatResult { text: string; usage: ChatUsage; model: string; latencyMs: number }

type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };
export interface ChatMessage { role: "system" | "user" | "assistant"; content: string | ContentPart[] }

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  schema?: z.ZodType;
  schemaName?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

/**
 * Mensajes que pueden llegar al cliente: nunca incluyen el proveedor, estados HTTP, claves ni el error original
 * (ese detalle va solo al log del servidor). El código del AppError sigue distinguiendo cada caso.
 */
export const AI_MESSAGES = {
  notConfigured: "El servicio de IA no está disponible en este momento.",
  unavailable: "El servicio de IA no ha podido responder. Inténtalo de nuevo en unos minutos.",
  rateLimited: "El servicio de IA ha alcanzado su límite de uso. Inténtalo de nuevo más tarde.",
} as const;

/**
 * Fallo del proveedor tras llamarlo. Es un AppError normal (mismo mensaje, estado y código para quien no lo distinga)
 * que además indica si alguna llamada PUDO procesarse y facturarse: `maybeBilled` es false solo cuando todos los
 * intentos recibieron un rechazo documentado como previo al procesamiento (ver REJECTED_BEFORE_PROCESSING).
 */
export class AiProviderError extends AppError {
  constructor(message: string, status: number, code: string, public readonly maybeBilled: boolean) {
    super(message, status, code);
  }
}

/**
 * Estados con los que OpenRouter rechaza la petición antes de que se procese (docs de errores: 400 parámetros no
 * válidos, 401 credenciales no válidas, 402 sin créditos / presupuesto en curso «before it reaches a provider») y 429
 * (límite de peticiones: de OpenRouter, p. ej. el cupo de modelos gratuitos, o del proveedor; en ambos casos la
 * petición se rechaza en lugar de procesarse). No se incluyen 403 (rechazos de distinto tipo: presupuesto, permisos,
 * moderación, guardrails; no todos garantizados como previos) ni 413/422 (no documentado de forma explícita).
 * El 404 solo cuenta como previo con el motivo NO_ENDPOINTS (ver más abajo).
 */
const REJECTED_BEFORE_PROCESSING: ReadonlySet<number> = new Set([400, 401, 402, 429]);

/**
 * 404 de enrutado: OpenRouter no encontró ningún endpoint que admita la petición (p. ej. «No endpoints found matching
 * your data policy»), así que no llegó a enviarla a ningún proveedor. Cualquier otro 404 sigue siendo dudoso.
 */
const NO_ENDPOINTS = /\bno endpoints found\b/i;

/** Estados cuyo motivo técnico (p. ej. «free-models-per-day», «No endpoints found matching your data policy») ayuda a diagnosticar. */
const LOG_REASON_STATUSES: ReadonlySet<number> = new Set([402, 404, 429]);

/** `error.message` del cuerpo JSON de un error (sin tratar: no debe salir del servidor tal cual). */
async function errorMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: unknown } } | null;
  const msg = body?.error?.message;
  return typeof msg === "string" ? msg : "";
}

/**
 * Motivo del rechazo SOLO para el log del servidor: únicamente `error.message` (nunca metadatos, que pueden contener la
 * entrada moderada), en una línea, recortado y sin nada con forma de clave o cabecera Authorization.
 */
function redactReason(msg: string): string {
  if (!msg.trim()) return "";
  const clean = msg
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk[-_][A-Za-z0-9_-]{6,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return `: ${clean}`;
}

/**
 * Llamada a OpenRouter con reintentos acotados (5xx, red, timeout, respuesta vacía) y salida JSON estructurada opcional.
 * Un 429 corta en el acto con AI_RATE_LIMITED (429), sin reintentar.
 */
export async function chat(opts: ChatOptions): Promise<ChatResult> {
  const key = env().OPENROUTER_API_KEY;
  if (!key) {
    logError("openrouter.config", new Error("Falta OPENROUTER_API_KEY"));
    throw new AppError(AI_MESSAGES.notConfigured, 503, "AI_NOT_CONFIGURED");
  }

  const baseBody = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.4,
    max_tokens: opts.maxTokens ?? 2000,
  };
  const structured = { response_format: { type: "json_schema", json_schema: { name: opts.schemaName ?? "result", strict: true, schema: opts.schema ? jsonSchemaFor(opts.schema) : {} } } };
  // No todos los modelos admiten salida estructurada: ante un 400 se reintenta una vez sin response_format
  // (el prompt ya exige JSON y la respuesta se valida igualmente con Zod).
  let useStructured = !!opts.schema;

  let lastErr: unknown;
  let maybeBilled = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const started = Date.now();
    try {
      let res: Response;
      try {
        res = await fetch(ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "AI Wardrobe", "HTTP-Referer": env().NEXT_PUBLIC_APP_URL },
          body: JSON.stringify(useStructured ? { ...baseBody, ...structured } : baseBody),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 45_000),
        });
      } catch (e) {
        maybeBilled = true; // sin respuesta (red o timeout): el proveedor pudo procesarla igualmente
        throw e;
      }
      // El motivo solo se lee en los estados que lo necesitan (diagnóstico en el log y clasificación del 404).
      const reason = LOG_REASON_STATUSES.has(res.status) ? await errorMessage(res) : "";
      // Solo los rechazos previos al procesamiento descartan facturación. Cualquier otro estado (2xx aunque traiga un
      // error en el cuerpo, 403, 408, 5xx, un 404 que no sea de enrutado o desconocidos) es dudoso. Una vez dudoso,
      // sigue dudoso aunque un intento posterior sea un rechazo limpio.
      const rejectedBefore = REJECTED_BEFORE_PROCESSING.has(res.status) || (res.status === 404 && NO_ENDPOINTS.test(reason));
      if (!rejectedBefore) maybeBilled = true;
      // 429 no se reintenta: con modelos gratuitos suele ser el cupo diario o por minuto de la cuenta, y cada
      // reintento gastaría otra petición del cupo sin poder tener éxito.
      if (res.status === 429) {
        logError("openrouter.rate_limited", new Error(`OpenRouter 429${redactReason(reason)}`));
        throw new AiProviderError(AI_MESSAGES.rateLimited, 429, "AI_RATE_LIMITED", maybeBilled);
      }
      if (res.status >= 500) throw new Error(`OpenRouter ${res.status}`);
      if (res.status === 400 && useStructured) { useStructured = false; throw new Error("OpenRouter 400 con response_format"); }
      if (!res.ok) {
        logError("openrouter.rejected", new Error(`OpenRouter ${res.status}${redactReason(reason)}`));
        throw new AiProviderError(AI_MESSAGES.unavailable, 502, "AI_UPSTREAM", maybeBilled);
      }
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        error?: { message?: string };
      };
      const text = data.choices?.[0]?.message?.content;
      if (!text) throw new Error(data.error?.message ?? "Respuesta vacía de OpenRouter");
      return {
        text,
        model: opts.model,
        latencyMs: Date.now() - started,
        usage: { inputTokens: data.usage?.prompt_tokens ?? null, outputTokens: data.usage?.completion_tokens ?? null },
      };
    } catch (err) {
      if (err instanceof AppError) throw err;
      lastErr = err;
      if (attempt < 2) await sleep(800 * 2 ** attempt);
    }
  }
  logError("openrouter.unavailable", lastErr);
  throw new AiProviderError(AI_MESSAGES.unavailable, 502, "AI_UNAVAILABLE", maybeBilled);
}

/** Extrae JSON aunque el modelo lo envuelva en ``` y lo valida con Zod. */
export function parseJson<T>(text: string, schema: z.ZodType<T>): T {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return schema.parse(JSON.parse(cleaned));
}

/** Una respuesta de IA mal formada es un fallo del proveedor (502), no un error de validación del usuario (422). */
export function asAiError(err: unknown): unknown {
  return err instanceof z.ZodError || err instanceof SyntaxError
    ? new AppError("La IA devolvió una respuesta no válida. Inténtalo de nuevo en unos segundos.", 502, "AI_INVALID")
    : err;
}

/**
 * ¿Se puede afirmar con seguridad que una llamada fallida a OpenRouter no se procesó ni facturó? Solo si no se llegó a
 * llamar (sin configurar) o todos los intentos recibieron un rechazo previo al procesamiento (`maybeBilled=false`).
 * Timeouts, errores de red, respuestas inválidas, 5xx, 403, 404 que no sean de enrutado, estados desconocidos y
 * errores ajenos: no.
 */
export function isSurelyNotBilled(err: unknown): boolean {
  if (err instanceof AiProviderError) return !err.maybeBilled;
  return err instanceof AppError && err.code === "AI_NOT_CONFIGURED";
}
