import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setTestEnv } from "../helpers/mock-prisma";

/**
 * Fase 19.11 — fechas de calendario reales en estilista y meteorología. Sin proveedores ni base de datos: Open-Meteo y la
 * caché están simuladas; solo se comprueba qué llega (o no) a ellos.
 */
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
const fetchForecast = vi.hoisted(() => vi.fn(async () => ({ date: "x", timezone: "UTC", daily: {}, hourly: [] })));
vi.mock("@/lib/weather/open-meteo", async (orig) => ({ ...(await orig<object>()), fetchForecast }));
const cache = vi.hoisted(() => ({ get: vi.fn(async () => null), set: vi.fn(async () => undefined) }));
vi.mock("@/repositories/weather-cache.repository", () => ({ weatherCacheRepository: cache }));
const rl = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: rl }));
vi.mock("@/lib/auth/session", () => ({ requireUserId: async () => "user-1" }));

let d: typeof import("@/lib/validations/date");
let stylist: typeof import("@/lib/validations/stylist");
let weather: typeof import("@/services/weather.service");
let styl: typeof import("@/services/stylist.service");
let route: typeof import("@/app/api/weather/route");
beforeAll(async () => {
  setTestEnv();
  d = await import("@/lib/validations/date");
  stylist = await import("@/lib/validations/stylist");
  weather = await import("@/services/weather.service");
  styl = await import("@/services/stylist.service");
  route = await import("@/app/api/weather/route");
});
beforeEach(() => { fetchForecast.mockClear(); cache.get.mockClear(); cache.set.mockClear(); rl.mockClear(); });

const todayPlus = (n: number) => { const t = new Date(); t.setUTCHours(0, 0, 0, 0); return new Date(t.getTime() + n * 86_400_000).toISOString().slice(0, 10); };
const VALID = ["2026-11-18", "2026-01-31", "2026-12-31", "2028-02-29", "2000-02-29", "2026-02-28", "2026-04-30", "0001-01-01", "9999-12-31"];
const INVALID: [string, unknown][] = [
  ["30 de febrero", "2026-02-30"], ["31 de abril", "2026-04-31"], ["29 de febrero en año no bisiesto", "2026-02-29"], ["29 de febrero de 1900 (no bisiesto)", "1900-02-29"],
  ["mes 0", "2026-00-10"], ["mes 13", "2026-13-10"], ["día 0", "2026-11-00"], ["día 32", "2026-11-32"], ["día 31 en mes de 30", "2026-06-31"],
  ["mes y día imposibles", "2026-13-45"], ["año 0000", "0000-01-01"], ["vacío", ""], ["sin ceros", "2026-1-5"], ["con hora", "2026-11-18T10:00:00Z"],
  ["con espacios", " 2026-11-18"], ["salto de línea final", "2026-11-18\n"], ["dígitos de ancho completo", "２０２６-11-18"], ["barras", "2026/11/18"],
  ["texto", "mañana"], ["número", 20261118], ["null", null], ["undefined", undefined], ["objeto", {}], ["array", ["2026-11-18"]], ["booleano", true],
];

describe("isValidIsoDate / isoDateSchema", () => {
  it.each(VALID)("acepta %s", (v) => { expect(d.isValidIsoDate(v)).toBe(true); expect(d.isoDateSchema.safeParse(v).success).toBe(true); });
  it.each(INVALID)("rechaza %s", (_n, v) => { expect(d.isValidIsoDate(v)).toBe(false); expect(d.isoDateSchema.safeParse(v).success).toBe(false); });
  it("años bisiestos: múltiplos de 4, salvo siglos no múltiplos de 400", () => {
    expect([2024, 2028, 2000, 2400].every((y) => d.isValidIsoDate(`${y}-02-29`))).toBe(true);
    expect([2026, 2100, 1900, 2200].some((y) => d.isValidIsoDate(`${y}-02-29`))).toBe(false);
  });
  it("todos los días de todos los meses (año común y bisiesto): exactamente los del calendario", () => {
    for (const [y, expected] of [[2026, [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]], [2028, [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]]] as const) {
      for (let m = 1; m <= 12; m++) for (let day = 1; day <= 32; day++) {
        expect(d.isValidIsoDate(`${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`), `${y}-${m}-${day}`).toBe(day <= expected[m - 1]!);
      }
    }
  });
});

describe("esquema del estilista", () => {
  const base = { location: { name: "Madrid", latitude: 40.4, longitude: -3.7 }, occasion: "Cena informal" };
  it("acepta una fecha real y conserva el contrato", () => {
    expect(stylist.stylistRequestSchema.parse({ ...base, date: "2026-11-18", time: "20:30" })).toMatchObject({ date: "2026-11-18", time: "20:30" });
  });
  it.each(INVALID)("rechaza date: %s", (_n, v) => { expect(stylist.stylistRequestSchema.safeParse({ ...base, date: v }).success).toBe(false); });
});

describe("outfitDate (estilista)", () => {
  it("construye la fecha para entradas válidas", () => {
    expect(styl.outfitDate("2026-11-18").toISOString()).toBe("2026-11-18T12:00:00.000Z");
    expect(styl.outfitDate("2028-02-29", "23:59").toISOString()).toBe("2028-02-29T23:59:00.000Z");
  });
  it.each(INVALID.filter(([, v]) => typeof v === "string" || v === undefined || v === null || typeof v === "number"))("lanza INVALID_DATE (422) con date %s", (_n, v) => {
    expect(() => styl.outfitDate(v as string)).toThrowError(expect.objectContaining({ code: "INVALID_DATE", status: 422 }));
  });
  it.each(["24:00", "9:00", "12:60", "", "ab:cd", "12:00:00"])("lanza INVALID_DATE con hora %j", (t) => {
    expect(() => styl.outfitDate("2026-11-18", t)).toThrowError(expect.objectContaining({ code: "INVALID_DATE" }));
  });
});

describe("weatherService.getForecast", () => {
  it.each(INVALID)("fecha inválida (%s) → 422 INVALID_DATE; ni caché ni proveedor", async (_n, v) => {
    await expect(weather.weatherService.getForecast(40, -3, v as string)).rejects.toMatchObject({ code: "INVALID_DATE", status: 422 });
    expect(fetchForecast).not.toHaveBeenCalled();
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });
  it("NaN no se cuela por las comparaciones de rango (fecha con formato correcto pero imposible)", async () => {
    await expect(weather.weatherService.getForecast(40, -3, "2026-13-45")).rejects.toMatchObject({ code: "INVALID_DATE" });
    expect(fetchForecast).not.toHaveBeenCalled();
  });
  it.each([[-2], [16], [400], [-400]])("fecha real fuera del rango (hoy %i días) → DATE_OUT_OF_RANGE sin proveedor", async (n) => {
    await expect(weather.weatherService.getForecast(40, -3, todayPlus(n))).rejects.toMatchObject({ code: "DATE_OUT_OF_RANGE", status: 422 });
    expect(fetchForecast).not.toHaveBeenCalled();
  });
  it.each([[-1], [0], [1], [15]])("fecha válida dentro del rango (hoy %i días) → llega al proveedor y se cachea", async (n) => {
    await weather.weatherService.getForecast(40.123, -3.456, todayPlus(n));
    expect(fetchForecast).toHaveBeenCalledTimes(1);
    expect(cache.set).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/weather", () => {
  const call = (q: string) => route.GET(new Request(`http://localhost:3000/api/weather?${q}`));
  it("fecha válida → 200 y el servicio recibe la fecha tal cual", async () => {
    const r = await call(`lat=40.4&lon=-3.7&date=${todayPlus(0)}`);
    expect(r.status).toBe(200);
    expect(await r.json()).toHaveProperty("weather");
    expect(fetchForecast).toHaveBeenCalledTimes(1);
  });
  it.each(INVALID.filter(([, v]) => typeof v === "string"))("fecha inválida (%s) → 422 de validación, sin proveedor ni caché", async (_n, v) => {
    const r = await call(`lat=40.4&lon=-3.7&date=${encodeURIComponent(v as string)}`);
    expect(r.status).toBe(422);
    expect((await r.json() as { error: { code: string } }).error.code).toBe("VALIDATION");
    expect(fetchForecast).not.toHaveBeenCalled();
    expect(cache.get).not.toHaveBeenCalled();
  });
  it("sin date → 422", async () => {
    expect((await call("lat=40.4&lon=-3.7")).status).toBe(422);
    expect(fetchForecast).not.toHaveBeenCalled();
  });
});
