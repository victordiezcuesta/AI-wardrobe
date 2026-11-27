/**
 * Analizador mínimo de CSS para pruebas: convierte el texto en un árbol de bloques (`prelude { declaraciones; hijos }`) con comentarios eliminados y
 * llaves anidadas resueltas. No es un analizador completo (no interpreta valores ni cascada), pero evita comprobar el CSS con expresiones sobre texto
 * plano: se consulta por selector/regla y por propiedad. LIMITACIÓN: describe lo escrito, no cómo lo aplica un navegador.
 */
export interface CssBlock { prelude: string; decls: Record<string, string>; children: CssBlock[] }

function parseBody(src: string): { decls: Record<string, string>; children: CssBlock[] } {
  const decls: Record<string, string> = {};
  const children: CssBlock[] = [];
  let buf = "";
  const flush = () => {
    const i = buf.indexOf(":");
    if (i > 0 && !buf.trim().startsWith("@")) decls[buf.slice(0, i).trim()] = buf.slice(i + 1).trim();
    buf = "";
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "{") {
      let depth = 1; let j = i + 1;
      for (; j < src.length && depth > 0; j++) { if (src[j] === "{") depth++; else if (src[j] === "}") depth--; }
      children.push({ prelude: buf.trim().replace(/\s+/g, " "), ...parseBody(src.slice(i + 1, j - 1)) });
      buf = ""; i = j - 1;
    } else if (c === ";") flush();
    else buf += c;
  }
  flush();
  return { decls, children };
}

export const parseCss = (text: string): CssBlock => ({ prelude: "", ...parseBody(text.replace(/\/\*[\s\S]*?\*\//g, "")) });

/** Todos los bloques cuyo `prelude` cumple el predicado, en cualquier nivel. */
export function findBlocks(root: CssBlock, test: (prelude: string) => boolean): CssBlock[] {
  return [...(root.prelude && test(root.prelude) ? [root] : []), ...root.children.flatMap((c) => findBlocks(c, test))];
}
