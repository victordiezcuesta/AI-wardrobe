import { z } from "zod";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";

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

/** Llamada a OpenRouter con reintentos acotados (429/5xx) y salida JSON estructurada opcional. */
export async function chat(opts: ChatOptions): Promise<ChatResult> {
  const key = env().OPENROUTER_API_KEY;
  if (!key) throw new AppError("OpenRouter no está configurado (falta OPENROUTER_API_KEY)", 503, "AI_NOT_CONFIGURED");

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
  for (let attempt = 0; attempt < 3; attempt++) {
    const started = Date.now();
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "AI Wardrobe", "HTTP-Referer": env().NEXT_PUBLIC_APP_URL },
        body: JSON.stringify(useStructured ? { ...baseBody, ...structured } : baseBody),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 45_000),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`OpenRouter ${res.status}`);
      if (res.status === 400 && useStructured) { useStructured = false; throw new Error("OpenRouter 400 con response_format"); }
      if (!res.ok) throw new AppError(`OpenRouter rechazó la solicitud (${res.status})`, 502, "AI_UPSTREAM");
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
  throw new AppError(`El servicio de IA no responde: ${lastErr instanceof Error ? lastErr.message : "error"}`, 502, "AI_UNAVAILABLE");
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
