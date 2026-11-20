import https from "node:https";
import type { LookupAddress, LookupOptions } from "node:dns";
import { Readable } from "node:stream";

/** Dirección ya resuelta Y validada como pública por quien llama. */
export interface ResolvedAddress { address: string; family: 4 | 6 }

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * Función `lookup` para net/tls que SOLO devuelve las direcciones validadas: Node la usa en lugar de dns.lookup, así que
 * al conectar no hay una segunda resolución que pueda cambiar el destino (DNS rebinding). Con `autoSelectFamily` (por
 * defecto en Node ≥ 20) se pide con `all: true` y se devuelven todas las validadas; si no, la primera.
 */
export function pinnedLookup(addresses: readonly ResolvedAddress[]) {
  return (_hostname: string, options: LookupOptions | number, callback: LookupCallback): void => {
    const opts: LookupOptions = typeof options === "number" ? { family: options } : (options ?? {});
    const family = opts.family === "IPv4" ? 4 : opts.family === "IPv6" ? 6 : opts.family;
    const usable = family === 4 || family === 6 ? addresses.filter((a) => a.family === family) : addresses;
    if (usable.length === 0) {
      callback(Object.assign(new Error("Sin dirección validada para conectar"), { code: "ENOTFOUND" }), "", 0);
      return;
    }
    if (opts.all) callback(null, usable.map((a) => ({ address: a.address, family: a.family })));
    else callback(null, usable[0]!.address, usable[0]!.family);
  };
}

/** Estados que no pueden llevar cuerpo en un `Response`. */
const NULL_BODY = new Set([204, 205, 304]);

/**
 * GET HTTPS conectado a una de las direcciones validadas. El hostname original se conserva para SNI, la verificación
 * del certificado (rejectUnauthorized por defecto, nunca desactivado) y la cabecera Host. No sigue redirecciones: la
 * respuesta se devuelve tal cual (como `Response`) para que quien llama valide cada salto. `signal` aborta la conexión
 * y la lectura del cuerpo. `ca` solo existe para las pruebas (una CA de test); en producción se usa la del sistema.
 */
export function requestPinned(url: URL, addresses: readonly ResolvedAddress[], opts: { signal: AbortSignal; ca?: string | Buffer }): Promise<Response> {
  const { signal } = opts;
  return new Promise<Response>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
    const req = https.request(
      {
        protocol: "https:",
        hostname,
        servername: hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { accept: "image/jpeg, image/png, image/webp" },
        lookup: pinnedLookup(addresses),
        agent: false, // conexión propia: nunca se reutiliza un socket abierto con otra resolución
        signal,
        ...(opts.ca && { ca: opts.ca }),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status > 599) { res.destroy(); reject(new Error(`Estado HTTP no válido (${status})`)); return; }
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) for (const x of [v ?? []].flat()) headers.append(k, x);
        if (NULL_BODY.has(status)) res.destroy();
        const body = NULL_BODY.has(status) ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>);
        resolve(new Response(body, { status, headers }));
      },
    );
    req.on("error", (err) => reject(signal.aborted ? signal.reason : err));
    req.end();
  });
}
