import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { applyValidationMessages, validationMessage } from "@/lib/validations/messages";
import { forgotSchema, loginSchema, passwordSchema, registerSchema, verifySchema } from "@/lib/validations/auth";
import { isoDateSchema } from "@/lib/validations/date";
import { profileSchema } from "@/lib/validations/profile";
import { aiOutfitsSchema, feedbackSchema, stylistRequestSchema } from "@/lib/validations/stylist";
import * as auth from "@/lib/validations/auth";
import * as date from "@/lib/validations/date";
import * as profile from "@/lib/validations/profile";
import * as shopping from "@/lib/validations/shopping";
import * as stylist from "@/lib/validations/stylist";
import * as tryon from "@/lib/validations/tryon";
import * as wardrobe from "@/lib/validations/wardrobe";

/**
 * Fase D — mensajes de validación de Zod en español. Se prueban con los ESQUEMAS REALES del proyecto (los que importan
 * `./messages` por sí mismos: no hay una importación explícita del módulo de configuración que dé por buena la prueba) y con la
 * función `validationMessage` para los casos que ningún esquema actual produce. Cada archivo de pruebas se ejecuta en su propio
 * proceso, así que el orden y las configuraciones de otros archivos no influyen; el caso «sin configurar» está en
 * validation-messages-isolation.test.ts.
 */
const issues = (schema: z.ZodType, input: unknown) => {
  const r = schema.safeParse(input);
  expect(r.success).toBe(false);
  return (r.success ? [] : r.error.issues).map((i) => ({ path: i.path.join("."), message: i.message }));
};
const at = (schema: z.ZodType, input: unknown, p: string) => issues(schema, input).find((i) => i.path === p)?.message;
const okStylist = { location: { name: "Madrid", latitude: 40, longitude: -3 }, date: "2026-01-01" };

describe("campos obligatorios", () => {
  it("falta el campo, es null o llega vacío → «Este campo es obligatorio»", () => {
    expect(at(registerSchema, {}, "email")).toBe("Este campo es obligatorio");
    expect(at(registerSchema, {}, "password")).toBe("Este campo es obligatorio");
    expect(at(registerSchema, { email: "a@b.co", password: null }, "password")).toBe("Este campo es obligatorio");
    expect(at(loginSchema, { email: "a@b.co", password: "" }, "password")).toBe("Este campo es obligatorio"); // min(1) sobre texto vacío
    expect(at(stylistRequestSchema, {}, "location")).toBe("Este campo es obligatorio");
    expect(at(profileSchema, { favoriteColors: [""] }, "favoriteColors.0")).toBe("Este campo es obligatorio");
  });
});

describe("tipos incorrectos", () => {
  it("texto, número, entero, verdadero/falso, lista y objeto", () => {
    expect(at(registerSchema, { email: 5, password: "Abcdefghi1" }, "email")).toBe("Debe ser un texto");
    expect(at(profileSchema, { age: "abc" }, "age")).toBe("Debe ser un número");
    expect(at(profileSchema, { age: 20.5 }, "age")).toBe("Debe ser un número entero");
    expect(at(profileSchema, { onboardingDone: "x" }, "onboardingDone")).toBe("Debe ser verdadero o falso");
    expect(at(profileSchema, { favoriteColors: "rojo" }, "favoriteColors")).toBe("Debe ser una lista");
    expect(at(profileSchema, { sizes: "x" }, "sizes")).toBe("Datos no válidos");
    expect(at(stylistRequestSchema, { location: "x", occasion: "cena" }, "location")).toBe("Datos no válidos");
  });
  it("un número coercionado (z.coerce) que no es numérico → «Debe ser un número»", () => {
    expect(at(z.object({ lat: z.coerce.number() }), { lat: "abc" }, "lat")).toBe("Debe ser un número");
  });
});

describe("longitudes mínimas y máximas", () => {
  it("texto: mínimo y máximo con el valor del límite", () => {
    expect(at(verifySchema, { token: "abc" }, "token")).toBe("Mínimo 20 caracteres");
    expect(at(verifySchema, { token: "x".repeat(70) }, "token")).toBe("Máximo 64 caracteres");
    expect(at(stylistRequestSchema, { ...okStylist, occasion: "a" }, "occasion")).toBe("Mínimo 2 caracteres");
    expect(at(profileSchema, { name: "x".repeat(81) }, "name")).toBe("Máximo 80 caracteres");
  });
  it("lista: mínimo y máximo de elementos", () => {
    expect(at(profileSchema, { favoriteColors: Array.from({ length: 21 }, (_, i) => `c${i}`) }, "favoriteColors")).toBe("Máximo 20 elementos");
    const outfit = { name: "a", description: "b", occasion: "", reasoning: "", colorExplanation: "", weatherFit: "", styleFit: "", itemIds: [], alternatives: [] };
    expect(at(aiOutfitsSchema, { outfits: [outfit] }, "outfits.0.itemIds")).toBe("Debe tener al menos 1 elemento");
  });
  it("singular, exacto y los casos que ningún esquema actual produce (validationMessage con issues en bruto)", () => {
    const m = (i: object) => validationMessage(i as Parameters<typeof validationMessage>[0]);
    expect(m({ code: "too_big", origin: "string", maximum: 1 })).toBe("Máximo 1 carácter");
    expect(m({ code: "too_small", origin: "string", minimum: 2, exact: true })).toBe("Debe tener exactamente 2 caracteres");
    expect(m({ code: "too_small", origin: "array", minimum: 3, exact: true })).toBe("Debe tener exactamente 3 elementos");
    expect(m({ code: "too_big", origin: "array", maximum: 1 })).toBe("Máximo 1 elemento");
    expect(m({ code: "too_small", origin: "set", minimum: 2 })).toBe("Debe tener al menos 2 elementos");
    expect(m({ code: "too_big", origin: "date", maximum: 1 })).toBe("Valor no válido");
  });
});

describe("formato de email y otros formatos", () => {
  it("email inválido", () => { expect(at(forgotSchema, { email: "no-es-un-email" }, "email")).toBe("Introduce un email válido"); });
  it("URL, identificadores, fechas y horas (formatos sin esquema propio actual)", () => {
    expect(at(z.object({ u: z.string().url() }), { u: "no" }, "u")).toBe("Introduce una URL válida");
    expect(at(z.object({ id: z.string().uuid() }), { id: "x" }, "id")).toBe("Identificador no válido");
    const m = (format: string) => validationMessage({ code: "invalid_format", format } as unknown as Parameters<typeof validationMessage>[0]);
    expect(m("datetime")).toBe("Fecha y hora no válidas");
    expect(m("date")).toBe("Fecha no válida");
    expect(m("time")).toBe("Hora no válida");
    expect(m("regex")).toBe("Formato no válido");
  });
});

describe("valores fuera de rango", () => {
  it("números con mínimo y máximo, inclusivos y exclusivos", () => {
    expect(at(profileSchema, { age: 5 }, "age")).toBe("Debe ser 13 o más");
    expect(at(profileSchema, { age: 999 }, "age")).toBe("Debe ser 120 o menos");
    expect(at(profileSchema, { homeLat: -91 }, "homeLat")).toBe("Debe ser -90 o más");
    expect(at(profileSchema, { homeLon: 181 }, "homeLon")).toBe("Debe ser 180 o menos");
    expect(at(z.object({ n: z.number().gt(0) }), { n: -1 }, "n")).toBe("Debe ser mayor que 0");
    expect(at(z.object({ n: z.number().lt(10) }), { n: 20 }, "n")).toBe("Debe ser menor que 10");
    expect(at(z.object({ n: z.coerce.number().max(90) }), { n: "200" }, "n")).toBe("Debe ser 90 o menos");
  });
});

describe("validaciones personalizadas y otros casos", () => {
  it("refine sin mensaje, regex sin mensaje, enum, claves no reconocidas y uniones", () => {
    expect(issues(z.string().refine(() => false), "x")[0]!.message).toBe("Valor no válido");
    expect(at(stylistRequestSchema, { ...okStylist, occasion: "cena", time: "25:99" }, "time")).toBe("Formato no válido");
    expect(at(feedbackSchema, { type: "NOPE" }, "type")).toBe("Elige una opción válida"); // sin listar los valores internos
    expect(issues(z.strictObject({ a: z.string() }), { a: "x", b: 1 })[0]!.message).toBe("Hay campos que no se reconocen"); // sin nombrar «b»
    expect(issues(z.union([z.string(), z.number()]), true)[0]!.message).toBe("Valor no válido");
    expect(issues(z.number().multipleOf(5), 7)[0]!.message).toBe("Debe ser múltiplo de 5");
  });
  it("un código de issue desconocido nunca cae en inglés", () => {
    expect(validationMessage({ code: "algo_nuevo" } as unknown as Parameters<typeof validationMessage>[0])).toBe("Valor no válido");
  });
});

describe("mensajes explícitos de los esquemas: se conservan", () => {
  it("contraseña: longitud mínima, mayúscula y número explícitos (los tres, no solo el último)", () => {
    expect(issues(passwordSchema, "corta").map((i) => i.message)).toEqual(["Mínimo 10 caracteres", "Incluye una mayúscula", "Incluye un número"]);
  });
  it("contraseña de más de 72 bytes UTF-8, email de más de 254 caracteres y fecha no válida", () => {
    expect(issues(passwordSchema, `Aa1${"ñ".repeat(40)}`).map((i) => i.message).join(" ")).toContain("72 bytes UTF-8");
    expect(issues(forgotSchema, { email: `${"a".repeat(250)}@example.com` }).map((i) => i.message)).toContain("El email no puede superar los 254 caracteres");
    expect(at(z.object({ d: isoDateSchema }), { d: "2026-13-45" }, "d")).toBe("Fecha no válida");
  });
  it("un tipo incorrecto sobre un esquema con mensaje explícito en otra comprobación sí se traduce", () => {
    expect(at(z.object({ d: isoDateSchema }), { d: 5 }, "d")).toBe("Debe ser un texto");
  });
});

describe("ningún esquema del proyecto produce ya el texto por defecto en inglés", () => {
  const modules = { auth, date, profile, shopping, stylist, tryon, wardrobe };
  const bad: unknown[] = [undefined, null, "", " ", "x".repeat(2000), 0, -1, 1.5, 1e9, NaN, true, [], [null], ["x"], {}, { a: 1 }, { items: "x" }, "no-es-un-email", "2026-13-45"];
  const ENGLISH = /\b(Invalid|Too small|Too big|expected|received|Required|must be|must match)\b/;

  it("barrido: todos los esquemas exportados × entradas inválidas heterogéneas", () => {
    let checked = 0;
    for (const [name, mod] of Object.entries(modules)) {
      for (const [key, value] of Object.entries(mod)) {
        if (!(value instanceof z.ZodType)) continue;
        for (const input of bad) {
          const r = value.safeParse(input);
          if (r.success) continue;
          for (const i of r.error.issues) {
            expect(i.message, `${name}.${key} con ${JSON.stringify(input)} en «${i.path.join(".")}»`).not.toMatch(ENGLISH);
            expect(i.message.length).toBeGreaterThan(0);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(200); // el barrido realmente recorre muchos issues
  });
});

describe("configuración", () => {
  it("volver a aplicarla es idempotente", () => {
    applyValidationMessages(); applyValidationMessages();
    expect(at(registerSchema, {}, "email")).toBe("Este campo es obligatorio");
    expect(at(profileSchema, { age: 5 }, "age")).toBe("Debe ser 13 o más");
  });
});

describe("guardas estáticas: cada punto de entrada configura la instancia de Zod que carga", () => {
  const root = process.cwd();
  const read = (p: string) => readFileSync(path.join(root, p), "utf8");
  const walk = (dir: string): string[] => readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(`${dir}/${d.name}`) : [`${dir}/${d.name}`]));

  it("todos los módulos de src/lib/validations (salvo messages.ts) importan ./messages", () => {
    const files = readdirSync(path.join(root, "src/lib/validations")).filter((f) => f.endsWith(".ts") && f !== "messages.ts");
    expect(files.length).toBeGreaterThanOrEqual(7);
    for (const f of files) expect(read(`src/lib/validations/${f}`), f).toMatch(/^import "\.\/messages";/m);
  });
  it("lib/errors (que usan todas las rutas mediante handler) importa los mensajes", () => {
    expect(read("src/lib/errors/index.ts")).toMatch(/^import "@\/lib\/validations\/messages";/m);
  });
  it("toda ruta de la API que usa Zod (también con esquema en línea) importa handler de lib/errors o un módulo de validations", () => {
    const routes = walk("src/app/api").filter((f) => f.endsWith("/route.ts"));
    const withZod = routes.filter((f) => /from "zod"/.test(read(f)));
    expect(withZod.length).toBeGreaterThanOrEqual(6);
    for (const f of withZod) expect(read(f), f).toMatch(/from "@\/lib\/errors"/);
  });
});
