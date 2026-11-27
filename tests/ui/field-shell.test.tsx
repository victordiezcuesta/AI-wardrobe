import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Input, Select, Textarea } from "@/components/ui";

/**
 * Fase E — FieldShell (a través de Input, Textarea y Select): ayuda y errores a la vez, aria-describedby solo con elementos que
 * existen, aria-invalid coherente e ids sin duplicar.
 */
const ids = (el: Element) => (el.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
const dup = () => { const all = [...document.querySelectorAll("[id]")].map((e) => e.id); return all.length - new Set(all).size; };

describe("FieldShell", () => {
  it("sin ayuda ni error: sin aria-describedby y aria-invalid=false", () => {
    render(<Input label="Email" />);
    const input = screen.getByLabelText("Email");
    expect(input).not.toHaveAttribute("aria-describedby");
    expect(input).toHaveAttribute("aria-invalid", "false");
  });

  it("solo ayuda: describedby apunta a la ayuda", () => {
    render(<Input label="Email" hint="Usa tu correo" />);
    const input = screen.getByLabelText("Email");
    expect(ids(input)).toHaveLength(1);
    expect(document.getElementById(ids(input)[0]!)).toHaveTextContent("Usa tu correo");
    expect(input).toHaveAttribute("aria-invalid", "false");
  });

  it("solo error: describedby apunta al error y aria-invalid=true", () => {
    render(<Input label="Email" error="Introduce un email válido" />);
    const input = screen.getByLabelText("Email");
    expect(ids(input)).toHaveLength(1);
    expect(document.getElementById(ids(input)[0]!)).toHaveTextContent("Introduce un email válido");
    expect(input).toHaveAttribute("aria-invalid", "true");
  });

  it("ayuda y error a la vez: ambos visibles, ambos referenciados (ayuda primero) y con ids distintos", () => {
    render(<Input label="Contraseña" hint="Mínimo 10 caracteres" error="Incluye un número" />);
    const input = screen.getByLabelText("Contraseña");
    const [hintId, errorId] = ids(input);
    expect(ids(input)).toHaveLength(2);
    expect(hintId).not.toBe(errorId);
    expect(screen.getByText("Mínimo 10 caracteres")).toBeVisible();
    expect(screen.getByText("Incluye un número")).toBeVisible();
    expect(document.getElementById(hintId!)).toHaveTextContent("Mínimo 10 caracteres");
    expect(document.getElementById(errorId!)).toHaveTextContent("Incluye un número");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(dup()).toBe(0);
  });

  it("varios errores: todos visibles en una lista que es el elemento referenciado; la ayuda sigue visible", () => {
    render(<Input label="Contraseña" hint="Ayuda" error={["Mínimo 10 caracteres", "Incluye una mayúscula", "Incluye un número"]} />);
    const input = screen.getByLabelText("Contraseña");
    const errorEl = document.getElementById(ids(input)[1]!)!;
    expect(errorEl.tagName).toBe("UL");
    expect([...errorEl.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["Mínimo 10 caracteres", "Incluye una mayúscula", "Incluye un número"]);
    expect(screen.getByText("Ayuda")).toBeVisible();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(dup()).toBe(0);
  });

  it("un error de texto sigue siendo un solo párrafo (diseño de siempre)", () => {
    render(<Input label="Email" error="Introduce un email válido" />);
    expect(document.getElementById(ids(screen.getByLabelText("Email"))[0]!)!.tagName).toBe("P");
  });

  it("lista vacía, cadena vacía o undefined = sin error: sin referencias a elementos inexistentes", () => {
    for (const error of [[], "", undefined] as const) {
      const { unmount } = render(<Input label="Campo" hint="Ayuda" error={error} />);
      const input = screen.getByLabelText("Campo");
      expect(input).toHaveAttribute("aria-invalid", "false");
      for (const id of ids(input)) expect(document.getElementById(id)).not.toBeNull();
      expect(ids(input)).toHaveLength(1);
      unmount();
    }
  });

  it("cada referencia de aria-describedby existe en el documento, para los tres tipos de control", () => {
    render(<><Input label="A" hint="h" error="e" /><Textarea label="B" hint="h" error={["e1", "e2"]} /><Select label="C" hint="h" error="e"><option>x</option></Select></>);
    for (const name of ["A", "B", "C"]) {
      const el = screen.getByLabelText(name);
      expect(ids(el)).toHaveLength(2);
      for (const id of ids(el)) expect(document.getElementById(id)).not.toBeNull();
      expect(el).toHaveAttribute("aria-invalid", "true");
    }
    expect(dup()).toBe(0);
  });

  it("varios campos en la misma página no comparten ids", () => {
    render(<><Input label="Uno" hint="a" error="x" /><Input label="Dos" hint="a" error="x" /></>);
    expect(dup()).toBe(0);
    expect(ids(screen.getByLabelText("Uno"))).not.toEqual(ids(screen.getByLabelText("Dos")));
  });
});
