import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { startTestDb, type TestDb } from "../helpers/db";
import { prismaProxy, setTestEnv } from "../helpers/mock-prisma";

/**
 * Errores del probador a través de los endpoints HTTP REALES (/api/try-on, /api/try-on/[id], /api/try-on/[id]/retry):
 * route handlers, servicio, cliente de Pollinations y Prisma reales sobre PGlite. Solo se simula lo externo: la sesión,
 * `fetch` (Pollinations y descargas de referencias), Cloudinary y `after()` de Next (se ejecuta a mano).
 * Ninguna respuesta puede revelar el proveedor, variables de entorno, claves, créditos ni el error original.
 */
const holder = vi.hoisted(() => ({ prisma: null as PrismaClient | null }));
const bg = vi.hoisted(() => ({ jobs: [] as (() => Promise<unknown>)[] }));
const session = vi.hoisted(() => ({ userId: "" }));
const cloud = vi.hoisted(() => ({ upload: vi.fn() }));
const PNG = vi.hoisted(() => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6]));

const dns = vi.hoisted(() => ({ addresses: {} as Record<string, string> }));
vi.mock("node:dns/promises", () => {
  // Sin DNS real: IP pública salvo que la prueba fije otra para un host.
  const lookup = async (host: string) => [{ address: dns.addresses[host] ?? "104.18.20.1", family: (dns.addresses[host] ?? "").includes(":") ? 6 : 4 }];
  return { lookup, default: { lookup } };
});
/** Conector fijado simulado: delega en el fetch simulado de cada prueba y registra las IP con las que se conectaría. */
const pinned = vi.hoisted(() => ({ calls: [] as { url: string; addresses: unknown }[] }));
vi.mock("@/lib/uploads/pinned-request", () => ({
  requestPinned: (url: URL, addresses: unknown) => { pinned.calls.push({ url: String(url), addresses }); return fetch(url); },
}));
vi.mock("@/lib/prisma", () => ({ prisma: prismaProxy(holder) }));
vi.mock("@/lib/auth/session", () => ({ requireUserId: async () => session.userId }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => Promise<unknown>) => { bg.jobs.push(fn); } }));
vi.mock("@/lib/cloudinary", () => ({
  signedUrl: (id: string) => `https://api.cloudinary.com/signed/${id}`,
  uploadPrivate: cloud.upload,
  deletePrivateImages: vi.fn(async () => undefined),
}));

const BASE = "http://localhost:3000";
const LEAK = /pollinations|_API_KEY|sk_|clave|créditos|cr[eé]dit|cloudinary|api_key|detalle interno|ENOTFOUND|stack/i;
const SECRET_BODY = "detalle interno: invalid key sk_fake_key (gen.pollinations.ai)";

let t: TestDb;
beforeAll(async () => { setTestEnv(); t = await startTestDb(); holder.prisma = t.prisma; }, 60_000);
afterAll(async () => { await t?.stop(); });
let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  bg.jobs.length = 0;
  dns.addresses = {};
  pinned.calls = [];
  cloud.upload.mockReset();
  cloud.upload.mockImplementation(async (_b: Buffer, folder: string) => ({ publicId: `${folder}/r${Math.random()}`, width: 1, height: 1 }));
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { errSpy.mockRestore(); vi.unstubAllGlobals(); });
const runBackground = async () => { while (bg.jobs.length) await bg.jobs.shift()!(); };
const logged = () => errSpy.mock.calls.flat().join(" ");

/** Pollinations simulado: `reply` decide la respuesta de /v1/images/edits; las descargas de referencias devuelven un PNG. */
function provider(reply: () => Response | Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => (String(url).includes("/v1/images/edits") ? reply() : new Response(new Uint8Array(PNG), { status: 200 }))));
}
const imageOk = () => new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }), { status: 200 });

async function user() {
  const photo = "ai-wardrobe/u/personal/p1";
  const u = await t.prisma.user.create({ data: { email: `e${Math.random().toString(36).slice(2)}@q.com`, profile: { create: { aiPhotoConsent: true, consentAt: new Date(), photoPublicIds: [photo] } } } });
  const a = await t.prisma.wardrobeItem.create({ data: { userId: u.id, name: "Camiseta", category: "TSHIRT", imageUrl: "https://res.cloudinary.com/demo/a.jpg" } });
  const b = await t.prisma.wardrobeItem.create({ data: { userId: u.id, name: "Vaqueros", category: "JEANS", imageUrl: "https://res.cloudinary.com/demo/b.jpg" } });
  const outfitId = (await t.prisma.outfit.create({ data: { userId: u.id, name: "Look", description: "d", items: { create: [{ itemId: a.id }, { itemId: b.id }] } } })).id;
  session.userId = u.id;
  return { id: u.id, body: { outfitId, photoPublicId: photo, scenario: "studio", pose: "standing" } };
}

const routes = async () => ({
  list: await import("@/app/api/try-on/route"),
  item: await import("@/app/api/try-on/[id]/route"),
  retry: await import("@/app/api/try-on/[id]/retry/route"),
});
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
async function create(body: unknown) {
  const res = await (await routes()).list.POST(new Request(`${BASE}/api/try-on`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, text: await res.text() };
}
async function getJob(id: string) {
  const res = await (await routes()).item.GET(new Request(`${BASE}/api/try-on/${id}`), ctx(id));
  const text = await res.text();
  return { status: res.status, text, image: (JSON.parse(text) as { image?: { status: string; errorMessage: string | null } }).image };
}

describe("endpoints del probador: errores sin detalles internos", () => {
  it("configuración: sin clave → 503 TRYON_NOT_CONFIGURED sin nombre de variable; sin reservar cuota", async () => {
    const u = await user();
    const { env } = await import("@/lib/env");
    const e = env();
    const saved = e.POLLINATIONS_API_KEY;
    e.POLLINATIONS_API_KEY = undefined;
    try {
      const res = await create(u.body);
      expect(res.status).toBe(503);
      expect(JSON.parse(res.text)).toMatchObject({ error: { code: "TRYON_NOT_CONFIGURED" } });
      expect(res.text).not.toMatch(LEAK);
      expect(logged()).toContain("POLLINATIONS_API_KEY"); // el detalle sí queda en el log del servidor
      expect(await t.prisma.aiUsageLog.count({ where: { userId: u.id } })).toBe(0);
    } finally {
      e.POLLINATIONS_API_KEY = saved;
    }
  });

  it.each([
    ["autenticación (401)", 401],
    ["créditos agotados (402)", 402],
    ["prohibido (403)", 403],
    ["error interno (500)", 500],
    ["filtro de contenido (400)", 400],
  ])("%s del proveedor → el trabajo queda FAILED con mensaje genérico; la cuota sigue igual (1 unidad)", async (_n, status) => {
    const u = await user();
    provider(() => new Response(SECRET_BODY, { status }));
    const created = await create(u.body);
    expect(created.status).toBe(202);
    const id = (JSON.parse(created.text) as { image: { id: string } }).image.id;
    await runBackground();
    const res = await getJob(id);
    expect(res.status).toBe(200);
    expect(res.image).toMatchObject({ status: "FAILED" });
    expect(res.image!.errorMessage).toBeTruthy();
    expect(res.text).not.toMatch(LEAK);
    expect(logged()).toContain(`Pollinations ${status}`);
    expect(await t.prisma.aiUsageLog.count({ where: { userId: u.id, task: "TRY_ON" } })).toBe(1); // sin cambios en cuotas
  });

  it("errores inesperados (red, almacenamiento) no se filtran; el reintento sigue funcionando", async () => {
    const u = await user();
    provider(() => { throw new TypeError("getaddrinfo ENOTFOUND gen.pollinations.ai"); });
    const id = (JSON.parse((await create(u.body)).text) as { image: { id: string } }).image.id;
    await runBackground();
    let res = await getJob(id);
    expect(res.image).toMatchObject({ status: "FAILED" });
    expect(res.text).not.toMatch(LEAK);

    provider(imageOk);
    cloud.upload.mockRejectedValue(new Error("Cloudinary: Invalid api_key 123456 for cloud demo"));
    const retried = await (await routes()).retry.POST(new Request(`${BASE}/api/try-on/${id}/retry`, { method: "POST" }), ctx(id));
    expect(retried.status).toBe(202);
    await runBackground();
    res = await getJob(id);
    expect(res.image).toMatchObject({ status: "FAILED", errorMessage: "No se pudo generar la imagen. Inténtalo de nuevo." });
    expect(res.text).not.toMatch(LEAK);
    expect(logged()).toContain("Invalid api_key");
  });

  it("el flujo correcto no cambia: 202 → COMPLETED sin errorMessage", async () => {
    const u = await user();
    provider(imageOk);
    const id = (JSON.parse((await create(u.body)).text) as { image: { id: string } }).image.id;
    await runBackground();
    expect((await getJob(id)).image).toMatchObject({ status: "COMPLETED", errorMessage: null });
  });

  it("filas antiguas que guardaron mensajes con detalles internos se devuelven saneadas (sin tocar la base de datos)", async () => {
    const u = await user();
    const old = await t.prisma.generatedImage.create({ data: { userId: u.id, scenario: "studio", pose: "standing", status: "FAILED", errorMessage: "El probador virtual no está configurado (falta POLLINATIONS_API_KEY)" } });
    const old2 = await t.prisma.generatedImage.create({ data: { userId: u.id, scenario: "studio", pose: "standing", status: "FAILED", errorMessage: "La clave de Pollinations no es válida" } });
    const listRes = await (await routes()).list.GET(new Request(`${BASE}/api/try-on`));
    const text = await listRes.text();
    expect(listRes.status).toBe(200);
    expect(text).not.toMatch(LEAK);
    expect((await getJob(old.id)).text).not.toMatch(LEAK);
    expect(await t.prisma.generatedImage.findUniqueOrThrow({ where: { id: old2.id } })).toMatchObject({ errorMessage: "La clave de Pollinations no es válida" });
  });

  it("los errores de negocio útiles se conservan (consentimiento)", async () => {
    const u = await user();
    await t.prisma.userProfile.update({ where: { userId: u.id }, data: { aiPhotoConsent: false } });
    const res = await create(u.body);
    expect(res.status).toBe(403);
    expect(JSON.parse(res.text)).toMatchObject({ error: { code: "CONSENT_REQUIRED" } });
  });
});

/**
 * Descargas del probador contra SSRF, con el flujo real (servicio + cliente de Pollinations): solo hosts permitidos,
 * cada redirección validada y nada descargado de destinos no autorizados. La cuota se resuelve igual que antes:
 * fallo antes de llamar a Pollinations → unidad devuelta; desde la llamada → consumida.
 */
describe("descargas seguras (SSRF)", () => {
  const PNG_RES = () => new Response(new Uint8Array(PNG), { status: 200 });
  let fetched: string[] = [];
  /** `route` decide la respuesta de cada URL descargada; /v1/images/edits responde `edits`. */
  function net(route: (url: string) => Response, edits: () => Response = imageOk) {
    fetched = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      fetched.push(u);
      return u.includes("/v1/images/edits") ? edits() : route(u);
    }));
  }
  const editsCalled = () => fetched.some((u) => u.includes("/v1/images/edits"));
  const tryOnUnits = (userId: string) => t.prisma.aiUsageLog.count({ where: { userId, task: "TRY_ON" } });
  async function run(body: unknown) {
    const created = await create(body);
    expect(created.status).toBe(202);
    const id = (JSON.parse(created.text) as { image: { id: string } }).image.id;
    await runBackground();
    return getJob(id);
  }

  it("foto privada: api.cloudinary.com redirige a res.cloudinary.com → se sigue el salto validado y se completa", async () => {
    const u = await user();
    net((url) => (url.startsWith("https://api.cloudinary.com/") ? new Response(null, { status: 302, headers: { location: "https://res.cloudinary.com/demo/image/authenticated/s--x--/p1.jpg" } }) : PNG_RES()));
    const res = await run(u.body);
    expect(res.image).toMatchObject({ status: "COMPLETED" });
    expect(fetched).toContain("https://res.cloudinary.com/demo/image/authenticated/s--x--/p1.jpg");
    // Cada descarga (y cada salto) se conecta a la IP resuelta y validada para ese host.
    expect(pinned.calls.length).toBeGreaterThanOrEqual(2);
    for (const c of pinned.calls) expect(c.addresses).toEqual([{ address: "104.18.20.1", family: 4 }]);
    // Toda descarga (no la llamada a la API de Pollinations) pasó por requestPinned, una vez cada una.
    expect(fetched.filter((x) => !x.includes("/v1/images/edits"))).toEqual(pinned.calls.map((c) => c.url));
    expect(await tryOnUnits(u.id)).toBe(1);
  });

  it.each([
    ["metadatos de la nube por HTTP", "http://169.254.169.254/latest/meta-data/"],
    ["localhost", "https://localhost/admin"],
    ["IP privada", "https://10.0.0.5/x.png"],
    ["dominio no autorizado", "https://evil.example.com/x.png"],
  ])("la foto privada redirige a %s → FAILED genérico, destino nunca pedido, sin llamar a Pollinations y unidad devuelta", async (_n, location) => {
    const u = await user();
    net((url) => (url.startsWith("https://api.cloudinary.com/") ? new Response(null, { status: 302, headers: { location } }) : PNG_RES()));
    const res = await run(u.body);
    expect(res.image).toMatchObject({ status: "FAILED" });
    expect(res.text).not.toMatch(LEAK);
    expect(res.text).not.toMatch(/169\.254|localhost|10\.0\.0\.5|evil/);
    expect(fetched).not.toContain(location);
    expect(logged()).toMatch(/Destino de imagen no permitido|Host de imagen no permitido|Solo se descargan imágenes por HTTPS/); // motivo concreto, solo en el log
    expect(editsCalled()).toBe(false);
    expect(await tryOnUnits(u.id)).toBe(0);
  });

  it("una prenda cuyo host resuelve a una IP privada (DNS manipulado) → no se descarga; FAILED y unidad devuelta", async () => {
    const u = await user();
    dns.addresses["res.cloudinary.com"] = "10.1.2.3";
    net(() => PNG_RES());
    const res = await run(u.body);
    expect(res.image).toMatchObject({ status: "FAILED" });
    expect(fetched.some((x) => x.startsWith("https://res.cloudinary.com/"))).toBe(false);
    expect(logged()).toContain("resuelve a una dirección no permitida");
    expect(editsCalled()).toBe(false);
    expect(await tryOnUnits(u.id)).toBe(0);
  });

  it("Pollinations responde con URL en el host de su API (sin b64_json) → se descarga y se completa", async () => {
    const u = await user();
    net(() => PNG_RES(), () => new Response(JSON.stringify({ data: [{ url: "https://gen.pollinations.ai/media/r1.png" }] }), { status: 200 }));
    const res = await run(u.body);
    expect(res.image).toMatchObject({ status: "COMPLETED" });
    expect(fetched).toContain("https://gen.pollinations.ai/media/r1.png");
  });

  it.each([
    ["en otro dominio", "https://evil.example.com/r.png", null],
    ["en una IP interna", "https://169.254.169.254/latest/meta-data/", null],
    ["que redirige a localhost", "https://gen.pollinations.ai/media/r1.png", "http://localhost:3000/api/admin"],
  ])("Pollinations responde con URL %s → no se sigue; FAILED genérico y la unidad queda consumida (se llamó al proveedor)", async (_n, url, location) => {
    const u = await user();
    net(
      (x) => (x === url && location ? new Response(null, { status: 302, headers: { location } }) : PNG_RES()),
      () => new Response(JSON.stringify({ data: [{ url }] }), { status: 200 }),
    );
    const res = await run(u.body);
    expect(res.image).toMatchObject({ status: "FAILED" });
    expect(res.text).not.toMatch(LEAK);
    if (location) expect(fetched).not.toContain(location);
    else expect(fetched).not.toContain(url);
    expect(logged()).toContain("pollinations.result_url");
    expect(logged()).toMatch(/Destino de imagen no permitido|Host de imagen no permitido|Solo se descargan imágenes por HTTPS/);
    expect(await tryOnUnits(u.id)).toBe(1);
  });
});
