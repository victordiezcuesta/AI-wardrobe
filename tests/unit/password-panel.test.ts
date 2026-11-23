import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { HIDDEN, PasswordPanel, PasswordPanelView, type PasswordPanelViewProps } from "@/features/profile/components/password-panel";
import { EMPTY_VALUES, PASSWORD_MESSAGES } from "@/features/profile/change-password";

/**
 * Fase 20.3c — estructura y accesibilidad del formulario, renderizado en servidor (react-dom/server) con la misma vista que usa
 * el panel. El entorno de pruebas es Node (no hay jsdom ni testing-library): los eventos (clic, escritura) no se simulan aquí;
 * su lógica está en change-password.test.ts y el cableado, en el componente (ver el informe de la fase).
 */
const base = (o: Partial<PasswordPanelViewProps> = {}): PasswordPanelViewProps => ({
  values: EMPTY_VALUES, errors: {}, loading: false, visible: HIDDEN,
  onChange: vi.fn(), onToggle: vi.fn(), onSubmit: vi.fn(), ...o,
});
const render = (o?: Partial<PasswordPanelViewProps>) => renderToStaticMarkup(createElement(PasswordPanelView, base(o)));
const inputs = (html: string) => [...html.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]);
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
/** Atributo booleano real (`disabled=""`), no la cadena «disabled:» de las clases de Tailwind. */
const hasAttr = (tag: string, name: string) => new RegExp(`\\s${name}(?:="[^"]*")?(?=[\\s>/])`).test(tag);

describe("PasswordPanelView — estructura y accesibilidad", () => {
  it("renderiza una sección identificable con título y tres campos de contraseña", () => {
    const html = render();
    expect(html).toMatch(/<section[^>]*aria-labelledby="contrasena"/);
    expect(html).toMatch(/<h2 id="contrasena"[^>]*>Contraseña<\/h2>/);
    const ins = inputs(html);
    expect(ins).toHaveLength(3);
    expect(ins.map((i) => attr(i, "name"))).toEqual(["currentPassword", "newPassword", "confirmPassword"]);
    for (const i of ins) { expect(attr(i, "type")).toBe("password"); expect(hasAttr(i, "required")).toBe(true); }
  });

  it("cada campo tiene una etiqueta asociada (for/id) y el autocompletado correcto", () => {
    const html = render();
    const ins = inputs(html);
    const expected = [["Contraseña actual", "current-password"], ["Nueva contraseña", "new-password"], ["Confirma la nueva contraseña", "new-password"]];
    ins.forEach((input, n) => {
      const id = attr(input, "id")!;
      expect(id).toBeTruthy();
      expect(html).toMatch(new RegExp(`<label for="${id.replace(/[:]/g, "\\$&")}"[^>]*>${expected[n]![0]}</label>`));
      expect(attr(input, "autoComplete")).toBe(expected[n]![1]); // React lo serializa así; el navegador lo lee como autocomplete
    });
    expect(new Set(ins.map((i) => attr(i, "id"))).size).toBe(3); // ids distintos
  });

  it("la ayuda de la nueva contraseña menciona los requisitos y el límite de 72 bytes, y está enlazada con aria-describedby", () => {
    const html = render();
    const nuevo = inputs(html)[1]!;
    const hintId = attr(nuevo, "aria-describedby")!;
    expect(html).toMatch(new RegExp(`<p id="${hintId.replace(/[:]/g, "\\$&")}"[^>]*>[^<]*72 bytes UTF-8`));
    expect(html).toContain("Mínimo 10 caracteres");
  });

  /** Nombre accesible aproximado de un botón: su contenido de texto (incluido el visualmente oculto), sin etiquetas. */
  const nameOf = (button: string) => button.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  const toggles = (html: string) => [...html.matchAll(/<button\b[^>]*aria-pressed="[^"]*"[^>]*>.*?<\/button>/g)].map((m) => m[0]);
  const NAMES = ["Mostrar contraseña actual", "Mostrar nueva contraseña", "Mostrar confirmación de la nueva contraseña"];

  it("cada campo tiene un botón conmutador con nombre accesible propio y aria-pressed", () => {
    const ts = toggles(render());
    expect(ts).toHaveLength(3);
    expect(ts.map(nameOf)).toEqual(NAMES);
    for (const t of ts) { expect(t).toContain('type="button"'); expect(attr(t, "aria-pressed")).toBe("false"); }
    expect(new Set(ts.map(nameOf)).size).toBe(3); // cada botón identifica su campo
  });

  it("el nombre accesible es el mismo con la contraseña oculta y visible; solo cambia aria-pressed (y el tipo del input)", () => {
    const fields = ["currentPassword", "newPassword", "confirmPassword"] as const;
    fields.forEach((field, n) => {
      const hidden = toggles(render())[n]!;
      const shown = toggles(render({ visible: { ...HIDDEN, [field]: true } }))[n]!;
      expect(nameOf(shown)).toBe(nameOf(hidden));
      expect(nameOf(shown)).toBe(NAMES[n]);
      expect(attr(hidden, "aria-pressed")).toBe("false");
      expect(attr(shown, "aria-pressed")).toBe("true");
    });
  });

  it("los tres conmutadores son independientes: mostrar uno no cambia el estado ni el tipo de los demás", () => {
    const html = render({ visible: { ...HIDDEN, newPassword: true } });
    expect(inputs(html).map((i) => attr(i, "type"))).toEqual(["password", "text", "password"]);
    expect(toggles(html).map((t) => attr(t, "aria-pressed"))).toEqual(["false", "true", "false"]);
    const todos = render({ visible: { currentPassword: true, newPassword: true, confirmPassword: true } });
    expect(inputs(todos).map((i) => attr(i, "type"))).toEqual(["text", "text", "text"]);
    expect(toggles(todos).map((t) => attr(t, "aria-pressed"))).toEqual(["true", "true", "true"]);
  });

  it("los errores de campo van con aria-invalid y enlazados por aria-describedby a su mensaje", () => {
    const errors = { currentPassword: PASSWORD_MESSAGES.badPassword, confirmPassword: PASSWORD_MESSAGES.mismatch };
    const html = render({ errors });
    const [cur, nue, conf] = inputs(html);
    for (const [tag, msg] of [[cur!, errors.currentPassword], [conf!, errors.confirmPassword]] as const) {
      expect(attr(tag, "aria-invalid")).toBe("true");
      const id = attr(tag, "aria-describedby")!;
      expect(html).toMatch(new RegExp(`<p id="${id.replace(/[:]/g, "\\$&")}"[^>]*>${msg}</p>`));
    }
    expect(attr(nue!, "aria-invalid")).toBe("false");
  });

  it("un error general se anuncia con role=alert; el éxito, en una región role=status", () => {
    expect(render()).not.toContain('role="alert"');
    expect(render({ formError: PASSWORD_MESSAGES.conflict })).toMatch(/<p id="contrasena-error" role="alert"[^>]*>[^<]*han cambiado/);
    expect(render()).toMatch(/<div role="status"><\/div>/);          // la región existe (vacía) antes del éxito
    expect(render({ success: true })).toMatch(/<div role="status"><p[^>]*>Contraseña actualizada/);
  });

  it("en carga: botón de envío deshabilitado y aria-busy, campos y botones de mostrar deshabilitados", () => {
    const html = render({ loading: true });
    const submit = /<button\b[^>]*type="submit"[^>]*>/.exec(html)![0];
    expect(hasAttr(submit, "disabled")).toBe(true);
    expect(submit).toContain('aria-busy="true"');
    for (const i of inputs(html)) expect(hasAttr(i, "disabled")).toBe(true);
    const toggles = [...html.matchAll(/<button\b[^>]*aria-pressed[^>]*>/g)];
    expect(toggles).toHaveLength(3);
    for (const t of toggles) expect(hasAttr(t[0], "disabled")).toBe(true);
  });

  it("sin carga: el botón «Cambiar contraseña» está activo y es de tipo submit; el formulario no usa validación nativa", () => {
    const html = render();
    const submit = /<button\b[^>]*type="submit"[^>]*>.*?<\/button>/.exec(html)![0];
    expect(hasAttr(submit, "disabled")).toBe(false);
    expect(submit).not.toContain("aria-busy");
    for (const i of inputs(html)) expect(hasAttr(i, "disabled")).toBe(false);
    expect(submit).toContain("Cambiar contraseña");
    expect(html).toMatch(/<form[^>]*noValidate/); // React lo serializa así
  });

  it("refleja los valores recibidos (campos controlados) y no los pone en atributos peligrosos", () => {
    const html = render({ values: { currentPassword: "actual-1", newPassword: "nueva-2", confirmPassword: "conf-3" } });
    expect(inputs(html).map((i) => attr(i, "value"))).toEqual(["actual-1", "nueva-2", "conf-3"]);
  });
});

describe("PasswordPanel (componente con estado)", () => {
  it("se renderiza en servidor (la página del perfil es un Server Component) con los campos vacíos y sin mensajes", () => {
    const html = renderToStaticMarkup(createElement(PasswordPanel));
    expect(inputs(html)).toHaveLength(3);
    expect(inputs(html).map((i) => attr(i, "value"))).toEqual(["", "", ""]);
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("Contraseña actualizada");
    expect(html).toContain("Cambiar contraseña");
  });
});
