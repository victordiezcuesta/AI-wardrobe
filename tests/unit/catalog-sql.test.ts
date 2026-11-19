import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildUpsertSql } from "@/repositories/catalog.repository";
import { toCatalogRow } from "@/lib/catalog/record";
import { AWIN_MAPPING } from "@/lib/catalog/providers/awin";
import { Readable } from "node:stream";
import { parseCsvRecords } from "@/lib/catalog/csv";

// Mismo DDL que el esquema Prisma para la tabla y el enum que usa la consulta.
const DDL = `
CREATE TYPE "Category" AS ENUM ('TSHIRT','SHIRT','HOODIE','SWEATER','JACKET','COAT','TROUSERS','JEANS','SHORTS','DRESS','SKIRT','SHOES','SNEAKERS','BOOTS','ACCESSORY','BAG','OTHER');
CREATE TABLE "CatalogProduct" (
  "id" TEXT PRIMARY KEY, "provider" TEXT NOT NULL, "feedId" TEXT NOT NULL, "externalId" TEXT NOT NULL, "store" TEXT NOT NULL,
  "brand" TEXT, "name" TEXT NOT NULL, "description" TEXT, "category" "Category" NOT NULL, "colorKey" TEXT, "colorText" TEXT,
  "priceCents" INTEGER NOT NULL, "currency" TEXT NOT NULL DEFAULT 'EUR', "imageUrl" TEXT NOT NULL, "url" TEXT NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "CatalogProduct_provider_feedId_externalId_key" ON "CatalogProduct"("provider","feedId","externalId");`;

const FEED = `aw_product_id,product_name,aw_deep_link,merchant_image_url,search_price,brand_name,colour,merchant_category,in_stock,description
1001,"Camisa oxford, azul claro",https://www.awin1.com/cread.php?p=1001,https://img.example.com/1001.jpg,"29,95",Mango,Azul claro,Camisas,1,"Camisa de algodón"
1002,Pantalón chino beige,https://www.awin1.com/cread.php?p=1002,https://img.example.com/1002.jpg,39.99,Mango,Beige,Pantalones,1,
1003,Vela aromática,https://www.awin1.com/cread.php?p=1003,https://img.example.com/1003.jpg,9.99,Mango,Blanco,Hogar,1,
1004,Abrigo agotado,https://www.awin1.com/cread.php?p=1004,https://img.example.com/1004.jpg,99.00,Mango,Camel,Abrigos,0,
1005,Zapatillas sin imagen,https://www.awin1.com/cread.php?p=1005,,59.00,Mango,Blanco,Calzado,1,
1006,Jersey punto,http://insecure.example.com/x,https://img.example.com/1006.jpg,25.00,Mango,Gris,Jerseys,1,
`;

describe("importación de catálogo contra PostgreSQL real (PGlite)", () => {
  // PGlite compila PostgreSQL en WASM al arrancar (~4 s en frío). Con la suite en paralelo varios archivos lo
  // arrancan a la vez y compiten por CPU, así que el arranque va dentro del hook con el mismo margen que
  // usan los demás tests sobre PGlite (helpers/db.ts), en vez de en la recogida del describe con el límite de 10 s.
  let db: PGlite;
  beforeAll(async () => { db = new PGlite(); await db.exec(DDL); }, 60_000);
  afterAll(async () => { await db?.close(); });

  async function rows() {
    const out = [];
    for await (const rec of parseCsvRecords(Readable.from([Buffer.from(FEED)]))) { const r = toCatalogRow(rec, AWIN_MAPPING); if (r) out.push(r); }
    return out;
  }

  it("filtra filas inválidas: no ropa, agotadas, sin imagen o con enlace no https", async () => {
    const r = await rows();
    expect(r.map((x) => x.externalId)).toEqual(["1001", "1002"]);
    expect(r[0]).toMatchObject({ category: "SHIRT", colorKey: "celeste", priceCents: 2995, brand: "Mango", name: "Camisa oxford, azul claro" });
  });

  it("ejecuta el upsert masivo y es idempotente (actualiza en vez de duplicar)", async () => {
    const meta = { provider: "awin", feedId: "42", store: "Mango" };
    const batch = await rows();
    const first = buildUpsertSql(meta, batch);
    await db.query(first.sql, first.params);
    expect((await db.query<{ n: number }>(`SELECT count(*)::int n FROM "CatalogProduct"`)).rows[0]!.n).toBe(2);

    const changed = batch.map((r) => (r.externalId === "1001" ? { ...r, priceCents: 1995 } : r));
    const second = buildUpsertSql(meta, [...changed, changed[0]!]); // duplicado dentro de la tanda
    await db.query(second.sql, second.params);
    const res = await db.query<{ n: number; p: number }>(`SELECT count(*)::int n, max("priceCents") FILTER (WHERE "externalId"='1001')::int p FROM "CatalogProduct"`);
    expect(res.rows[0]).toEqual({ n: 2, p: 1995 });
  });

  it("guarda NULL (no cadena vacía) en campos opcionales ausentes", async () => {
    const r = await db.query<{ description: string | null; colorKey: string | null }>(`SELECT "description","colorKey" FROM "CatalogProduct" WHERE "externalId"='1002'`);
    expect(r.rows[0]).toEqual({ description: null, colorKey: "beige" });
  });
});
