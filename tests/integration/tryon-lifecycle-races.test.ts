import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { startTestDb, type TestDb } from "../helpers/db";
import { prismaProxy, setTestEnv } from "../helpers/mock-prisma";

/**
 * Ciclo de vida de try-on bajo concurrencia, con el servicio REAL, PostgreSQL (PGlite) y proveedores simulados:
 * - get() solo marca FAILED si la fila sigue igual que cuando la leyó (estado y updatedAt);
 * - cada ejecución de run() escribe solo sobre SU intento (attempts): una ejecución antigua no sobrescribe ni marca
 *   FAILED el intento posterior, y si pierde la carrera borra solo la imagen que ella generó.
 * Las ejecuciones se retienen dentro del proveedor con «gates» para forzar cada intercalación de forma determinista.
 */
const holder = vi.hoisted(() => ({ prisma: null as PrismaClient | null }));
const bg = vi.hoisted(() => ({ jobs: [] as (() => Promise<unknown>)[] }));
const PNG = vi.hoisted(() => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6]));
const cloud = vi.hoisted(() => ({ stored: new Set<string>(), deleted: [] as string[], uploads: 0 }));
const prov = vi.hoisted(() => ({ edit: vi.fn(), inFlight: 0, maxInFlight: 0 }));

vi.mock("node:dns/promises", () => { const lookup = async () => [{ address: "104.18.20.1", family: 4 }]; return { lookup, default: { lookup } }; });
vi.mock("@/lib/uploads/pinned-request", () => ({ requestPinned: async () => new Response(new Uint8Array(PNG), { status: 200 }) }));
vi.mock("@/lib/prisma", () => ({ prisma: prismaProxy(holder) }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => Promise<unknown>) => { bg.jobs.push(fn); } }));
vi.mock("@/lib/pollinations/client", () => ({
  editImage: async (...a: unknown[]) => {
    prov.inFlight++; prov.maxInFlight = Math.max(prov.maxInFlight, prov.inFlight);
    try { return await prov.edit(...a); } finally { prov.inFlight--; }
  },
}));
vi.mock("@/lib/cloudinary", () => ({
  signedUrl: (id: string) => `https://api.cloudinary.com/signed/${id}`,
  uploadPrivate: async (_b: Buffer, folder: string) => { const publicId = `${folder}/result-${++cloud.uploads}`; cloud.stored.add(publicId); return { publicId, width: 1, height: 1 }; },
  deletePrivateImages: async (ids: string[]) => { for (const id of ids) { cloud.deleted.push(id); cloud.stored.delete(id); } },
}));

let t: TestDb;
beforeAll(async () => { setTestEnv(); t = await startTestDb(); holder.prisma = t.prisma; }, 60_000);
afterAll(async () => { await t?.stop(); });
let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  holder.prisma = t.prisma; bg.jobs.length = 0; cloud.stored.clear(); cloud.deleted = [];
  prov.edit.mockReset(); prov.edit.mockResolvedValue(PNG); prov.inFlight = 0; prov.maxInFlight = 0;
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { holder.prisma = t.prisma; errSpy.mockRestore(); });

function gate() { let open!: () => void; const wait = new Promise<void>((r) => { open = r; }); return { wait, open }; }
/** El proveedor retiene la siguiente llamada hasta `release`; `entered` se abre cuando la ejecución está dentro. */
function holdNextProviderCall(outcome: () => Promise<Buffer> = async () => PNG) {
  const entered = gate(); const release = gate();
  prov.edit.mockImplementationOnce(async () => { entered.open(); await release.wait; return outcome(); });
  return { entered, release };
}
const nextJob = () => { const job = bg.jobs.shift(); if (!job) throw new Error("no hay ejecución en cola"); return job; };
const service = async () => (await import("@/services/tryon.service")).tryOnService;
const row = (id: string) => t.prisma.generatedImage.findUniqueOrThrow({ where: { id } });
/** Simula que la fila lleva `minutes` sin cambios (atascada a ojos de get()). */
const age = (id: string, minutes: number) => t.prisma.$executeRawUnsafe(`UPDATE "GeneratedImage" SET "updatedAt" = NOW() - INTERVAL '${minutes} minutes' WHERE id = '${id}'`);
const usage = (userId: string) => t.prisma.aiUsageLog.findMany({ where: { userId, task: "TRY_ON" } });
const results = () => [...cloud.stored].filter((x) => x.includes("/try-on/"));

/** Ejecuta `between` justo después de la primera llamada a prisma.generatedImage.<method> (una sola vez). */
function afterFirst(method: string, between: () => Promise<unknown>) {
  const real = t.prisma; let fired = false;
  holder.prisma = new Proxy(real, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (prop !== "generatedImage") return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      return new Proxy(v as object, {
        get(m, q) {
          const f = Reflect.get(m, q, m) as unknown;
          if (typeof f !== "function") return f;
          if (q !== method) return (f as (...a: unknown[]) => unknown).bind(m);
          return async (...args: unknown[]) => {
            const r = await (f as (...a: unknown[]) => Promise<unknown>).apply(m, args);
            if (!fired) { fired = true; holder.prisma = real; await between(); }
            return r;
          };
        },
      });
    },
  }) as PrismaClient;
}

/** Usuario con consentimiento, foto y conjunto, y un trabajo creado con create() (PENDING; su ejecución queda en cola). */
async function newJob() {
  const photo = "ai-wardrobe/u/personal/p1";
  const u = await t.prisma.user.create({ data: { email: `l${Math.random().toString(36).slice(2)}@q.com`, profile: { create: { aiPhotoConsent: true, consentAt: new Date(), photoPublicIds: [photo] } } } });
  const item = await t.prisma.wardrobeItem.create({ data: { userId: u.id, name: "Camiseta", category: "TSHIRT", imageUrl: "https://res.cloudinary.com/demo/a.jpg" } });
  const outfitId = (await t.prisma.outfit.create({ data: { userId: u.id, name: "Look", description: "d", items: { create: [{ itemId: item.id }] } } })).id;
  const s = await service();
  const job = await s.create(u.id, { outfitId, photoPublicId: photo, scenario: "studio", pose: "standing" });
  return { userId: u.id, id: job.id, s };
}

describe("A — get() no marca FAILED con una lectura obsoleta", () => {
  it("S1: la generación guarda su resultado entre la lectura y el marcado de get() → sigue COMPLETED; no se puede reintentar ni queda huérfano", async () => {
    const { userId, id, s } = await newJob();
    const p = holdNextProviderCall();
    const run1 = nextJob()();
    await p.entered.wait;
    await age(id, 7); // PROCESSING > 6 min
    // get() lee la fila atascada; justo después, la generación termina y guarda su resultado.
    afterFirst("findFirst", async () => { p.release.open(); await run1; });
    const dto = await s.get(userId, id);
    expect(dto.status).toBe("COMPLETED"); // devuelve el estado real, no un FAILED obsoleto
    const r = await row(id);
    expect(r).toMatchObject({ status: "COMPLETED", attempts: 1 });
    expect(r.publicId).toBeTruthy();
    await expect(s.retry(userId, id)).rejects.toMatchObject({ code: "NOT_RETRYABLE" });
    expect(results()).toEqual([r.publicId]); // sin huérfanos
    expect(cloud.deleted).toEqual([]);
    expect(await usage(userId)).toMatchObject([{ success: true }]); // una sola unidad, como éxito
  });

  it("S1b: otra ejecución reclama el trabajo PENDING entre la lectura y el marcado de get() → no pasa a FAILED", async () => {
    const { userId, id, s } = await newJob();
    await age(id, 3); // PENDING > 2 min
    const p = holdNextProviderCall();
    let run1: Promise<unknown> = Promise.resolve();
    afterFirst("findFirst", async () => { run1 = nextJob()(); await p.entered.wait; }); // reclamada y ya en el proveedor
    const dto = await s.get(userId, id);
    expect(dto.status).toBe("PROCESSING");
    expect(await row(id)).toMatchObject({ status: "PROCESSING", attempts: 1 });
    p.release.open(); await run1;
    expect(await row(id)).toMatchObject({ status: "COMPLETED" });
    expect(results()).toHaveLength(1);
    expect(await usage(userId)).toMatchObject([{ success: true }]);
  });

  it("sin cambios concurrentes, un trabajo atascado se sigue marcando FAILED (comportamiento conservado)", async () => {
    const { userId, id, s } = await newJob();
    bg.jobs.length = 0; // su ejecución nunca arranca (p. ej. la función se cortó)
    await age(id, 3);
    expect((await s.get(userId, id)).status).toBe("FAILED");
    expect(await row(id)).toMatchObject({ status: "FAILED", errorMessage: "La generación tardó demasiado. Puedes reintentarlo." });
  });
});

describe("B — cada ejecución escribe solo sobre su intento", () => {
  it("S2: una ejecución antigua no sobrescribe el resultado del reintento; su propia imagen se elimina y no queda huérfana", async () => {
    const { userId, id, s } = await newJob();
    const p = holdNextProviderCall();
    const run1 = nextJob()();
    await p.entered.wait;
    await age(id, 7);
    expect((await s.get(userId, id)).status).toBe("FAILED"); // marcada como atascada (legítimo: la fila no cambió)
    await s.retry(userId, id);
    await nextJob()(); // el reintento (intento 2) termina antes
    const afterRetry = await row(id);
    expect(afterRetry).toMatchObject({ status: "COMPLETED", attempts: 2 });
    const winner = afterRetry.publicId!;
    p.release.open(); await run1; // la ejecución antigua (intento 1) termina después
    const final = await row(id);
    expect(final.publicId).toBe(winner); // NO se sobrescribe
    expect(results()).toEqual([winner]); // sin huérfanos: la imagen del intento 1 se borró
    expect(cloud.deleted).toHaveLength(1);
    expect(cloud.deleted[0]).not.toBe(winner);
    // Cuota: ambas ejecuciones llamaron al proveedor → ambas unidades consumidas (reglas sin cambios, nada liberado).
    expect(await usage(userId)).toMatchObject([{ success: true }, { success: true }]);
    expect(prov.maxInFlight).toBe(2); // (la generación duplicada sigue siendo posible; ya no tiene efectos)
  });

  it("S3: un fallo tardío del intento antiguo no marca FAILED el intento nuevo, que no se puede reintentar y termina bien", async () => {
    const { userId, id, s } = await newJob();
    const p1 = holdNextProviderCall(async () => { throw new Error("proveedor caído"); });
    const run1 = nextJob()();
    await p1.entered.wait;
    await age(id, 7);
    await s.get(userId, id); // atascada → FAILED
    await s.retry(userId, id);
    const p2 = holdNextProviderCall();
    const run2 = nextJob()();
    await p2.entered.wait; // intento 2 en PROCESSING
    p1.release.open(); await run1; // el intento 1 falla ahora
    expect(await row(id)).toMatchObject({ status: "PROCESSING", attempts: 2 }); // su catch no la toca
    await expect(s.retry(userId, id)).rejects.toMatchObject({ code: "NOT_RETRYABLE" }); // ni un tercer intento
    p2.release.open(); await run2;
    const final = await row(id);
    expect(final).toMatchObject({ status: "COMPLETED", attempts: 2 });
    expect(results()).toEqual([final.publicId]);
    // Cuota: el intento 1 llegó al proveedor → consumida como fallo (no se libera); el 2, como éxito.
    const u = await usage(userId);
    expect(u).toHaveLength(2);
    expect(u.map((x) => x.success).sort()).toEqual([false, true]);
  });

  it("un trabajo marcado FAILED por atasco se completa si nadie lo ha reintentado (sin huérfanos)", async () => {
    const { userId, id, s } = await newJob();
    const p = holdNextProviderCall();
    const run1 = nextJob()();
    await p.entered.wait;
    await age(id, 7);
    expect((await s.get(userId, id)).status).toBe("FAILED");
    p.release.open(); await run1;
    const final = await row(id);
    expect(final).toMatchObject({ status: "COMPLETED", attempts: 1 });
    expect(results()).toEqual([final.publicId]);
    expect((await s.get(userId, id)).status).toBe("COMPLETED");
    expect(await usage(userId)).toMatchObject([{ success: true }]);
  });

  it("el trabajo se borra durante la generación → la ejecución borra solo su imagen (comportamiento conservado)", async () => {
    const { userId, id, s } = await newJob();
    const p = holdNextProviderCall();
    const run1 = nextJob()();
    await p.entered.wait;
    await s.remove(userId, id);
    p.release.open(); await run1;
    expect(results()).toEqual([]);
    expect(cloud.deleted).toHaveLength(1);
    expect(await usage(userId)).toMatchObject([{ success: true }]); // llegó al proveedor: consumida, como antes
  });
});

describe("controles: caminos que ya estaban protegidos", () => {
  it("dos retry() simultáneos → un único reintento; la otra reserva se devuelve", async () => {
    const { userId, id, s } = await newJob();
    await nextJob()();
    await t.prisma.generatedImage.updateMany({ where: { id }, data: { status: "FAILED", publicId: null } });
    const before = (await usage(userId)).length;
    const res = await Promise.allSettled([s.retry(userId, id), s.retry(userId, id)]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(res.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "ALREADY_RUNNING" } });
    expect(bg.jobs).toHaveLength(1);
    expect((await usage(userId)).length).toBe(before + 1);
  });

  it("dos ejecuciones del mismo reclamo → una sola llamada al proveedor", async () => {
    const { id } = await newJob();
    const job = nextJob();
    await Promise.all([job(), job()]);
    expect(prov.edit).toHaveBeenCalledTimes(1);
    expect(await row(id)).toMatchObject({ status: "COMPLETED", attempts: 1 });
    expect(results()).toHaveLength(1);
  });
});
