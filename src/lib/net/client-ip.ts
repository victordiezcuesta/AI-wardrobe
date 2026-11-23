import { isIP } from "node:net";

/**
 * Fase 19.12c — IP del cliente como CLAVE de rate limiting. Función pura: no lanza, no registra y devuelve siempre
 * `string | null` (nunca una clave compartida tipo "unknown": sin IP fiable, el llamador omite el límite por IP).
 *
 * Política (aprobada en 19.12b):
 *  - Solo en Vercel (`env.VERCEL === "1"`, variable de sistema de la plataforma, nunca un dato de la petición).
 *  - Solo `x-forwarded-for`: Vercel documenta que la sobrescribe y no reenvía IP externas «to prevent IP spoofing». Esa
 *    garantía no se extiende a `x-vercel-forwarded-for` ni a `x-real-ip`, que se ignoran.
 *  - Fuera de Vercel (autoalojado, local, pruebas) → null siempre, aunque haya cabeceras: sin un proxy verificable, la
 *    cabecera la puede escribir el cliente.
 *  - Cabecera ausente, vacía, con varias IP, demasiado larga o que no sea EXACTAMENTE una IP → null. No se elige ni
 *    «el primero» ni «el último» de una lista, ni se intenta limpiar puertos, corchetes o zonas.
 *
 * Clave devuelta: `v4:<a.b.c.d>`, o `v6:<4 primeros grupos>` (prefijo /64, en hexadecimal sin ceros a la izquierda). Una
 * IPv4 mapeada en IPv6 (::ffff:a.b.c.d) da la misma clave que la IPv4. No se descartan direcciones privadas.
 */
export const CLIENT_IP_HEADER = "x-forwarded-for";
/** Antes de analizar nada: una cabecera más larga que esto no puede ser una única IP (máximo textual: 45). */
const MAX_HEADER_LENGTH = 64;
const MAX_IP_LENGTH = 45;
/** Solo los caracteres que puede tener una IP sin zona, puerto ni corchetes. */
const IP_CHARS = /^[0-9A-Fa-f:.]+$/;
/** Espacio exterior admitido: el OWS de HTTP (espacio y tabulador), nada más. */
const OUTER_SPACE = /^[ \t]+|[ \t]+$/g;

/** Los 8 grupos de una IPv6 en la forma canónica de WHATWG URL (comprimida, minúsculas, IPv4 incrustada en hex). */
function groupsOf(canonical: string): number[] | null {
  const parts = canonical.split("::");
  if (parts.length > 2) return null;
  const toGroups = (s: string) => (s === "" ? [] : s.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)));
  const head = toGroups(parts[0]!);
  const tail = parts.length === 2 ? toGroups(parts[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (parts.length === 1 ? fill !== 0 : fill < 1) return null;
  const groups = [...head, ...Array<number>(parts.length === 2 ? fill : 0).fill(0), ...tail];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function keyOf(value: string): string | null {
  const family = isIP(value);
  if (family === 4) return `v4:${value}`; // isIP rechaza ceros a la izquierda, puertos y formas abreviadas
  if (family !== 6) return null;
  // isIP admite zonas (fe80::1%eth0): aquí no. Con el filtro de caracteres previo ya no pueden llegar, pero se comprueba.
  if (value.includes("%")) return null;
  // El serializador de URL fija una forma canónica única para cada dirección (RFC 5952): equivalentes → mismo texto.
  const host = new URL(`http://[${value}]/`).hostname;
  if (!host.startsWith("[") || !host.endsWith("]")) return null;
  const groups = groupsOf(host.slice(1, -1));
  if (!groups) return null;
  // IPv4 mapeada (::ffff:a.b.c.d): misma clave que la IPv4.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const [hi, lo] = [groups[6]!, groups[7]!];
    return `v4:${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return `v6:${groups.slice(0, 4).map((g) => g.toString(16)).join(":")}`;
}

export function resolveClientIp(headers: Headers, env: { VERCEL?: string } = { VERCEL: process.env.VERCEL }): string | null {
  try {
    if (env?.VERCEL !== "1") return null;
    const raw = headers.get(CLIENT_IP_HEADER);
    if (typeof raw !== "string" || raw.length > MAX_HEADER_LENGTH) return null;
    const value = raw.replace(OUTER_SPACE, ""); // solo espacio y tabulador (OWS de HTTP); trim() también quitaría \r, NBSP…
    if (value.length === 0 || value.length > MAX_IP_LENGTH || value.includes(",") || !IP_CHARS.test(value)) return null;
    return keyOf(value);
  } catch {
    return null;
  }
}
