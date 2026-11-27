import { z } from "zod";

/**
 * Fase D — mensajes de validación de Zod en español, centralizados.
 *
 * Se registran como `customError` GLOBAL de Zod. Los mensajes EXPLÍCITOS de los esquemas (`.min(10, "Mínimo 10 caracteres")`,
 * `.refine(fn, "…")`…) tienen precedencia y no se tocan: esto solo sustituye a los textos por defecto (en inglés) de Zod.
 * Se usa `customError` (y no traducir después sobre el `ZodError`) porque el issue en bruto trae el valor recibido (`input`), que
 * distingue «falta el campo» de «tipo incorrecto»; el issue final ya no lo conserva.
 *
 * La configuración vive en la instancia de Zod del grafo de módulos que la importa. Por eso este módulo se importa con efecto
 * secundario desde CADA módulo de `validations/` y desde `lib/errors` (que usan todas las rutas mediante `handler()`, también las que
 * definen su esquema en línea): así queda configurada la instancia que cada ruta carga, aunque el empaquetado dé una por entrada.
 * Es idempotente (volver a aplicarla no cambia nada).
 *
 * Los mensajes son cortos y no exponen nombres internos (ni de campos ni de valores permitidos). La estructura de la respuesta de la
 * API (código, estado, `issues[].path` y `issues[].message`) no cambia: solo el texto.
 */
type RawIssue = z.core.$ZodRawIssue;

const REQUIRED = "Este campo es obligatorio";
const INVALID = "Valor no válido";
const plural = (n: number | bigint, one: string, many: string) => `${n} ${n === 1 || n === 1n ? one : many}`;

/** Mensaje en español para un issue en bruto de Zod. Cualquier caso no previsto cae en «Valor no válido» (nunca en inglés). */
export function validationMessage(iss: RawIssue): string {
  switch (iss.code) {
    case "invalid_type": {
      if (iss.input === undefined || iss.input === null || iss.expected === "nonoptional") return REQUIRED;
      switch (iss.expected) {
        case "string": return "Debe ser un texto";
        case "number": case "bigint": case "nan": return "Debe ser un número";
        case "int": return "Debe ser un número entero"; // el valor es un número, pero con decimales
        case "boolean": return "Debe ser verdadero o falso";
        case "array": case "set": return "Debe ser una lista";
        case "object": case "record": case "map": return "Datos no válidos";
        default: return INVALID;
      }
    }
    case "too_small": {
      const n = iss.minimum;
      switch (iss.origin) {
        case "string":
          if (iss.exact) return `Debe tener exactamente ${plural(n, "carácter", "caracteres")}`;
          return n === 1 ? REQUIRED : `Mínimo ${plural(n, "carácter", "caracteres")}`;
        case "array": case "set":
          return iss.exact ? `Debe tener exactamente ${plural(n, "elemento", "elementos")}` : `Debe tener al menos ${plural(n, "elemento", "elementos")}`;
        case "number": case "int": case "bigint":
          return iss.inclusive === false ? `Debe ser mayor que ${n}` : `Debe ser ${n} o más`;
        default: return INVALID;
      }
    }
    case "too_big": {
      const n = iss.maximum;
      switch (iss.origin) {
        case "string":
          return iss.exact ? `Debe tener exactamente ${plural(n, "carácter", "caracteres")}` : `Máximo ${plural(n, "carácter", "caracteres")}`;
        case "array": case "set":
          return iss.exact ? `Debe tener exactamente ${plural(n, "elemento", "elementos")}` : `Máximo ${plural(n, "elemento", "elementos")}`;
        case "number": case "int": case "bigint":
          return iss.inclusive === false ? `Debe ser menor que ${n}` : `Debe ser ${n} o menos`;
        default: return INVALID;
      }
    }
    case "invalid_format":
      switch (iss.format) {
        case "email": return "Introduce un email válido";
        case "url": return "Introduce una URL válida";
        case "uuid": case "guid": case "cuid": case "cuid2": case "ulid": case "nanoid": case "xid": case "ksuid": return "Identificador no válido";
        case "datetime": return "Fecha y hora no válidas";
        case "date": return "Fecha no válida";
        case "time": return "Hora no válida";
        default: return "Formato no válido"; // regex, starts_with, includes…
      }
    case "invalid_value": return "Elige una opción válida"; // enum y literales: sin enumerar los valores internos
    case "not_multiple_of": return `Debe ser múltiplo de ${iss.divisor}`;
    case "unrecognized_keys": return "Hay campos que no se reconocen"; // sin listar sus nombres
    default: return INVALID; // invalid_union, invalid_key, invalid_element, custom sin mensaje…
  }
}

/** Registra los mensajes en la instancia de Zod de este grafo de módulos (idempotente). */
export function applyValidationMessages(): void {
  z.config({ customError: validationMessage });
}

applyValidationMessages();
