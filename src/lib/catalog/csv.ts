import type { Readable } from "node:stream";

/** Detecta el separador de la cabecera: los feeds llegan con coma, tabulador o barra vertical. */
export function detectDelimiter(headerLine: string): string {
  const counts = [",", "\t", "|", ";"].map((d) => [d, headerLine.split(d).length - 1] as const);
  return counts.sort((a, b) => b[1] - a[1])[0]![0];
}

/**
 * Parser CSV en streaming (RFC 4180): comillas, comillas escapadas ("") y saltos de línea dentro de campos.
 * Procesa por trozos, así que un catálogo de cientos de miles de filas no se carga entero en memoria.
 */
export async function* parseCsv(stream: Readable | AsyncIterable<Buffer | string>, delimiter?: string): AsyncGenerator<string[]> {
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let pendingQuote = false; // vimos " dentro de comillas; falta saber si es cierre o escape
  let first = true;
  let delim = delimiter;
  const decoder = new TextDecoder("utf-8");

  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { pushField(); const r = row; row = []; return r; };

  function* feed(text: string): Generator<string[]> {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (first) { first = false; if (ch === "\uFEFF") continue; } // BOM
      if (!delim && !inQuotes && (ch === "\n" || ch === "\r")) {
        delim = detectDelimiter(field);
        // Se reprocesa la cabecera ya acumulada con el separador detectado.
        const header = field; field = ""; row = [];
        let q = false, cur = "";
        for (const c of header) {
          if (c === '"') { q = !q; cur += c; } else if (c === delim && !q) { row.push(unquote(cur)); cur = ""; } else cur += c;
        }
        row.push(unquote(cur));
        const r = row; row = [];
        if (ch === "\r" && text[i + 1] === "\n") i++;
        yield r;
        continue;
      }
      if (pendingQuote) {
        pendingQuote = false;
        if (ch === '"') { field += '"'; continue; }
        inQuotes = false; // era un cierre
      }
      if (inQuotes) {
        if (ch === '"') pendingQuote = true; else field += ch;
        continue;
      }
      if (ch === '"' && field === "") { inQuotes = true; continue; }
      if (delim && ch === delim) { pushField(); continue; }
      if (ch === "\n") { if (delim) yield pushRow(); continue; }
      if (ch === "\r") { if (text[i + 1] === "\n") i++; if (delim) yield pushRow(); continue; }
      field += ch;
    }
  }

  for await (const chunk of stream) {
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    yield* feed(text);
  }
  const tail = decoder.decode();
  if (tail) yield* feed(tail);
  if (pendingQuote) inQuotes = false;
  if (field !== "" || row.length > 0) { if (!delim) delim = ","; yield pushRow(); }
}

const unquote = (s: string) => (s.startsWith('"') && s.endsWith('"') && s.length >= 2 ? s.slice(1, -1).replace(/""/g, '"') : s);

/** Convierte filas en objetos usando la cabecera (nombres en minúsculas). */
export async function* parseCsvRecords(stream: Readable | AsyncIterable<Buffer | string>, delimiter?: string): AsyncGenerator<Record<string, string>> {
  let header: string[] | null = null;
  for await (const row of parseCsv(stream, delimiter)) {
    if (!header) { header = row.map((h) => h.trim().toLowerCase()); continue; }
    if (row.length === 1 && row[0] === "") continue;
    const rec: Record<string, string> = {};
    header.forEach((h, i) => { rec[h] = (row[i] ?? "").trim(); });
    yield rec;
  }
}
