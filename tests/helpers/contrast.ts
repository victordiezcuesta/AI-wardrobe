/**
 * Análisis estático de contraste de las clases de Tailwind de un archivo fuente (H7-04, ampliado). Para cada línea toma las cadenas entre comillas dobles o
 * invertidas y, de cada una, los colores `text-*` y `bg-*` de los tokens del proyecto (con opacidad), INCLUIDAS las variantes (`hover:`, `focus:`,
 * `focus-visible:`, `group-hover:`, `aria-pressed:`, `placeholder:`…). Evalúa:
 *  - cada ESTADO (base y cada variante presente): texto efectivo (el del estado o, si no hay, el base) sobre el fondo efectivo (idem);
 *  - sin fondo propio: sobre paper y linen (las superficies de contenido) — el texto sin fondo hereda el de un ancestro que no se conoce estáticamente;
 *  - texto de una cadena sin fondo con el fondo de OTRA cadena de la misma línea (clases repartidas entre expresiones, p. ej. `cn("text-taupe", on ? "bg-sand" : "")`).
 * LIMITACIONES: solo ve cadenas de una línea; no sabe qué ramas de un ternario son excluyentes (puede combinar de más: preferible a combinar de menos);
 * `disabled:` queda fuera (el contraste de los controles deshabilitados está exento). Las medidas son aritmética sobre los tokens, no capturas.
 */
export interface Finding { file: string; line: number; state: string; text: string; bg: string; ratio: number }
export interface Analysis { findings: Finding[]; evaluated: number; states: Set<string> }

const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
const lin = (c: number) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
export const luminance = (h: string) => { const [r, g, b] = rgb(h); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
export const contrast = (a: string, b: string) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]; return (hi + 0.05) / (lo + 0.05); };
export const blend = (fg: string, bg: string, a: number) => "#" + rgb(fg).map((x, i) => Math.round(a * x + (1 - a) * rgb(bg)[i]!).toString(16).padStart(2, "0")).join("");

interface Tok { variant: string; kind: "text" | "bg"; name: string; alpha: number }
const TOKEN = /^((?:[a-z0-9-]+(?:\[[^\]]*\])?:)*)(text|bg)-([a-z]+)(?:\/(\d+))?$/;

export function analyze(source: string, file: string, colors: Record<string, string>, min = 4.5): Analysis {
  const out: Analysis = { findings: [], evaluated: 0, states: new Set() };
  const parse = (s: string): Tok[] => s.split(/\s+/).flatMap((t) => {
    const m = TOKEN.exec(t);
    return m && m[3]! in colors ? [{ variant: m[1]!, kind: m[2] as "text" | "bg", name: m[3]!, alpha: m[4] ? Number(m[4]) / 100 : 1 }] : [];
  });
  const last = (ts: Tok[], kind: Tok["kind"], variant: string) => ts.filter((t) => t.kind === kind && t.variant === variant).at(-1);
  const surfaces = (bg: Tok | undefined) => bg ? [blend(colors[bg.name]!, colors.paper!, bg.alpha)] : [colors.paper!, colors.linen!];
  const measure = (state: string, tx: Tok, bg: Tok | undefined, line: number) => {
    for (const surface of surfaces(bg)) {
      const fg = blend(colors[tx.name]!, surface, tx.alpha);
      const ratio = contrast(fg, surface);
      out.evaluated++; out.states.add(state);
      if (ratio < min) out.findings.push({ file, line, state, text: `text-${tx.name}${tx.alpha < 1 ? `/${Math.round(tx.alpha * 100)}` : ""}`, bg: bg ? `bg-${bg.name}` : "paper/linen", ratio: Math.round(ratio * 100) / 100 });
    }
  };
  source.split("\n").forEach((text, i) => {
    const lits = [...text.matchAll(/"([^"\n]*)"|`([^`\n]*)`/g)].map((m) => parse((m[1] ?? m[2]) as string)).filter((t) => t.length > 0);
    lits.forEach((ts, idx) => {
      const variants = new Set(ts.map((t) => t.variant));
      for (const v of new Set(["", ...variants])) {
        if (v.startsWith("disabled:")) continue;
        if (v === "placeholder:") { const t = last(ts, "text", v); if (t) measure("placeholder", t, last(ts, "bg", ""), i + 1); continue; }
        const tx = last(ts, "text", v) ?? last(ts, "text", "");
        if (!tx) continue;
        if (v && !last(ts, "text", v) && !last(ts, "bg", v)) continue;
        const bg = last(ts, "bg", v) ?? last(ts, "bg", "");
        measure(v || "base", tx, bg, i + 1);
        if (!bg) for (const [j, o] of lits.entries()) {                         // fondo repartido en otra cadena de la misma línea
          if (j === idx || last(o, "text", "")) continue;
          const ob = last(o, "bg", v) ?? last(o, "bg", "");
          if (ob) measure(`${v || "base"}+cruce`, tx, ob, i + 1);
        }
      }
    });
  });
  return out;
}
