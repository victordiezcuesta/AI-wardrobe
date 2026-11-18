import { AppError } from "@/lib/errors";

export interface City { name: string; region: string | null; country: string | null; latitude: number; longitude: number }

export interface HourlyPoint { time: string; temperature: number | null; apparent: number | null; precipProb: number | null; wind: number | null; code: number | null }
export interface WeatherSummary {
  date: string;
  timezone: string;
  daily: { tMin: number | null; tMax: number | null; apparentMin: number | null; apparentMax: number | null; precipProbMax: number | null; windMax: number | null; code: number | null; description: string };
  hourly: HourlyPoint[];
}

const WMO: Record<number, string> = {
  0: "despejado", 1: "mayormente despejado", 2: "parcialmente nublado", 3: "nublado", 45: "niebla", 48: "niebla con escarcha",
  51: "llovizna ligera", 53: "llovizna", 55: "llovizna intensa", 56: "llovizna helada", 57: "llovizna helada intensa",
  61: "lluvia ligera", 63: "lluvia", 65: "lluvia intensa", 66: "lluvia helada", 67: "lluvia helada intensa",
  71: "nevada ligera", 73: "nevada", 75: "nevada intensa", 77: "granizo fino", 80: "chubascos ligeros", 81: "chubascos", 82: "chubascos violentos",
  85: "chubascos de nieve", 86: "chubascos de nieve intensos", 95: "tormenta", 96: "tormenta con granizo", 99: "tormenta fuerte con granizo",
};
export const describeWeatherCode = (code: number | null) => (code == null ? "sin datos" : (WMO[code] ?? "condiciones variables"));

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { Accept: "application/json" } });
  if (!res.ok) throw new AppError("El servicio meteorológico no está disponible", 502, "WEATHER_UNAVAILABLE");
  return (await res.json()) as T;
}

export async function searchCities(query: string): Promise<City[]> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=6&language=es&format=json`;
  const data = await getJson<{ results?: { name: string; admin1?: string; country?: string; latitude: number; longitude: number }[] }>(url);
  return (data.results ?? []).map((r) => ({ name: r.name, region: r.admin1 ?? null, country: r.country ?? null, latitude: r.latitude, longitude: r.longitude }));
}

interface ForecastResponse {
  timezone: string;
  hourly: { time: string[]; temperature_2m: (number | null)[]; apparent_temperature: (number | null)[]; precipitation_probability: (number | null)[]; wind_speed_10m: (number | null)[]; weather_code: (number | null)[] };
  daily: { temperature_2m_max: (number | null)[]; temperature_2m_min: (number | null)[]; apparent_temperature_max: (number | null)[]; apparent_temperature_min: (number | null)[]; precipitation_probability_max: (number | null)[]; wind_speed_10m_max: (number | null)[]; weather_code: (number | null)[] };
}

/** Pronóstico de un día (hoy hasta +15 días, el alcance del endpoint de previsión). */
export async function fetchForecast(latitude: number, longitude: number, date: string): Promise<WeatherSummary> {
  const q = new URLSearchParams({
    latitude: latitude.toFixed(4), longitude: longitude.toFixed(4), timezone: "auto", start_date: date, end_date: date,
    hourly: "temperature_2m,apparent_temperature,precipitation_probability,wind_speed_10m,weather_code",
    daily: "temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_probability_max,wind_speed_10m_max,weather_code",
  });
  const d = await getJson<ForecastResponse>(`https://api.open-meteo.com/v1/forecast?${q}`);
  const code = d.daily.weather_code[0] ?? null;
  return {
    date,
    timezone: d.timezone,
    daily: {
      tMin: d.daily.temperature_2m_min[0] ?? null, tMax: d.daily.temperature_2m_max[0] ?? null,
      apparentMin: d.daily.apparent_temperature_min[0] ?? null, apparentMax: d.daily.apparent_temperature_max[0] ?? null,
      precipProbMax: d.daily.precipitation_probability_max[0] ?? null, windMax: d.daily.wind_speed_10m_max[0] ?? null,
      code, description: describeWeatherCode(code),
    },
    hourly: d.hourly.time.map((time, i) => ({
      time, temperature: d.hourly.temperature_2m[i] ?? null, apparent: d.hourly.apparent_temperature[i] ?? null,
      precipProb: d.hourly.precipitation_probability[i] ?? null, wind: d.hourly.wind_speed_10m[i] ?? null, code: d.hourly.weather_code[i] ?? null,
    })),
  };
}

/** Texto compacto para el prompt: resumen del día y, si hay hora, las condiciones en esa franja. */
export function weatherToText(w: WeatherSummary, time?: string): string {
  const r = (n: number | null, u = "") => (n == null ? "s/d" : `${Math.round(n)}${u}`);
  let text = `${w.date}: ${w.daily.description}, mín ${r(w.daily.tMin, "°C")} / máx ${r(w.daily.tMax, "°C")} (sensación ${r(w.daily.apparentMin, "°C")} a ${r(w.daily.apparentMax, "°C")}), prob. de lluvia máx ${r(w.daily.precipProbMax, "%")}, viento máx ${r(w.daily.windMax, " km/h")}.`;
  if (time) {
    const hour = Number(time.slice(0, 2));
    const slot = w.hourly.filter((h) => Math.abs(Number(h.time.slice(11, 13)) - hour) <= 2);
    if (slot.length) {
      const temps = slot.map((h) => h.apparent ?? h.temperature).filter((n): n is number => n != null);
      const rain = Math.max(...slot.map((h) => h.precipProb ?? 0));
      if (temps.length) text += ` Hacia las ${time}: sensación ${Math.round(Math.min(...temps))}–${Math.round(Math.max(...temps))}°C, lluvia hasta ${rain}%.`;
    }
  }
  return text;
}
