import { getEventListeners } from "node:events";
import { createServer, type Server, type Socket } from "node:net";
import { Agent } from "node:https";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { v2 as cloudinary } from "cloudinary";
import { setTestEnv } from "../helpers/mock-prisma";

/**
 * listAppResourcesPage con el SDK REAL de Cloudinary, dirigido (upload_prefix) a un servidor TCP LOCAL que acepta la
 * conexión y nunca responde: simula una petición colgada sin tocar Cloudinary. Se comprueba que abortar la cancela de
 * verdad (el servidor ve cerrarse la conexión), no solo que se deja de esperar.
 */
/** Agent REAL (subclase) que solo cuenta cuántos se crean y cuántos se destruyen. */
const agents = vi.hoisted(() => ({ created: 0, destroyed: 0 }));
vi.mock("node:https", async (orig) => {
  const real = await orig<typeof import("node:https")>();
  class CountingAgent extends real.Agent {
    constructor(...a: ConstructorParameters<typeof real.Agent>) { super(...a); agents.created++; }
    override destroy() { agents.destroyed++; super.destroy(); }
  }
  return { ...real, Agent: CountingAgent, default: { ...real, Agent: CountingAgent } };
});

let server: Server;
const sockets: Socket[] = [];
let closed = 0;
beforeAll(async () => {
  setTestEnv();
  server = createServer((s) => { sockets.push(s); s.resume(); s.on("error", () => undefined); s.on("close", () => { closed++; }); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  cloudinary.config({ upload_prefix: `https://127.0.0.1:${port}` }); // se combina con la configuración del cliente: nunca sale de la máquina
});
afterAll(async () => { for (const s of sockets) s.destroy(); await new Promise((r) => server.close(r)); });
afterEach(() => { vi.restoreAllMocks(); agents.created = 0; agents.destroyed = 0; });
const abortListeners = (signal: AbortSignal) => getEventListeners(signal, "abort").length;

const list = async () => (await import("@/lib/cloudinary")).listAppResourcesPage;
const waitFor = async (cond: () => boolean, ms = 2000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10)); return cond(); };

describe("listAppResourcesPage", () => {
  it("petición colgada + abort → se rechaza enseguida y la conexión se CIERRA (cancelación real)", async () => {
    const before = { open: sockets.length, closed };
    const ctrl = new AbortController();
    const p = (await list())("upload", undefined, ctrl.signal);
    const outcome = p.then(() => "resuelta", (e: { code?: string }) => e.code ?? "rechazada");
    expect(await waitFor(() => sockets.length === before.open + 1)).toBe(true); // la petición llegó y está colgada
    const t0 = Date.now();
    ctrl.abort(new Error("TIME_BUDGET"));
    expect(await outcome).toBe("ECONNRESET");
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(await waitFor(() => closed === before.closed + 1)).toBe(true); // el servidor ve el cierre: nada sigue en segundo plano
    expect(agents).toEqual({ created: 1, destroyed: 2 }); // al cancelar y, de nuevo, en el finally (idempotente)
    expect(abortListeners(ctrl.signal)).toBe(0);
  });

  it("señal ya abortada → no crea Agent, no registra listener, no llama al SDK ni conecta", async () => {
    const before = sockets.length;
    const spy = vi.spyOn(cloudinary.api, "resources");
    const ctrl = new AbortController(); ctrl.abort(new Error("TIME_BUDGET"));
    await expect((await list())("authenticated", undefined, ctrl.signal)).rejects.toThrow("TIME_BUDGET");
    expect(agents.created).toBe(0);
    expect(abortListeners(ctrl.signal)).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 100));
    expect(sockets.length).toBe(before);
  });

  it.each([
    ["éxito", () => Promise.resolve({ resources: [] }), "fulfilled"],
    ["error del SDK", () => Promise.reject(Object.assign(new Error("fallo"), { http_code: 500 })), "rejected"],
    ["excepción síncrona del SDK", () => { throw new Error("síncrono"); }, "rejected"],
  ])("%s → el Agent se destruye y no queda ningún listener en la señal", async (_n, impl, status) => {
    vi.spyOn(cloudinary.api, "resources").mockImplementation(impl as never);
    const ctrl = new AbortController();
    const [r] = await Promise.allSettled([(await list())("upload", undefined, ctrl.signal)]);
    expect(r!.status).toBe(status);
    expect(agents).toEqual({ created: 1, destroyed: 1 });
    expect(abortListeners(ctrl.signal)).toBe(0);
    ctrl.abort(); // abortar después de terminar no hace nada (el listener ya no está)
    expect(agents.destroyed).toBe(1);
  });

  it("sin señal → funciona igual y el Agent se destruye al terminar", async () => {
    vi.spyOn(cloudinary.api, "resources").mockResolvedValue({ resources: [] } as never);
    await (await list())("upload");
    expect(agents).toEqual({ created: 1, destroyed: 1 });
  });

  it("argumentos al SDK: solo lectura, prefijo fijo, tipo pedido, cursor y un Agent propio que se destruye al terminar", async () => {
    const spy = vi.spyOn(cloudinary.api, "resources").mockResolvedValue({ resources: [] } as never);
    const destroy = vi.spyOn(Agent.prototype, "destroy");
    await (await list())("authenticated", "cur-1", new AbortController().signal);
    expect(spy).toHaveBeenCalledTimes(1);
    const opts = spy.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts).toMatchObject({ resource_type: "image", type: "authenticated", prefix: "ai-wardrobe/", max_results: 500, next_cursor: "cur-1" });
    expect(opts.agent).toBeInstanceOf(Agent);
    expect(Object.keys(opts).sort()).toEqual(["agent", "max_results", "next_cursor", "prefix", "resource_type", "type"]);
    expect(destroy.mock.contexts).toContain(opts.agent);
    await (await list())("upload", undefined);
    expect(spy.mock.calls[1]![0]).not.toHaveProperty("next_cursor");
  });
});
