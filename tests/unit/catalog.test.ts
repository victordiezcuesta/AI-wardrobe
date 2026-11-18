import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { detectDelimiter, parseCsv, parseCsvRecords } from "@/lib/catalog/csv";
import { inferCategory, inferColor, parsePriceCents, isHttpsUrl } from "@/lib/catalog/normalize";

const chunks = (text: string, size: number) => Readable.from(Array.from({ length: Math.ceil(text.length / size) }, (_, i) => Buffer.from(text.slice(i * size, (i + 1) * size))));
async function all<T>(g: AsyncGenerator<T>) { const out: T[] = []; for await (const x of g) out.push(x); return out; }

describe("parseCsv", () => {
  it("lee filas simples con coma", async () => {
    expect(await all(parseCsv(chunks("a,b,c\n1,2,3\n", 5)))).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
  });
  it("respeta comillas, comillas escapadas y saltos de línea dentro de un campo", async () => {
    const text = 'name,desc\n"Camisa, azul","Dice ""hola""\nsegunda línea"\nsimple,x\n';
    expect(await all(parseCsv(chunks(text, 3)))).toEqual([["name", "desc"], ["Camisa, azul", 'Dice "hola"\nsegunda línea'], ["simple", "x"]]);
  });
  it("da el mismo resultado sea cual sea el tamaño de trozo", async () => {
    const text = 'a,b\n"x,""y""",2\n3,"4\n5"\n';
    const ref = await all(parseCsv(chunks(text, 1000)));
    for (const size of [1, 2, 3, 7]) expect(await all(parseCsv(chunks(text, size)))).toEqual(ref);
  });
  it("gestiona CRLF, BOM y falta de salto de línea final", async () => {
    expect(await all(parseCsv(chunks("\uFEFFa,b\r\n1,2\r\n3,4", 4)))).toEqual([["a", "b"], ["1", "2"], ["3", "4"]]);
  });
  it("detecta tabulador y barra vertical", async () => {
    expect(detectDelimiter("a\tb\tc")).toBe("\t");
    expect(await all(parseCsv(chunks("a|b\n1|2\n", 3)))).toEqual([["a", "b"], ["1", "2"]]);
    expect(await all(parseCsv(chunks("a\tb\n1\t2\n", 3)))).toEqual([["a", "b"], ["1", "2"]]);
  });
  it("conserva campos vacíos", async () => {
    expect(await all(parseCsv(chunks("a,b,c\n1,,3\n,,\n", 4)))).toEqual([["a", "b", "c"], ["1", "", "3"], ["", "", ""]]);
  });
});

describe("parseCsvRecords", () => {
  it("usa la cabecera en minúsculas como claves", async () => {
    const recs = await all(parseCsvRecords(chunks("Product_Name,Search_Price\nCamisa,29.95\n", 6)));
    expect(recs).toEqual([{ product_name: "Camisa", search_price: "29.95" }]);
  });
});

describe("inferCategory", () => {
  it("distingue camiseta de camisa y vaqueros de pantalón", () => {
    expect(inferCategory("Camiseta básica algodón")).toBe("TSHIRT");
    expect(inferCategory("Camisa oxford")).toBe("SHIRT");
    expect(inferCategory("Pantalón vaquero recto")).toBe("JEANS");
    expect(inferCategory("Pantalón chino")).toBe("TROUSERS");
    expect(inferCategory("Abrigo de lana")).toBe("COAT");
    expect(inferCategory("Botines de piel")).toBe("BOOTS");
    expect(inferCategory("Zapatillas deportivas")).toBe("SNEAKERS");
  });
  it("ignora acentos y devuelve null si no es moda", () => {
    expect(inferCategory("Pantalón de pinzas")).toBe("TROUSERS");
    expect(inferCategory("Vela aromática hogar")).toBeNull();
  });
});

describe("inferColor", () => {
  it("mapea a la paleta cerrada", () => {
    expect(inferColor("Azul marino")).toBe("azul marino");
    expect(inferColor("Light Blue")).toBe("celeste");
    expect(inferColor("NEGRO")).toBe("negro");
    expect(inferColor("Crudo")).toBe("crema");
    expect(inferColor("Fucsia")).toBe("rosa");
    expect(inferColor("???")).toBeNull();
  });
});

describe("parsePriceCents", () => {
  it.each([["29,95", 2995], ["29.95", 2995], ["EUR 29.95", 2995], ["1.299,00", 129900], ["€ 1,299.00", 129900], ["120", 12000], ["1.299", 129900]])("%s → %i", (raw, cents) => {
    expect(parsePriceCents(raw)).toBe(cents);
  });
  it("rechaza vacíos, ceros y absurdos", () => {
    expect(parsePriceCents("")).toBeNull();
    expect(parsePriceCents("0")).toBeNull();
    expect(parsePriceCents("gratis")).toBeNull();
    expect(parsePriceCents("9999999")).toBeNull();
  });
});

describe("isHttpsUrl", () => {
  it("solo admite https", () => {
    expect(isHttpsUrl("https://a.com/x")).toBe(true);
    expect(isHttpsUrl("http://a.com/x")).toBe(false);
    expect(isHttpsUrl("javascript:alert(1)")).toBe(false);
  });
});
