import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Límite de tamaño de las subidas, en tres capas: `assertUploadSize` rechaza por Content-Length ANTES de leer el
 * cuerpo; `readUploadForm` limita el cuerpo recibido al máximo (también sin Content-Length) antes de interpretar el
 * multipart; y `readImageFile` comprueba además el tamaño del archivo ya extraído.
 * Las rutas reales se prueban con sesión y límite de peticiones simulados (sin base de datos ni proveedores).
 */
const svc = vi.hoisted(() => ({ addPhoto: vi.fn(), createFromUpload: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireUserId: async () => "user-1" }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => undefined }));
vi.mock("@/services/photo.service", () => ({ photoService: { add: svc.addPhoto } }));
vi.mock("@/services/wardrobe.service", () => ({ wardrobeService: { createFromUpload: svc.createFromUpload } }));

import { assertUploadSize, MAX_UPLOAD_BYTES, MAX_UPLOAD_REQUEST_BYTES, readImageFile, readUploadForm } from "@/lib/uploads/validate";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const withLength = (value: string | null) =>
  new Request("http://localhost:3000/api/photos", { method: "POST", headers: value === null ? {} : { "content-length": value } });
const failure = (fn: () => unknown) => { try { fn(); return null; } catch (e) { return e as { status: number; code: string; message: string }; } };

beforeEach(() => { svc.addPhoto.mockReset(); svc.createFromUpload.mockReset(); });

describe("assertUploadSize", () => {
  it("el límite incluye el margen multipart sobre los 4 MB de imagen", () => {
    expect(MAX_UPLOAD_BYTES).toBe(4 * 1024 * 1024);
    expect(MAX_UPLOAD_REQUEST_BYTES).toBe(MAX_UPLOAD_BYTES + 64 * 1024);
  });

  it.each([["0", 0], ["1", 1], ["por debajo", MAX_UPLOAD_REQUEST_BYTES - 1], ["igual al límite", MAX_UPLOAD_REQUEST_BYTES]])(
    "tamaño %s → permitido", (_n, n) => expect(failure(() => assertUploadSize(withLength(String(n))))).toBeNull(),
  );

  it("espacios alrededor de un número válido → permitido", () => {
    expect(failure(() => assertUploadSize(withLength(` ${MAX_UPLOAD_REQUEST_BYTES} `)))).toBeNull();
  });

  it.each([["un byte más", MAX_UPLOAD_REQUEST_BYTES + 1], ["muy superior", 50 * 1024 * 1024], ["enorme", 9_999_999_999_999]])(
    "tamaño %s → 413 FILE_TOO_LARGE", (_n, n) => {
      expect(failure(() => assertUploadSize(withLength(String(n))))).toMatchObject({ status: 413, code: "FILE_TOO_LARGE" });
    },
  );

  it("sin Content-Length (chunked) → no se rechaza aquí: el límite del cuerpo lo aplica readUploadForm al leerlo", () => {
    expect(failure(() => assertUploadSize(withLength(null)))).toBeNull();
  });

  it.each([
    ["texto", "abc"], ["vacía", ""], ["solo espacios", "   "], ["negativa", "-1"], ["con signo", "+100"],
    ["decimal", "100.5"], ["exponente pequeño", "1e3"], ["exponente grande", "1e9"], ["hexadecimal", "0x10"],
    ["lista (pequeño primero)", `100, ${MAX_UPLOAD_REQUEST_BYTES * 10}`], ["lista igual", "100, 100"],
    ["infinito", "Infinity"], ["NaN", "NaN"], ["17 dígitos", "99999999999999999"], ["con unidades", "100kb"],
  ])("cabecera inválida o manipulada (%s) → rechazada con 400, nunca deja pasar un cuerpo mayor", (_n, value) => {
    expect(failure(() => assertUploadSize(withLength(value)))).toMatchObject({ status: 400, code: "INVALID_UPLOAD" });
  });
});

describe("readImageFile (comprobación final sobre el archivo ya extraído)", () => {
  const file = (bytes: Buffer, size = bytes.length) => {
    const body = size === bytes.length ? bytes : Buffer.concat([bytes, Buffer.alloc(size - bytes.length)]);
    return new File([new Uint8Array(body)], "foto.png", { type: "image/png" });
  };
  it("igual al límite y con firma válida → permitido", async () => {
    await expect(readImageFile(file(PNG, MAX_UPLOAD_BYTES))).resolves.toHaveLength(MAX_UPLOAD_BYTES);
  });
  it("un byte más → 413", async () => {
    await expect(readImageFile(file(PNG, MAX_UPLOAD_BYTES + 1))).rejects.toMatchObject({ status: 413, code: "FILE_TOO_LARGE" });
  });
  it("vacío → 422", async () => {
    await expect(readImageFile(new File([], "x.png"))).rejects.toMatchObject({ status: 422 });
  });
});

describe("rutas de subida: el tamaño se comprueba ANTES de leer el cuerpo", () => {
  /** Cuerpo que registra si alguien empezó a leerlo (highWaterMark 0: sin lectura anticipada propia del stream). */
  function trackedBody() {
    const state = { read: false };
    const body = new ReadableStream<Uint8Array>({ pull(c) { state.read = true; c.enqueue(new Uint8Array(1024)); c.close(); } }, { highWaterMark: 0 });
    return { state, body };
  }

  const routes = async () => ({
    photos: (await import("@/app/api/photos/route")).POST,
    analyze: (await import("@/app/api/wardrobe/analyze/route")).POST,
  });
  const post = (path: string, contentLength: string, body: ReadableStream<Uint8Array>) =>
    new Request(`http://localhost:3000${path}`, { method: "POST", headers: { "content-length": contentLength, "content-type": "multipart/form-data; boundary=x" }, body, duplex: "half" } as RequestInit);

  it("control: el detector sí registra la lectura cuando la ruta consume el cuerpo (Content-Length válido)", async () => {
    const route = (await routes()).photos;
    const { state, body } = trackedBody();
    const res = await route(post("/api/photos", "1024", body));
    expect(state.read).toBe(true); // readUploadForm leyó el cuerpo (y responde 400 por multipart inválido: no importa aquí)
    expect(res.status).not.toBe(413);
  });

  it.each([
    ["/api/photos", "photos"],
    ["/api/wardrobe/analyze", "analyze"],
  ] as const)("%s: Content-Length superior → 413 sin leer el cuerpo ni llamar al servicio", async (path, key) => {
    const route = (await routes())[key];
    const { state, body } = trackedBody();
    const res = await route(post(path, String(MAX_UPLOAD_REQUEST_BYTES + 1), body));
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("FILE_TOO_LARGE");
    expect(state.read).toBe(false);
    expect(svc.addPhoto).not.toHaveBeenCalled();
    expect(svc.createFromUpload).not.toHaveBeenCalled();
  });

  it.each([
    ["/api/photos", "photos"],
    ["/api/wardrobe/analyze", "analyze"],
  ] as const)("%s: Content-Length manipulado → 400 sin leer el cuerpo", async (path, key) => {
    const route = (await routes())[key];
    const { state, body } = trackedBody();
    const res = await route(post(path, `100, ${MAX_UPLOAD_REQUEST_BYTES * 10}`, body));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_UPLOAD");
    expect(state.read).toBe(false);
  });
});

/**
 * Sin Content-Length (chunked, HTTP/2…): el cuerpo se lee con límite estricto ANTES de interpretar el multipart.
 * Un cuerpo excesivo se corta en cuanto pasa del límite (no se consume entero) y nunca llega al servicio.
 */
describe("cuerpo sin Content-Length: lectura acotada antes de interpretar el multipart", () => {
  const CHUNK = 64 * 1024;
  /** Stream de `total` bytes en trozos de 64 KB que cuenta lo que se ha leído y si se canceló (sin lectura anticipada). */
  function endlessBody(total: number) {
    const state = { pulled: 0, cancelled: false };
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (state.pulled >= total) { c.close(); return; }
        const n = Math.min(CHUNK, total - state.pulled);
        state.pulled += n;
        c.enqueue(new Uint8Array(n));
      },
      cancel() { state.cancelled = true; },
    }, { highWaterMark: 0 });
    return { state, body };
  }
  /** Multipart válido (como el que genera el navegador) servido por trozos, sin Content-Length. */
  async function chunkedMultipart(fields: Record<string, string | Blob>) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      if (v instanceof Blob) fd.append(k, v, "foto.png");
      else fd.append(k, v);
    }
    const encoded = new Response(fd);
    const bytes = new Uint8Array(await encoded.arrayBuffer());
    let i = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { if (i >= bytes.length) { c.close(); return; } c.enqueue(bytes.slice(i, i + 1000)); i += 1000; } });
    return { body, contentType: encoded.headers.get("content-type")! };
  }
  const request = (path: string, body: ReadableStream<Uint8Array> | FormData, contentType?: string) =>
    new Request(`http://localhost:3000${path}`, { method: "POST", body, ...(contentType && { headers: { "content-type": contentType } }), duplex: "half" } as RequestInit);
  const routes = async () => ({
    photos: (await import("@/app/api/photos/route")).POST,
    analyze: (await import("@/app/api/wardrobe/analyze/route")).POST,
  });

  it.each([["/api/photos", "photos"], ["/api/wardrobe/analyze", "analyze"]] as const)(
    "%s: 50 MB sin Content-Length → 413 tras leer como mucho el límite; el resto no se consume y no llega al servicio",
    async (path, key) => {
      const route = (await routes())[key];
      const { state, body } = endlessBody(50 * 1024 * 1024);
      const req = request(path, body, "multipart/form-data; boundary=x");
      expect(req.headers.get("content-length")).toBeNull();
      const res = await route(req);
      expect(res.status).toBe(413);
      expect((await res.json()).error.code).toBe("FILE_TOO_LARGE");
      expect(state.pulled).toBeLessThanOrEqual(MAX_UPLOAD_REQUEST_BYTES + CHUNK); // nunca más que el límite + un trozo
      expect(state.pulled).toBeLessThan(50 * 1024 * 1024);
      expect(state.cancelled).toBe(true); // se canceló la lectura
      expect(svc.addPhoto).not.toHaveBeenCalled();
      expect(svc.createFromUpload).not.toHaveBeenCalled();
    },
  );

  it("límite exacto sin Content-Length: justo el límite se lee entero (luego 400 por multipart inválido); un byte más → 413", async () => {
    const atLimit = endlessBody(MAX_UPLOAD_REQUEST_BYTES);
    await expect(readUploadForm(request("/x", atLimit.body, "multipart/form-data; boundary=x"))).rejects.toMatchObject({ status: 400, code: "INVALID_UPLOAD" });
    expect(atLimit.state.pulled).toBe(MAX_UPLOAD_REQUEST_BYTES);
    const over = endlessBody(MAX_UPLOAD_REQUEST_BYTES + 1);
    await expect(readUploadForm(request("/x", over.body, "multipart/form-data; boundary=x"))).rejects.toMatchObject({ status: 413, code: "FILE_TOO_LARGE" });
  });

  it("multipart mal formado → 400 INVALID_UPLOAD (no un 500)", async () => {
    const { body } = endlessBody(1024);
    const res = await (await routes()).photos(request("/api/photos", body, "multipart/form-data; boundary=x"));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_UPLOAD");
  });

  it("subida normal del navegador (fetch con FormData) → se acepta y el servicio recibe la imagen exacta", async () => {
    svc.addPhoto.mockResolvedValue({ publicId: "p1", url: "https://api.cloudinary.com/signed/p1" });
    svc.createFromUpload.mockResolvedValue({ status: "ok", items: [] });
    const { photos, analyze } = await routes();
    const fdPhoto = new FormData();
    fdPhoto.append("file", new Blob([new Uint8Array(PNG)], { type: "image/png" }), "foto.png");
    const r1 = await photos(request("/api/photos", fdPhoto));
    expect(r1.status).toBe(201);
    expect(Buffer.from(svc.addPhoto.mock.calls[0]![1] as Buffer)).toEqual(PNG);
    const fdItem = new FormData();
    fdItem.append("file", new Blob([new Uint8Array(PNG)], { type: "image/png" }), "prenda.png");
    fdItem.append("mode", "multi");
    const r2 = await analyze(request("/api/wardrobe/analyze", fdItem));
    expect(r2.status).toBe(200);
    expect(svc.createFromUpload).toHaveBeenCalledWith("user-1", expect.any(Buffer), "multi");
  });

  it("subida pequeña por trozos SIN Content-Length (chunked) → se acepta igual", async () => {
    svc.addPhoto.mockResolvedValue({ publicId: "p1", url: "u" });
    const { body, contentType } = await chunkedMultipart({ file: new Blob([new Uint8Array(PNG)], { type: "image/png" }) });
    const req = request("/api/photos", body, contentType);
    expect(req.headers.get("content-length")).toBeNull();
    const res = await (await routes()).photos(req);
    expect(res.status).toBe(201);
    expect(Buffer.from(svc.addPhoto.mock.calls[0]![1] as Buffer)).toEqual(PNG);
  });

  it("formulario sin el campo de imagen → 422 como antes", async () => {
    const { body, contentType } = await chunkedMultipart({ otra: "cosa" });
    const res = await (await routes()).photos(request("/api/photos", body, contentType));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("INVALID_FILE");
  });
});
