import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Fase D — rutas reales (esquema en línea de la ruta + handler()). Sesión, límite de tasa y servicios externos simulados: sin base
 * de datos ni red. Se comprueba que el mensaje sale en español y que código, estado y estructura de la respuesta no cambian.
 */
vi.mock("@/lib/auth/session", () => ({ requireUserId: async () => "u1" }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => undefined }));
vi.mock("@/lib/weather/open-meteo", () => ({ searchCities: async () => [] }));
vi.mock("@/services/weather.service", () => ({ weatherService: { getForecast: async () => ({}) } }));
vi.mock("@/services/consent.service", () => ({ consentService: { set: async () => ({}), status: async () => ({}) } }));

const BASE = "http://localhost:3000";
type Body = { error: { code: string; message: string; issues: { path: string; message: string }[] } };
let geocode: (r: Request) => Promise<Response>, weather: (r: Request) => Promise<Response>, consent: (r: Request) => Promise<Response>;
beforeAll(async () => {
  geocode = (await import("@/app/api/geocode/route")).GET as never;
  weather = (await import("@/app/api/weather/route")).GET as never;
  consent = (await import("@/app/api/consent/route")).POST as never;
});
const json = async (res: Response) => (await res.json()) as Body;

describe("respuestas 422 de rutas reales", () => {
  it("geocode: parámetro q ausente y demasiado corto", async () => {
    let b = await json(await geocode(new Request(`${BASE}/api/geocode`)));
    expect(b.error.issues).toEqual([{ path: "q", message: "Este campo es obligatorio" }]);
    b = await json(await geocode(new Request(`${BASE}/api/geocode?q=a`)));
    expect(b.error.issues).toEqual([{ path: "q", message: "Mínimo 2 caracteres" }]);
  });
  it("weather: número fuera de rango, no numérico y fecha con mensaje explícito conservado", async () => {
    const res = await weather(new Request(`${BASE}/api/weather?lat=200&lon=abc&date=2026-13-45`));
    expect(res.status).toBe(422);
    const b = await json(res);
    expect(b.error.issues).toEqual([
      { path: "lat", message: "Debe ser 90 o menos" },
      { path: "lon", message: "Debe ser un número" },
      { path: "date", message: "Fecha no válida" },
    ]);
  });
  it("consent: tipo incorrecto en el cuerpo", async () => {
    const res = await consent(new Request(`${BASE}/api/consent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ granted: "si" }) }));
    expect((await json(res)).error.issues).toEqual([{ path: "granted", message: "Debe ser verdadero o falso" }]);
  });
  it("código, estado y estructura no cambian: solo cambia el texto de cada issue", async () => {
    const res = await geocode(new Request(`${BASE}/api/geocode?q=a`));
    expect(res.status).toBe(422);
    const b = await json(res);
    expect(Object.keys(b)).toEqual(["error"]);
    expect(Object.keys(b.error).sort()).toEqual(["code", "issues", "message"]);
    expect(b.error.code).toBe("VALIDATION");
    expect(b.error.message).toBe("Datos no válidos");
    expect(Object.keys(b.error.issues[0]!).sort()).toEqual(["message", "path"]);
  });
});
