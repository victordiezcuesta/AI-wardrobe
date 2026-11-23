import type { Prisma } from "@/generated/prisma/client";
import { AppError } from "@/lib/errors";
import { isValidIsoDate } from "@/lib/validations/date";
import { fetchForecast, type WeatherSummary } from "@/lib/weather/open-meteo";
import { weatherCacheRepository } from "@/repositories/weather-cache.repository";

const TTL_MS = 60 * 60 * 1000;
const MAX_DAYS_AHEAD = 15;

/** Fecha de hoy "YYYY-MM-DD" en UTC; la validación de rango admite ±1 día por las zonas horarias. */
function dayDiff(date: string): number {
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  return Math.round((Date.parse(`${date}T00:00:00Z`) - today.getTime()) / 86_400_000);
}

export const weatherService = {
  async getForecast(latitude: number, longitude: number, date: string): Promise<WeatherSummary> {
    // Defensa en profundidad (los esquemas ya la exigen): una fecha imposible nunca llega al cálculo ni al proveedor.
    if (!isValidIsoDate(date)) throw new AppError("Fecha no válida", 422, "INVALID_DATE");
    const diff = dayDiff(date);
    if (!Number.isFinite(diff) || diff < -1 || diff > MAX_DAYS_AHEAD) throw new AppError(`Solo hay previsión de hoy a ${MAX_DAYS_AHEAD} días vista`, 422, "DATE_OUT_OF_RANGE");
    // Coordenadas redondeadas (~1 km): ciudades vecinas comparten caché y se reducen llamadas.
    const lat = Math.round(latitude * 100) / 100;
    const lon = Math.round(longitude * 100) / 100;
    const key = `${lat}:${lon}:${date}`;
    const cached = await weatherCacheRepository.get(key);
    if (cached) return cached as unknown as WeatherSummary;
    const fresh = await fetchForecast(lat, lon, date);
    await weatherCacheRepository.set(key, lat, lon, date, fresh as unknown as Prisma.InputJsonValue, TTL_MS);
    return fresh;
  },
};
