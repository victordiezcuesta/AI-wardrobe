import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** DNS simulado: ninguna prueba resuelve nombres reales. Por defecto, una IP pública. */
const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dns.lookup, default: { lookup: dns.lookup } }));
/** Conector simulado (su comportamiento real con TLS y sockets se prueba en pinned-request.test.ts). */
const transport = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/lib/uploads/pinned-request", () => ({ requestPinned: transport.request }));
/** La resolución real, envuelta en un espía para comparar lo que devuelve con lo que recibe el conector. */
vi.mock("@/lib/uploads/remote-url", async (orig) => {
  const m = await orig<typeof import("@/lib/uploads/remote-url")>();
  return { ...m, resolvePublicAddresses: vi.fn(m.resolvePublicAddresses) };
});
/** Guarda: fetchImage no puede usar fetch() (se comprueba tras CADA prueba del archivo). */
const fetchGuard = vi.hoisted(() => vi.fn(() => { throw new Error("fetch() no debe usarse en fetchImage"); }));

import { fetchImage } from "@/lib/uploads/validate";
import { assertAllowedUrl, isForbiddenIp, isLocalHostname, resolvePublicAddresses } from "@/lib/uploads/remote-url";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
const API = "api.cloudinary.com";
const CDN = "res.cloudinary.com";
const HOSTS = [API, CDN];
const opts = (o: Partial<{ allowedHosts: string[]; maxBytes: number; timeoutMs: number }> = {}) => ({ allowedHosts: HOSTS, maxBytes: 1024, timeoutMs: 2_000, ...o });

/** Cuerpo en streaming que registra si se canceló. */
function streamBody(chunks: Uint8Array[], onCancel = vi.fn()) {
  let i = 0;
  return { onCancel, body: new ReadableStream<Uint8Array>({ pull(c) { if (i < chunks.length) c.enqueue(chunks[i++]); else c.close(); }, cancel: onCancel }) };
}
const ok = (bytes: Buffer = PNG, headers: Record<string, string> = {}) => new Response(new Uint8Array(bytes), { status: 200, headers });
const redirect = (location: string | null, status = 302) => new Response(null, { status, headers: location === null ? {} : { location } });

/** Respuestas del conector en orden. Argumentos de cada llamada: (url, direcciones validadas, { signal }). */
let fetchMock: ReturnType<typeof vi.fn>;
const replies = (...rs: (() => Response | Promise<Response>)[]) => {
  let n = 0;
  fetchMock = transport.request.mockImplementation(async () => rs[Math.min(n++, rs.length - 1)]!());
};
const PUBLIC = [{ address: "104.18.20.1", family: 4 }];
const requested = () => fetchMock.mock.calls.map((c) => String(c[0]));
const fail = (p: Promise<unknown>) => p.then(() => { throw new Error("no falló"); }, (e: Error) => e);

beforeEach(() => {
  fetchGuard.mockClear();
  vi.stubGlobal("fetch", fetchGuard);
  vi.mocked(resolvePublicAddresses).mockClear();
  transport.request.mockReset();
  dns.lookup.mockReset();
  dns.lookup.mockResolvedValue([{ address: "104.18.20.1", family: 4 }]);
});
afterEach(() => {
  expect(fetchGuard).not.toHaveBeenCalled(); // ninguna prueba, tampoco las de rechazo, puede haber pasado por fetch()
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("isForbiddenIp", () => {
  it.each([
    "127.0.0.1", "127.255.255.254", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "192.0.2.1", "198.18.0.1", "203.0.113.5", "224.0.0.1", "255.255.255.255",
    "::", "::1", "fe80::1", "fe80::1%eth0", "fc00::1", "fd12:3456::1", "fec0::1", "ff02::1", "2001:db8::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:a9fe:a9fe", "0:0:0:0:0:ffff:192.168.0.1",
    "64:ff9b::10.0.0.1", "::127.0.0.1", "2002:7f00:1::", "no-es-una-ip", "",
  ])("bloquea %s", (ip) => expect(isForbiddenIp(ip)).toBe(true));

  it.each(["8.8.8.8", "104.18.20.1", "172.32.0.1", "192.169.0.1", "2606:4700::1111", "2a00:1450:4003::200e", "::ffff:8.8.8.8", "64:ff9b::8.8.8.8"])(
    "permite la dirección pública %s", (ip) => expect(isForbiddenIp(ip)).toBe(false),
  );

  describe("prefijos de traducción IPv4 no públicos (bloqueados enteros)", () => {
    it.each([
      ["IPv4-translated con IPv4 privada", "::ffff:0:10.0.0.1"],
      ["IPv4-translated con IPv4 privada (hex)", "::ffff:0:a00:1"],
      ["IPv4-translated con metadatos de la nube", "::ffff:0:169.254.169.254"],
      ["IPv4-translated con loopback", "0:0:0:0:ffff:0:127.0.0.1"],
      ["IPv4-translated con IPv4 pública", "::ffff:0:8.8.8.8"],
      ["IPv4-translated, inicio del prefijo", "0:0:0:0:ffff:0:0:0"],
      ["IPv4-translated, final del prefijo", "0:0:0:0:ffff:0:ffff:ffff"],
      ["NAT64 de uso local con IPv4 privada", "64:ff9b:1::10.0.0.1"],
      ["NAT64 de uso local con IPv4 privada (hex)", "64:ff9b:1::a00:1"],
      ["NAT64 de uso local con IPv4 pública", "64:ff9b:1::8.8.8.8"],
      ["NAT64 de uso local, final del prefijo /48", "64:ff9b:1:ffff:ffff:ffff:ffff:ffff"],
    ])("%s (%s) → bloqueada", (_n, ip) => expect(isForbiddenIp(ip)).toBe(true));

    it.each([
      ["IPv4 mapeada pública (prefijo distinto)", "::ffff:8.8.8.8"],
      ["NAT64 público con IPv4 pública", "64:ff9b::8.8.8.8"],
      ["IPv6 pública", "2606:4700::1111"],
      ["IPv6 pública", "2a00:1450:4003::200e"],
    ])("sin falsos positivos: %s (%s) → permitida", (_n, ip) => expect(isForbiddenIp(ip)).toBe(false));

    it.each([
      ["justo por debajo de ::ffff:0:0:0/96", "::fffe:0:0:0"],
      ["justo por encima de ::ffff:0:0:0/96", "::ffff:1:0:0"],
      ["mismo valor en otra posición", "0:0:0:1:ffff:0:0:1"],
      ["fuera de 64:ff9b:1::/48 (por encima)", "64:ff9b:2::1"],
      ["fuera de 64:ff9b:1::/48 (por debajo)", "64:ff9b:0:ffff::1"],
    ])("límite exacto del prefijo: %s (%s) → no la bloquea esta regla", (_n, ip) => expect(isForbiddenIp(ip)).toBe(false));
  });
});

describe("isLocalHostname", () => {
  it.each(["localhost", "LOCALHOST", "localhost.", "api.localhost", "printer.local", "db.internal", "nas.lan", "router.home.arpa", "intranet"])(
    "%s es local", (h) => expect(isLocalHostname(h)).toBe(true),
  );
  it.each(["res.cloudinary.com", "gen.pollinations.ai"])("%s no es local", (h) => expect(isLocalHostname(h)).toBe(false));
});

describe("assertAllowedUrl", () => {
  const allowed = new Set(HOSTS);
  it("acepta HTTPS de un host permitido (también con :443 explícito, que se normaliza)", () => {
    expect(assertAllowedUrl(`https://${CDN}/demo/image/upload/a.jpg`, allowed).hostname).toBe(CDN);
    expect(assertAllowedUrl(`https://${CDN}:443/a.jpg`, allowed).hostname).toBe(CDN);
  });
  it.each([
    ["HTTP", `http://${CDN}/a.jpg`, /HTTPS/],
    ["otro esquema", `ftp://${CDN}/a.jpg`, /HTTPS/],
    ["host no permitido", "https://evil.example.com/a.jpg", /no permitido/],
    ["subdominio de un host permitido", `https://x.${CDN}/a.jpg`, /no permitido/],
    ["sufijo engañoso", `https://${CDN}.evil.com/a.jpg`, /no permitido/],
    ["credenciales", `https://user:pass@${CDN}/a.jpg`, /credenciales/],
    ["solo usuario", `https://user@${CDN}/a.jpg`, /credenciales/],
    ["puerto inesperado", `https://${CDN}:8443/a.jpg`, /puerto/],
    ["URL malformada", "https://[no-cierra/a.jpg", /no válida/],
    ["texto que no es URL", "no es una url", /no válida/],
  ])("rechaza %s", (_n, url, msg) => expect(() => assertAllowedUrl(url, allowed)).toThrow(msg));

  it.each([
    "https://localhost/a.jpg", "https://api.localhost/a.jpg", "https://127.0.0.1/a.jpg", "https://2130706433/a.jpg", "https://0177.0.0.1/a.jpg",
    "https://10.0.0.1/a.jpg", "https://192.168.0.10/a.jpg", "https://169.254.169.254/latest/meta-data", "https://[::1]/a.jpg",
    "https://[fe80::1]/a.jpg", "https://[fd00::1]/a.jpg", "https://[::ffff:127.0.0.1]/a.jpg", "https://[::ffff:169.254.169.254]/a.jpg",
    "https://[::ffff:0:a00:1]/a.jpg", "https://[64:ff9b:1::a00:1]/a.jpg",
  ])("rechaza %s aunque quien llama lo incluyera en la lista", (url) => {
    const host = new URL(url).hostname;
    expect(() => assertAllowedUrl(url, new Set([...HOSTS, host]))).toThrow(/no permitido/);
  });
});

describe("fetchImage", () => {
  it.each([["PNG", PNG, "image/png"], ["JPEG", JPEG, "image/jpeg"], ["WebP", WEBP, "image/webp"]])(
    "HTTPS de un host permitido → bytes y mime de la firma (%s); sin seguir redirecciones automáticamente", async (_n, bytes, mime) => {
      replies(() => ok(bytes));
      const out = await fetchImage(`https://${CDN}/demo/image/upload/a.jpg`, opts());
      expect(out).toEqual({ bytes, mime });
      const [reqUrl, addresses, o] = fetchMock.mock.calls[0]! as [URL, unknown, { signal: AbortSignal }];
      expect(reqUrl.hostname).toBe(CDN); // el hostname original se conserva (TLS/SNI/Host); la IP va aparte
      expect(addresses).toEqual(PUBLIC); // se conecta a la IP resuelta y validada
      expect(o.signal).toBeInstanceOf(AbortSignal);
      expect(dns.lookup).toHaveBeenCalledTimes(1);
      expect(dns.lookup).toHaveBeenCalledWith(CDN, { all: true, verbatim: true });
    },
  );

  it.each([
    ["HTTP", `http://${CDN}/a.jpg`],
    ["host no permitido", "https://evil.example.com/a.jpg"],
    ["localhost", "https://localhost/a.jpg"],
    ["IPv4 privada", "https://10.0.0.1/a.jpg"],
    ["IPv6 loopback", "https://[::1]/a.jpg"],
  ])("%s → rechazada sin llamar a fetch ni al DNS", async (_n, url) => {
    replies(() => ok());
    await expect(fetchImage(url, opts())).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe("DNS y conexión fijada", () => {
    it("resolución pública → se conecta pasando exactamente las direcciones validadas, sin volver a resolver", async () => {
      const both = [{ address: "104.18.20.1", family: 4 }, { address: "2606:4700::6812:1401", family: 6 }];
      dns.lookup.mockResolvedValue(both);
      replies(() => ok());
      await fetchImage(`https://${CDN}/a.jpg`, opts());
      expect(fetchMock.mock.calls[0]![1]).toEqual(both);
      expect(dns.lookup).toHaveBeenCalledTimes(1); // una sola resolución por salto: la que se valida
    });

    it.each([["127.0.0.1", 4], ["10.1.2.3", 4], ["169.254.169.254", 4], ["::1", 6], ["fd00::5", 6], ["::ffff:192.168.1.1", 6], ["::ffff:0:a00:1", 6], ["64:ff9b:1::a00:1", 6]])(
      "un host permitido que resuelve a %s → rechazado sin descargar", async (address, family) => {
        dns.lookup.mockResolvedValue([{ address, family }]);
        replies(() => ok());
        await expect(fetchImage(`https://${CDN}/a.jpg`, opts())).rejects.toThrow(/resuelve a una dirección no permitida/);
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );
    it("basta con UNA dirección privada entre varias para rechazarlo", async () => {
      dns.lookup.mockResolvedValue([{ address: "104.18.20.1", family: 4 }, { address: "10.0.0.7", family: 4 }]);
      replies(() => ok());
      await expect(fetchImage(`https://${CDN}/a.jpg`, opts())).rejects.toThrow(/no permitida/);
      expect(fetchMock).not.toHaveBeenCalled();
    });
    it("sin direcciones o con error de resolución → rechazado", async () => {
      replies(() => ok());
      dns.lookup.mockResolvedValue([]);
      await expect(fetchImage(`https://${CDN}/a.jpg`, opts())).rejects.toThrow();
      dns.lookup.mockRejectedValue(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }));
      await expect(fetchImage(`https://${CDN}/a.jpg`, opts())).rejects.toThrow(/ENOTFOUND/);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("redirecciones", () => {
    it("api.cloudinary.com → res.cloudinary.com (flujo de signedUrl) → se valida y descarga el destino", async () => {
      replies(() => redirect(`https://${CDN}/demo/image/authenticated/s--x--/p1.jpg`), () => ok());
      const out = await fetchImage(`https://${API}/v1_1/demo/image/download?sig=1`, opts());
      expect(out.mime).toBe("image/png");
      expect(requested()).toEqual([`https://${API}/v1_1/demo/image/download?sig=1`, `https://${CDN}/demo/image/authenticated/s--x--/p1.jpg`]);
      expect(dns.lookup.mock.calls.map((c) => c[0])).toEqual([API, CDN]); // cada salto se resuelve y comprueba
    });

    it.each([301, 302, 303, 307, 308])("estado %i con Location relativa → se resuelve contra la URL actual", async (status) => {
      replies(() => redirect("/demo/image/upload/b.jpg", status), () => ok());
      await fetchImage(`https://${CDN}/demo/image/upload/a.jpg`, opts());
      expect(requested()[1]).toBe(`https://${CDN}/demo/image/upload/b.jpg`);
    });

    it("exactamente 3 redirecciones → se permite", async () => {
      replies(() => redirect(`https://${CDN}/1`), () => redirect(`https://${CDN}/2`), () => redirect(`https://${CDN}/3`), () => ok());
      await expect(fetchImage(`https://${CDN}/0`, opts())).resolves.toMatchObject({ mime: "image/png" });
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it("más de 3 redirecciones → rechazada sin pedir la cuarta", async () => {
      replies(() => redirect(`https://${CDN}/siguiente`));
      await expect(fetchImage(`https://${CDN}/0`, opts())).rejects.toThrow(/Demasiadas redirecciones/);
      expect(fetchMock).toHaveBeenCalledTimes(4); // la inicial + 3 saltos; el 4.º no se sigue
    });

    it.each([
      ["dominio no autorizado", "https://evil.example.com/x.png", /no permitido/],
      ["HTTP en un host permitido", `http://${CDN}/x.png`, /HTTPS/],
      ["localhost", "https://localhost/x.png", /no permitido/],
      ["localhost con puerto", "http://localhost:3000/admin", /HTTPS/],
      ["IPv4 privada", "https://192.168.1.1/x.png", /no permitido/],
      ["metadatos de la nube", "https://169.254.169.254/latest/meta-data/", /no permitido/],
      ["IPv6 loopback", "https://[::1]/x.png", /no permitido/],
      ["IPv4 mapeada en IPv6", "https://[::ffff:10.0.0.1]/x.png", /no permitido/],
      ["credenciales", `https://a:b@${CDN}/x.png`, /credenciales/],
      ["puerto", `https://${CDN}:444/x.png`, /puerto/],
      ["Location malformada", "https://[roto/x.png", /Redirección no válida/],
    ])("redirección a %s → rechazada sin descargar el destino; el cuerpo del 3xx se cancela", async (_n, location, msg) => {
      const r = redirect(location);
      const cancel = vi.spyOn(r.body ?? new ReadableStream(), "cancel");
      replies(() => r, () => ok());
      await expect(fetchImage(`https://${API}/v1_1/demo/image/download`, opts())).rejects.toThrow(msg);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      if (r.body) expect(cancel).toHaveBeenCalled();
    });

    it("redirección a un host permitido que resuelve a una IP privada → rechazada antes de pedirla", async () => {
      dns.lookup.mockImplementation(async (h: string) => [{ address: h === CDN ? "10.0.0.9" : "104.18.20.1", family: 4 }]);
      replies(() => redirect(`https://${CDN}/x.png`), () => ok());
      await expect(fetchImage(`https://${API}/download`, opts())).rejects.toThrow(/no permitida/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("redirección sin Location → rechazada", async () => {
      replies(() => redirect(null));
      await expect(fetchImage(`https://${CDN}/a.jpg`, opts())).rejects.toThrow(/sin destino/);
    });

    it("cada salto se resuelve de nuevo y se conecta a las IP validadas de SU host (no a las del anterior)", async () => {
      const ips: Record<string, { address: string; family: number }[]> = {
        [API]: [{ address: "104.18.20.1", family: 4 }],
        [CDN]: [{ address: "23.55.1.9", family: 4 }, { address: "2600:1406::5", family: 6 }],
      };
      dns.lookup.mockImplementation(async (h: string) => ips[h]);
      replies(() => redirect(`https://${CDN}/demo/p1.jpg`), () => ok());
      await fetchImage(`https://${API}/download`, opts());
      expect(dns.lookup).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls.map((c) => [String(c[0]), c[1]])).toEqual([
        [`https://${API}/download`, ips[API]],
        [`https://${CDN}/demo/p1.jpg`, ips[CDN]], // todas las del host, todas públicas
      ]);
    });
  });

  describe("respuesta y contenido", () => {
    it.each([400, 403, 404, 500, 503, 300, 304])("HTTP %i → rechazada y cuerpo cancelado", async (status) => {
      const { body, onCancel } = streamBody([PNG]);
      replies(() => new Response(status === 304 ? null : body, { status }));
      await expect(fetchImage(`https://${CDN}/a.jpg`, opts())).rejects.toThrow(/No se pudo descargar/);
      if (status !== 304) expect(onCancel).toHaveBeenCalled();
    });

    it("200 OK con imagen válida → aceptada", async () => {
      replies(() => new Response(new Uint8Array(PNG), { status: 200 }));
      await expect(fetchImage(`https://${CDN}/a.jpg`, opts())).resolves.toMatchObject({ mime: "image/png" });
    });

    it.each([201, 202, 203, 206, 226, 299])("HTTP %i con una imagen válida (incluido 206 parcial) → rechazada; solo vale 200; cuerpo cancelado", async (status) => {
      const { body, onCancel } = streamBody([PNG]);
      replies(() => new Response(body, { status, ...(status === 206 && { headers: { "content-range": "bytes 0-15/99999" } }) }));
      await expect(fetchImage(`https://${CDN}/a.jpg`, opts())).rejects.toThrow(`No se pudo descargar la imagen (${status})`);
      expect(onCancel).toHaveBeenCalled();
    });

    it.each([204, 205])("HTTP %i (sin cuerpo) → rechazada", async (status) => {
      replies(() => new Response(null, { status }));
      await expect(fetchImage(`https://${CDN}/a.jpg`, opts())).rejects.toThrow(`No se pudo descargar la imagen (${status})`);
    });

    it("Content-Length mayor que el límite → rechazada sin leer el cuerpo", async () => {
      const { body, onCancel } = streamBody([PNG]);
      replies(() => new Response(body, { status: 200, headers: { "content-length": "999999" } }));
      await expect(fetchImage(`https://${CDN}/a.jpg`, opts({ maxBytes: 1024 }))).rejects.toThrow(/demasiado grande/);
      expect(onCancel).toHaveBeenCalled();
    });

    it("timeout durante la lectura del cuerpo → TimeoutError (no un error genérico del stream)", async () => {
      replies(() => new Response(new ReadableStream({ pull: () => new Promise(() => undefined) }), { status: 200 }));
      await expect(fetchImage(`https://${CDN}/a.jpg`, opts({ timeoutMs: 30 }))).rejects.toMatchObject({ name: "TimeoutError" });
    });

    it("sin Content-Length, el límite se aplica durante la lectura y se corta el stream", async () => {
      const chunk = new Uint8Array(600);
      chunk.set(PNG);
      const { body, onCancel } = streamBody([chunk, new Uint8Array(600), new Uint8Array(600)]);
      replies(() => new Response(body, { status: 200 }));
      await expect(fetchImage(`https://${CDN}/a.jpg`, opts({ maxBytes: 1000 }))).rejects.toThrow(/demasiado grande/);
      expect(onCancel).toHaveBeenCalled();
    });

    it("Content-Length falso (más pequeño que el cuerpo real) → el límite en streaming lo detiene igual", async () => {
      const { body } = streamBody([new Uint8Array(800), new Uint8Array(800)]);
      replies(() => new Response(body, { status: 200, headers: { "content-length": "10" } }));
      await expect(fetchImage(`https://${CDN}/a.jpg`, opts({ maxBytes: 1000 }))).rejects.toThrow(/demasiado grande/);
    });

    it.each([
      ["HTML", Buffer.from("<!doctype html><html></html>")],
      ["GIF", Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00")],
      ["SVG", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
      ["vacío", Buffer.alloc(0)],
    ])("firma incorrecta (%s) → rechazada aunque el Content-Type diga imagen", async (_n, bytes) => {
      replies(() => ok(bytes, { "content-type": "image/png" }));
      await expect(fetchImage(`https://${CDN}/a.jpg`, opts())).rejects.toThrow(/no es una imagen válida/);
    });
  });

  describe("timeout (uno solo para toda la operación)", () => {
    const hangUntilAbort = (_u: unknown, _a: unknown, o: { signal: AbortSignal }) =>
      new Promise<Response>((_r, reject) => o.signal.addEventListener("abort", () => reject(o.signal.reason)));

    it("el servidor no responde → se aborta", async () => {
      fetchMock = transport.request.mockImplementation(hangUntilAbort);
      await expect(fetchImage(`https://${CDN}/a.jpg`, opts({ timeoutMs: 30 }))).rejects.toMatchObject({ name: "TimeoutError" });
    });

    it("el DNS no responde → se aborta sin llegar a pedir la imagen", async () => {
      dns.lookup.mockImplementation(() => new Promise(() => undefined));
      replies(() => ok());
      await expect(fetchImage(`https://${CDN}/a.jpg`, opts({ timeoutMs: 30 }))).rejects.toMatchObject({ name: "TimeoutError" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("el plazo cubre también las redirecciones: no se reinicia en cada salto", async () => {
      let n = 0;
      fetchMock = transport.request.mockImplementation(async (u: unknown, a: unknown, o: { signal: AbortSignal }) => {
        if (n++ === 0) { await new Promise((r) => setTimeout(r, 20)); return redirect(`https://${CDN}/b.jpg`); }
        return hangUntilAbort(u, a, o);
      });
      const started = Date.now();
      await expect(fetchImage(`https://${API}/a`, opts({ timeoutMs: 60 }))).rejects.toMatchObject({ name: "TimeoutError" });
      expect(Date.now() - started).toBeLessThan(1_000);
      const signals = fetchMock.mock.calls.map((c) => (c[2] as { signal: AbortSignal }).signal);
      expect(signals[0]).toBe(signals[1]); // la misma señal en todos los saltos
    });
  });
});

describe("fetchImage: una sola conexión por salto, solo con requestPinned", () => {
  /** Por cada salto: una resolución DNS, una validación y UNA conexión fijada con exactamente esas direcciones. */
  async function expectOnePinnedConnectionPerHop(hops: string[]) {
    expect(fetchGuard).not.toHaveBeenCalled();
    expect(transport.request).toHaveBeenCalledTimes(hops.length);
    expect(dns.lookup).toHaveBeenCalledTimes(hops.length);
    expect(vi.mocked(resolvePublicAddresses)).toHaveBeenCalledTimes(hops.length);
    for (const [i, href] of hops.entries()) {
      const [reqUrl, addresses] = transport.request.mock.calls[i]! as [URL, unknown];
      expect(String(reqUrl)).toBe(href);
      expect(vi.mocked(resolvePublicAddresses).mock.calls[i]![0]).toBe(reqUrl.hostname);
      const resolved = await vi.mocked(resolvePublicAddresses).mock.results[i]!.value;
      expect(addresses).toBe(resolved); // el MISMO array validado, no otra resolución
    }
  }

  it("sin redirecciones → 1 resolución y 1 conexión", async () => {
    replies(() => ok());
    await fetchImage(`https://${CDN}/a.jpg`, opts());
    await expectOnePinnedConnectionPerHop([`https://${CDN}/a.jpg`]);
  });

  it("1 redirección → 2 resoluciones y 2 conexiones (una por salto, cada una con las IP de su host)", async () => {
    dns.lookup.mockImplementation(async (h: string) => [{ address: h === API ? "104.18.20.1" : "23.55.1.9", family: 4 }]);
    replies(() => redirect(`https://${CDN}/p1.jpg`), () => ok());
    await fetchImage(`https://${API}/download`, opts());
    await expectOnePinnedConnectionPerHop([`https://${API}/download`, `https://${CDN}/p1.jpg`]);
    expect(transport.request.mock.calls.map((c) => c[1])).toEqual([[{ address: "104.18.20.1", family: 4 }], [{ address: "23.55.1.9", family: 4 }]]);
  });

  it("3 redirecciones (el máximo) → 4 resoluciones y 4 conexiones", async () => {
    replies(() => redirect(`https://${CDN}/1`), () => redirect(`https://${CDN}/2`), () => redirect(`https://${CDN}/3`), () => ok());
    await fetchImage(`https://${CDN}/0`, opts());
    await expectOnePinnedConnectionPerHop([0, 1, 2, 3].map((n) => `https://${CDN}/${n}`));
  });

  it.each([
    ["error HTTP", () => new Response("x", { status: 404 })],
    ["firma incorrecta", () => ok(Buffer.from("<html></html>"))],
    ["tamaño excedido", () => ok(Buffer.alloc(4096, 1))],
  ])("una descarga que falla (%s) tampoco hace conexiones adicionales ni usa fetch()", async (_n, reply) => {
    replies(reply);
    await expect(fetchImage(`https://${CDN}/a.jpg`, opts())).rejects.toThrow();
    await expectOnePinnedConnectionPerHop([`https://${CDN}/a.jpg`]);
  });

  it("redirección a un destino no permitido → ni resolución ni conexión para ese salto", async () => {
    replies(() => redirect("https://evil.example.com/x.png"));
    await expect(fetchImage(`https://${CDN}/a.jpg`, opts())).rejects.toThrow(/no permitido/);
    await expectOnePinnedConnectionPerHop([`https://${CDN}/a.jpg`]);
  });
});
