/**
 * Agrupación de los `issues` de validación que devuelve la API (`{ path, message }[]`, ver `lib/errors`) en mensajes por campo.
 * Solo organiza datos: no decide cómo se muestran ni cambia el contrato del servidor.
 *
 * - Conserva TODOS los mensajes de un mismo `path` (antes, `Object.fromEntries` se quedaba con el último).
 * - Descarta los mensajes idénticos repetidos dentro de un campo (p. ej. varios elementos de una lista con el mismo fallo).
 * - Orden determinista: el de llegada (primera aparición de cada campo y de cada mensaje); no se ordena alfabéticamente.
 * - Un `path` vacío es un error global del formulario: nunca se atribuye a un campo.
 * - Un `path` que el formulario no sabe representar (anidado o desconocido) NO se convierte en campo: va a `unmatched`.
 */
export interface IssueLike { path: string; message: string }

export interface GroupedIssues {
  /** Mensajes por campo conocido, en orden de llegada. Objeto sin prototipo: un `path` como «constructor» es un campo más. */
  fields: Record<string, string[]>;
  /** Mensajes sin campo (`path` vacío). */
  global: string[];
  /** Mensajes cuyo `path` el formulario no representa, con su `path` original. */
  unmatched: IssueLike[];
}

export interface GroupOptions {
  /** Campos que el formulario sabe mostrar. Si se omite, todo `path` no vacío se trata como campo. */
  fields?: readonly string[];
  /** Traduce un `path` a un campo del formulario (p. ej. «favoriteColors.2» → «favoriteColors»). `undefined` = no representable. */
  resolve?: (path: string) => string | undefined;
}

/** Los `issues` llegan de la red: se ignora cualquier elemento mal formado en lugar de fallar al presentarlos. */
const isIssue = (i: unknown): i is IssueLike =>
  !!i && typeof i === "object" && typeof (i as IssueLike).message === "string" && (i as IssueLike).message.trim() !== "";

export function groupIssues(issues: readonly unknown[] | null | undefined, options: GroupOptions = {}): GroupedIssues {
  const out: GroupedIssues = { fields: Object.create(null) as Record<string, string[]>, global: [], unmatched: [] };
  const known = options.fields ? new Set(options.fields) : null;
  for (const raw of issues ?? []) {
    if (!isIssue(raw)) continue;
    const message = raw.message;
    const path = typeof raw.path === "string" ? raw.path.trim() : "";
    if (path === "") { if (!out.global.includes(message)) out.global.push(message); continue; }
    const field = options.resolve ? options.resolve(path) : path;
    if (field === undefined || (known && !known.has(field))) {
      if (!out.unmatched.some((u) => u.path === path && u.message === message)) out.unmatched.push({ path, message });
      continue;
    }
    const list = (out.fields[field] ??= []);
    if (!list.includes(message)) list.push(message);
  }
  return out;
}
