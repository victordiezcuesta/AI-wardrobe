import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinnedLookup, requestPinned } from "@/lib/uploads/pinned-request";

/**
 * Conexión fijada con sockets y TLS REALES, todo en local: servidores HTTPS en 127.0.0.1 (destino) y 127.0.0.2
 * (señuelo) con un certificado de una CA de prueba generada al vuelo. Los nombres son `.invalid` (RFC 6761: nunca
 * resuelven), así que ninguna prueba sale a internet. El DNS de Node se sustituye por un espía que «rebindea» al señuelo:
 * si la conexión volviera a resolver el nombre, acabaría en el señuelo y la prueba lo detectaría.
 */
const HOST = "images.invalid";
const TARGET_IP = "127.0.0.1";
const DECOY_IP = "127.0.0.2";
const PINNED = [{ address: TARGET_IP, family: 4 as const }];

let dir: string;
let ca: Buffer;
let port: number;
let target: https.Server;
let decoy: https.Server | null = null;
const hits: { who: string; host?: string; servername?: string | false | null; path?: string }[] = [];

function server(who: string) {
  return https.createServer({ key: readFileSync(join(dir, "leaf.key")), cert: readFileSync(join(dir, "leaf.crt")) }, (req, res) => {
    const servername = (req.socket as import("node:tls").TLSSocket).servername;
    hits.push({ who, host: req.headers.host, servername, path: req.url });
    if (req.url === "/hang") return; // nunca responde
    if (req.url === "/slow-body") { res.writeHead(200, { "content-type": "image/png" }); res.write("\x89PNG"); return; } // cuerpo que no termina
    if (req.url === "/redirect") { res.writeHead(302, { location: `https://${HOST}:${port}/final` }); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ who, host: req.headers.host, servername }));
  });
}
const listen = (s: https.Server, ip: string, p = 0) =>
  new Promise<number>((resolve, reject) => { s.once("error", reject); s.listen(p, ip, () => resolve((s.address() as AddressInfo).port)); });

/** dns del propio Node (CommonJS): net/tls lo consultan aquí cuando no se les da un `lookup`. */
const nodeDns = createRequire(import.meta.url)("node:dns") as typeof import("node:dns");
const originalLookup = nodeDns.lookup;
let dnsCalls: string[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pinned-tls-"));
  const ssl = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
  ssl("req", "-x509", ...ec, "-keyout", "ca.key", "-out", "ca.crt", "-days", "2", "-subj", "/CN=AI Wardrobe Test CA");
  ssl("req", ...ec, "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", `/CN=${HOST}`);
  writeFileSync(join(dir, "ext.cnf"), `subjectAltName=DNS:${HOST}\n`);
  ssl("x509", "-req", "-in", "leaf.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.crt", "-days", "2", "-extfile", "ext.cnf");
  ca = readFileSync(join(dir, "ca.crt"));

  target = server("target");
  port = await listen(target, TARGET_IP);
  const d = server("decoy");
  decoy = await listen(d, DECOY_IP, port).then(() => d, () => null); // 127.0.0.2 existe en Linux; si no, se omite esa prueba

  // DNS «envenenado»: cualquier resolución que haga Node apunta al señuelo.
  (nodeDns as { lookup: unknown }).lookup = (hostname: string, options: unknown, cb?: unknown) => {
    dnsCalls.push(hostname);
    const callback = (typeof options === "function" ? options : cb) as (e: null, a: unknown, f?: number) => void;
    const all = typeof options === "object" && options !== null && (options as { all?: boolean }).all;
    callback(null, all ? [{ address: DECOY_IP, family: 4 }] : DECOY_IP, 4);
  };
}, 30_000);

afterAll(async () => {
  (nodeDns as { lookup: unknown }).lookup = originalLookup;
  await new Promise((r) => target?.close(r));
  if (decoy) await new Promise((r) => decoy!.close(r));
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => { hits.length = 0; dnsCalls = []; });

const signal = (ms = 5_000) => AbortSignal.timeout(ms);
const url = (path: string, host = HOST) => new URL(`https://${host}:${port}${path}`);

describe("requestPinned: la conexión usa la IP validada", () => {
  it("control: SIN fijar la IP, Node resuelve el nombre por DNS y acaba en el señuelo (el espía funciona)", async (ctx) => {
    if (!decoy) ctx.skip();
    const body = await new Promise<string>((resolve, reject) => {
      https.get({ hostname: HOST, port, path: "/control", ca, agent: false }, (res) => {
        let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve(b));
      }).on("error", reject);
    });
    expect(JSON.parse(body).who).toBe("decoy");
    expect(dnsCalls).toEqual([HOST]);
  });

  it("CON la IP fijada: conecta a la IP validada aunque el DNS diga otra cosa, y no hay segunda resolución", async () => {
    const res = await requestPinned(url("/ok"), PINNED, { signal: signal(), ca });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ who: "target", host: `${HOST}:${port}`, servername: HOST });
    expect(dnsCalls).toEqual([]); // Node no consultó el DNS
    expect(hits.map((h) => h.who)).toEqual(["target"]); // el señuelo no recibió nada
  });

  it("mantiene el hostname original: SNI y cabecera Host = nombre, nunca la IP", async () => {
    await (await requestPinned(url("/sni"), PINNED, { signal: signal(), ca })).text();
    expect(hits[0]).toMatchObject({ who: "target", servername: HOST, host: `${HOST}:${port}` });
  });

  it("varias direcciones validadas → solo se usan esas (con autoSelectFamily se entregan todas, y ninguna otra)", async () => {
    const res = await requestPinned(url("/multi"), [{ address: TARGET_IP, family: 4 }, { address: "::1", family: 6 }], { signal: signal(), ca });
    expect(res.status).toBe(200);
    expect(dnsCalls).toEqual([]);
  });

  it("sin direcciones validadas → no conecta (ENOTFOUND) ni resuelve por su cuenta", async () => {
    await expect(requestPinned(url("/none"), [], { signal: signal(), ca })).rejects.toMatchObject({ code: "ENOTFOUND" });
    expect(hits).toEqual([]);
    expect(dnsCalls).toEqual([]);
  });
});

describe("requestPinned: TLS sigue validando el hostname original", () => {
  it("certificado de otro nombre → rechazado (ERR_TLS_CERT_ALTNAME_INVALID), aunque la IP sea la validada", async () => {
    await expect(requestPinned(url("/x", "otro.invalid"), PINNED, { signal: signal(), ca })).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    expect(hits).toEqual([]); // no llegó a enviarse la petición
  });

  it("CA no reconocida → rechazado: la verificación de certificados no está desactivada", async () => {
    await expect(requestPinned(url("/x"), PINNED, { signal: signal() })).rejects.toMatchObject({ code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" });
    expect(hits).toEqual([]);
  });
});

describe("requestPinned: redirecciones, timeout y recursos", () => {
  it("no sigue redirecciones: devuelve el 302 con su Location para que fetchImage valide el salto", async () => {
    const res = await requestPinned(url("/redirect"), PINNED, { signal: signal(), ca });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`https://${HOST}:${port}/final`);
    expect(hits.map((h) => h.path)).toEqual(["/redirect"]);
  });

  it("el servidor no responde → TimeoutError", async () => {
    const started = Date.now();
    await expect(requestPinned(url("/hang"), PINNED, { signal: signal(100), ca })).rejects.toMatchObject({ name: "TimeoutError" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("el cuerpo deja de llegar → la señal corta la lectura y cierra la conexión", async () => {
    const s = signal(150);
    const res = await requestPinned(url("/slow-body"), PINNED, { signal: s, ca });
    await expect(res.arrayBuffer()).rejects.toThrow();
    expect(s.aborted).toBe(true);
  });

  it("señal ya abortada → no conecta", async () => {
    const c = new AbortController();
    c.abort(new Error("cancelada"));
    await expect(requestPinned(url("/x"), PINNED, { signal: c.signal, ca })).rejects.toThrow("cancelada");
    expect(hits).toEqual([]);
  });
});

describe("pinnedLookup", () => {
  const two = [{ address: "104.18.20.1", family: 4 as const }, { address: "2606:4700::1", family: 6 as const }];
  const call = (opts: object | number) => new Promise<unknown[]>((resolve) => pinnedLookup(two)("cualquiera.example", opts as never, (...a) => resolve(a)));

  it("all: true → todas las validadas", async () => expect(await call({ all: true })).toEqual([null, two]));
  it("sin all → la primera validada", async () => expect(await call({})).toEqual([null, "104.18.20.1", 4]));
  it.each([[{ family: 6 }], [{ family: "IPv6" }], [6]])("familia %j → solo las de esa familia", async (opts) => expect(await call(opts)).toEqual([null, "2606:4700::1", 6]));
  it("el nombre pedido no influye: nunca devuelve otra dirección", async () => {
    const spy = vi.fn();
    pinnedLookup([two[0]!])("evil.example", { all: true }, spy);
    expect(spy).toHaveBeenCalledWith(null, [two[0]]);
  });
});
