import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { ResolvedAddress } from "./pinned-request";

/**
 * Validación de destinos para descargas hechas por el servidor (defensa frente a SSRF): solo HTTPS, sin credenciales
 * ni puertos explícitos, host en la lista que da quien llama y nunca direcciones locales, privadas o reservadas
 * (ni en la URL ni en lo que resuelve el DNS).
 */

/** Rangos que nunca son destino de una descarga: loopback, privados, link-local, CGNAT, documentación, multicast… */
const FORBIDDEN = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) FORBIDDEN.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 96], // sin especificar (::), loopback (::1) e IPv4 compatibles (obsoletas)
  ["100::", 64], ["2001::", 32], ["2001:db8::", 32], ["2002::", 16], // descarte, Teredo, documentación, 6to4
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8], // únicas locales, link-local, site-local, multicast
  // IPv4 incrustada en prefijos de traducción no públicos, bloqueados enteros (la IPv4 de dentro da igual):
  ["::ffff:0:0:0", 96], // IPv4-translated (RFC 2765, 0:0:0:0:ffff:0:a.b.c.d); distinto de la mapeada ::ffff:a.b.c.d
  ["64:ff9b:1::", 48], // NAT64 de uso local (RFC 8215); el NAT64 público 64:ff9b::/96 se trata en embeddedIpv4
] as const) FORBIDDEN.addSubnet(net, prefix, "ipv6");

/** 16 bytes de una IPv6 ya validada con isIP (admite «::» y un IPv4 incrustado al final). */
function ipv6Bytes(ip: string): number[] | null {
  const addr = ip.split("%")[0]!; // sin identificador de zona
  const [head = "", tail] = addr.split("::");
  const groups = (s: string) => {
    const out: number[] = [];
    for (const part of s ? s.split(":") : []) {
      if (part.includes(".")) {
        const v4 = part.split(".").map(Number);
        out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      } else out.push(parseInt(part, 16));
    }
    return out;
  };
  const h = groups(head);
  const t = tail === undefined ? [] : groups(tail);
  const words = tail === undefined ? h : [...h, ...Array<number>(8 - h.length - t.length).fill(0), ...t];
  if (words.length !== 8 || words.some((w) => !Number.isInteger(w) || w < 0 || w > 0xffff)) return null;
  return words.flatMap((w) => [w >> 8, w & 0xff]);
}

/** IPv4 incrustada en una IPv6 mapeada (::ffff:0:0/96) o NAT64 (64:ff9b::/96); null si no es ninguna de las dos. */
function embeddedIpv4(b: number[]): string | null {
  const zeros = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  const mapped = zeros(0, 10) && b[10] === 0xff && b[11] === 0xff;
  const nat64 = b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12);
  return mapped || nat64 ? b.slice(12).join(".") : null;
}

/** true si la dirección (IPv4 o IPv6, también IPv4 mapeada en IPv6) no es pública. Lo que no es una IP válida, también. */
export function isForbiddenIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return FORBIDDEN.check(ip, "ipv4");
  if (family !== 6) return true;
  const bytes = ipv6Bytes(ip);
  if (!bytes) return true;
  const v4 = embeddedIpv4(bytes);
  return v4 ? FORBIDDEN.check(v4, "ipv4") : FORBIDDEN.check(ip.split("%")[0]!, "ipv6");
}

/** Nombres que solo tienen sentido dentro de una red local o de la propia máquina. */
const LOCAL_SUFFIX = /\.(localhost|local|localdomain|internal|intranet|lan|home|corp|home\.arpa)$/;
export function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === "localhost" || !host.includes(".") || LOCAL_SUFFIX.test(host);
}

/**
 * Comprueba una URL (la inicial o el destino de una redirección) antes de pedirla. Los hosts se comparan de forma
 * exacta (sin comodines ni subdominios). Devuelve la URL ya analizada.
 */
export function assertAllowedUrl(raw: string | URL, allowedHosts: ReadonlySet<string>): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("URL de imagen no válida"); }
  if (url.protocol !== "https:") throw new Error("Solo se descargan imágenes por HTTPS");
  if (url.username || url.password) throw new Error("URL de imagen con credenciales");
  if (url.port) throw new Error("URL de imagen con puerto explícito"); // «:443» ya se normaliza a ""
  const host = url.hostname.toLowerCase();
  const bare = host.startsWith("[") ? host.slice(1, -1) : host;
  if (isIP(bare) ? isForbiddenIp(bare) : isLocalHostname(bare)) throw new Error(`Destino de imagen no permitido: ${host}`);
  if (!allowedHosts.has(host)) throw new Error(`Host de imagen no permitido: ${host}`);
  return url;
}

function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Resuelve el host UNA vez y devuelve sus direcciones solo si TODAS son públicas (basta una no pública para rechazarlo):
 * evita que un DNS manipulado lleve un host permitido a la red interna. Las direcciones devueltas son las únicas a las
 * que se conectará (ver `requestPinned`), así que no hay una segunda resolución. Sujeto al mismo timeout que la descarga.
 */
export async function resolvePublicAddresses(hostname: string, signal: AbortSignal): Promise<ResolvedAddress[]> {
  const bare = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  const family = isIP(bare);
  if (family === 4 || family === 6) {
    if (isForbiddenIp(bare)) throw new Error(`Destino de imagen no permitido: ${hostname}`);
    return [{ address: bare, family }];
  }
  const found = await abortable(lookup(bare, { all: true, verbatim: true }), signal);
  if (found.length === 0 || found.some((a) => (a.family !== 4 && a.family !== 6) || isForbiddenIp(a.address))) {
    throw new Error(`El host de la imagen resuelve a una dirección no permitida: ${hostname}`);
  }
  return found.map((a) => ({ address: a.address, family: a.family as 4 | 6 }));
}
