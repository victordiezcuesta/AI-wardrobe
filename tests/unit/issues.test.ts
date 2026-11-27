import { describe, expect, it } from "vitest";
import { groupIssues } from "@/utils/issues";

/** Fase E — agrupación de los issues de validación por campo (utilidad pura, sin presentación). */
const issue = (path: string, message: string) => ({ path, message });

describe("groupIssues", () => {
  it("varios errores en un mismo campo: se conservan todos, en orden de llegada", () => {
    const g = groupIssues([issue("password", "Mínimo 10 caracteres"), issue("password", "Incluye una mayúscula"), issue("password", "Incluye un número")]);
    expect(g.fields.password).toEqual(["Mínimo 10 caracteres", "Incluye una mayúscula", "Incluye un número"]);
    expect(g.global).toEqual([]);
    expect(g.unmatched).toEqual([]);
  });

  it("errores en campos distintos: cada uno en el suyo, y las claves siguen el orden de primera aparición", () => {
    const g = groupIssues([issue("email", "Introduce un email válido"), issue("password", "Mínimo 10 caracteres"), issue("email", "Máximo 254 caracteres")]);
    expect(Object.keys(g.fields)).toEqual(["email", "password"]);
    expect(g.fields.email).toEqual(["Introduce un email válido", "Máximo 254 caracteres"]);
    expect(g.fields.password).toEqual(["Mínimo 10 caracteres"]);
  });

  it("path vacío (o solo espacios): error global, nunca de un campo", () => {
    const g = groupIssues([issue("", "Hay campos que no se reconocen"), issue("  ", "Valor no válido"), issue("email", "Introduce un email válido")]);
    expect(g.global).toEqual(["Hay campos que no se reconocen", "Valor no válido"]);
    expect(Object.keys(g.fields)).toEqual(["email"]);
  });

  it("paths anidados: sin lista de campos son un campo más; con lista (o resolve) solo se aceptan los que el formulario conoce", () => {
    const issues = [issue("sizes.top", "Máximo 10 caracteres"), issue("home.lat", "Debe ser 90 o menos")];
    expect(Object.keys(groupIssues(issues).fields)).toEqual(["sizes.top", "home.lat"]);
    const g = groupIssues(issues, { fields: ["sizes.top"] });
    expect(g.fields).toEqual({ "sizes.top": ["Máximo 10 caracteres"] });
    expect(g.unmatched).toEqual([issue("home.lat", "Debe ser 90 o menos")]); // no se atribuye a ningún campo
    expect(g.global).toEqual([]);
  });

  it("resolve atribuye elementos de lista a su campo; undefined = no representable", () => {
    const resolve = (p: string) => (/^colors\.\d+$/.test(p) ? "colors" : p);
    const g = groupIssues([issue("colors.0", "Máximo 40 caracteres"), issue("colors.3", "Máximo 40 caracteres"), issue("colors.4", "Este campo es obligatorio")], { fields: ["colors"], resolve });
    expect(g.fields.colors).toEqual(["Máximo 40 caracteres", "Este campo es obligatorio"]); // el idéntico no se repite
    expect(groupIssues([issue("x", "a")], { resolve: () => undefined }).unmatched).toEqual([issue("x", "a")]);
  });

  it("sin duplicados: el mismo mensaje repetido en un campo, en global o en unmatched se guarda una vez", () => {
    const g = groupIssues([issue("a", "m"), issue("a", "m"), issue("", "g"), issue("", "g"), issue("z", "u"), issue("z", "u")], { fields: ["a"] });
    expect(g).toEqual({ fields: { a: ["m"] }, global: ["g"], unmatched: [issue("z", "u")] });
  });

  it("determinista: la misma entrada da siempre la misma salida y no se reordena alfabéticamente", () => {
    const input = [issue("z", "1"), issue("a", "2"), issue("z", "3"), issue("m", "4")];
    const run = () => JSON.stringify(groupIssues(input));
    expect(run()).toBe(run());
    expect(Object.keys(groupIssues(input).fields)).toEqual(["z", "a", "m"]);
  });

  it("entradas ausentes o mal formadas no rompen nada", () => {
    expect(groupIssues(undefined)).toEqual({ fields: {}, global: [], unmatched: [] });
    expect(groupIssues(null)).toEqual({ fields: {}, global: [], unmatched: [] });
    const bad = [null, 5, "x", {}, { path: "a" }, { path: "a", message: "" }, { path: "a", message: "  " }, { path: 3, message: "sin path de texto" }];
    const g = groupIssues(bad as unknown[]);
    expect(g.fields).toEqual({});
    expect(g.global).toEqual(["sin path de texto"]); // path que no es texto → sin campo
  });

  it("un path como «constructor» o «__proto__» es un campo más y no contamina nada", () => {
    const g = groupIssues([issue("__proto__", "a"), issue("constructor", "b")]);
    expect(g.fields["__proto__"]).toEqual(["a"]);
    expect(g.fields["constructor"]).toEqual(["b"]);
    expect(({} as Record<string, unknown>)["a"]).toBeUndefined();
    expect(Object.getPrototypeOf(g.fields)).toBeNull();
  });

  it("no modifica la entrada", () => {
    const input = Object.freeze([Object.freeze(issue("a", "m"))]);
    expect(() => groupIssues(input)).not.toThrow();
  });
});
