import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * /api/cron/catalog-sync debe autorizar igual que el resto de crons (`isAuthorizedCron`): una cabecera con la misma longitud en CARACTERES
 * pero distinta en BYTES (p. ej. «é») no puede provocar una excepción de timingSafeEqual (500): tiene que ser 401.
 */
const envState = vi.hoisted(() => ({ secret: undefined as string | undefined }));
vi.mock("@/lib/env", () => ({ env: () => ({ CRON_SECRET: envState.secret }) }));
const sync = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/services/catalog-sync.service", () => ({ catalogSyncService: { syncAll: async () => { sync.calls++; return { ok: true }; } } }));

import { GET } from "@/app/api/cron/catalog-sync/route";

const SECRET = ["cron", "prueba", "0123456789abcdef"].join("-"); // ficticio
const call = (auth?: string) => GET(new Request("http://localhost:3000/api/cron/catalog-sync", { headers: auth === undefined ? {} : { authorization: auth } }));
afterEach(() => { envState.secret = undefined; sync.calls = 0; });

describe("catalog-sync: autorización del cron", () => {
  it("secreto correcto → 200 y sincroniza", async () => {
    envState.secret = SECRET;
    expect((await call(`Bearer ${SECRET}`)).status).toBe(200);
    expect(sync.calls).toBe(1);
  });
  it("sin secreto configurado o sin cabecera → 401", async () => {
    expect((await call(`Bearer ${SECRET}`)).status).toBe(401);
    envState.secret = SECRET;
    expect((await call()).status).toBe(401);
    expect(sync.calls).toBe(0);
  });
  it("misma longitud en caracteres pero distinta en bytes (é) → 401, no 500", async () => {
    envState.secret = SECRET;
    const res = await call(`Bearer ${SECRET.slice(0, -1)}é`);
    expect(res.status).toBe(401);
    expect(sync.calls).toBe(0);
  });
});
