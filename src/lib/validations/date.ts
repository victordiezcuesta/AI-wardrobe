import { z } from "zod";
import "./messages"; // mensajes de validación en español (efecto secundario; ver messages.ts)

/**
 * Fecha de calendario `YYYY-MM-DD` REAL (fase 19.11). Una regex de formato no basta («2026-13-45» la pasa) y `Date.parse`
 * normaliza fechas imposibles («2026-02-30» → 2 de marzo) o devuelve NaN, que se salta comparaciones de rango. Aquí se
 * comprueba el formato exacto, el mes (1–12) y el día según el mes y el año (bisiestos incluidos), sin usar `Date`.
 */
const ISO_DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

export const isLeapYear = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysInMonth = (y: number, m: number) => (m === 2 ? (isLeapYear(y) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31);

export function isValidIsoDate(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = ISO_DATE.exec(v);
  if (!m) return false;
  const year = Number(m[1]); const month = Number(m[2]); const day = Number(m[3]);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

/** Esquema Zod de una fecha de calendario real (rechaza no strings, formato inexacto y fechas imposibles). */
export const isoDateSchema = z.string().refine(isValidIsoDate, { message: "Fecha no válida" });
