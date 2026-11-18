import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// openFeed no usa la base de datos, pero el módulo importa Prisma y las variables de entorno al cargarse.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/repositories/catalog.repository", () => ({ catalogRepository: {} }));

import { openFeed } from "@/services/catalog-sync.service";
import { parseCsvRecords } from "@/lib/catalog/csv";

const rows = Array.from({ length: 3000 }, (_, i) => `${i},"Producto ${i}, con coma",${(i % 90) + 10}.50`).join("\n");
const CSV = `aw_product_id,product_name,search_price\n${rows}\n`;

let server: Server; let base: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/gz") { res.setHeader("content-type", "application/octet-stream"); res.end(gzipSync(CSV)); }
    else if (req.url === "/plain") res.end(CSV);
    else { res.statusCode = 403; res.end("no"); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function count(url: string) {
  let n = 0, last: Record<string, string> = {};
  for await (const rec of parseCsvRecords(await openFeed(url))) { n++; last = rec; }
  return { n, last };
}

describe("openFeed", () => {
  it("lee un feed gzip completo en streaming", async () => {
    const { n, last } = await count(`${base}/gz`);
    expect(n).toBe(3000);
    expect(last.product_name).toBe("Producto 2999, con coma");
  });
  it("lee un feed sin comprimir con el mismo resultado", async () => {
    expect((await count(`${base}/plain`)).n).toBe(3000);
  });
  it("falla con claridad ante un error HTTP", async () => {
    await expect(openFeed(`${base}/denied`)).rejects.toThrow("403");
  });
});
