import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OutfitPicker } from "@/features/virtual-try-on/components/tryon-studio";
import type { OutfitDTO } from "@/features/stylist/types";

/**
 * Fase H.4 — selector de conjuntos con radios HTML NATIVOS. Las flechas y la selección las gestiona el navegador (aquí, user-event, que
 * implementa la navegación nativa de radios); el componente no tiene lógica de teclado propia.
 * LIMITACIONES de jsdom: no hay lector de pantalla (el anuncio real de nombre, posición y descripción se comprueba con NVDA/VoiceOver) ni
 * CSS de Tailwind (del foco visible solo se comprueba que la tarjeta lleva las clases; su aspecto exige navegador). Inicio/Fin no se prueban:
 * los radios nativos no los definen.
 */
const mk = (id: string, name: string, items: string[]): OutfitDTO => ({
  id, name, description: "", occasion: null, reasoning: null, colorNotes: null, createdAt: "2026-01-01T00:00:00.000Z",
  items: items.map((n, i) => ({ id: `${id}-${i}`, itemId: `${id}-i${i}`, alternatives: [], item: { id: `${id}-i${i}`, name: n, category: "TSHIRT", thumbUrl: null, primaryColor: null, status: "AVAILABLE" } })),
} as unknown as OutfitDTO);

const OUTFITS = [mk("o1", "Look casual", ["Camisa blanca", "Vaqueros"]), mk("o2", "Look casual", ["Jersey gris"]), mk("o3", "Oficina", [])];

function Harness({ initial = null, onChange, outfits = OUTFITS }: { initial?: string | null; onChange?: (id: string) => void; outfits?: OutfitDTO[] }) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <>
      <button type="button">Antes</button>
      <OutfitPicker outfits={outfits} value={value} onChange={(id) => { setValue(id); onChange?.(id); }} />
      <button type="button">Después</button>
    </>
  );
}
const radios = () => screen.getAllByRole("radio") as HTMLInputElement[];
const checked = () => radios().filter((r) => r.checked).map((r) => r.value);

describe("OutfitPicker — semántica", () => {
  it("es un grupo «Conjuntos» (fieldset + legend) con un radio NATIVO por conjunto, y sin roles personalizados", () => {
    const { container } = render(<Harness />);
    expect(screen.getByRole("group", { name: "Conjuntos" })).toBeInTheDocument();
    expect(radios()).toHaveLength(3);
    for (const r of radios()) { expect(r.tagName).toBe("INPUT"); expect(r.type).toBe("radio"); expect(r).not.toHaveAttribute("role"); }
    expect(container.querySelector("button[role=radio], [aria-checked]")).toBeNull();
    expect(container.querySelector("fieldset > legend")).toHaveTextContent("Conjuntos");
  });

  it("todos los radios comparten el mismo `name` (un único grupo), distinto entre dos selectores", () => {
    const { container } = render(<><Harness /><Harness /></>);
    const names = [...container.querySelectorAll<HTMLInputElement>("input[type=radio]")].map((r) => r.name);
    expect(new Set(names.slice(0, 3)).size).toBe(1);
    expect(new Set(names.slice(3)).size).toBe(1);
    expect(names[0]).not.toBe(names[3]);
  });

  it("los nombres accesibles incluyen el del conjunto y su posición, y son únicos aunque los nombres se repitan", () => {
    render(<Harness />);
    const names = radios().map((r) => r.labels![0]!.textContent);
    expect(names).toEqual(["Look casual (conjunto 1 de 3)", "Look casual (conjunto 2 de 3)", "Oficina (conjunto 3 de 3)"]);
    expect(screen.getByRole("radio", { name: "Look casual (conjunto 2 de 3)" })).toBeInTheDocument();
    expect(new Set(names).size).toBe(names.length);
  });

  it("cada radio se describe con las prendas de su conjunto (aria-describedby apunta a un texto existente)", () => {
    render(<Harness />);
    expect(screen.getByRole("radio", { name: /conjunto 1 de 3/ })).toHaveAccessibleDescription("Prendas: Camisa blanca, Vaqueros");
    expect(screen.getByRole("radio", { name: /conjunto 2 de 3/ })).toHaveAccessibleDescription("Prendas: Jersey gris");
    expect(screen.getByRole("radio", { name: /conjunto 3 de 3/ })).toHaveAccessibleDescription("Sin prendas");
  });

  it("el indicador de foco visible está en la tarjeta (has-[:focus-visible]) y el input es sr-only", () => {
    render(<Harness />);
    for (const r of radios()) {
      expect(r).toHaveClass("sr-only");
      const card = r.closest("label")!;
      expect(card.className).toContain("has-[:focus-visible]:outline-2");
      expect(card.className).toContain("has-[:focus-visible]:outline-ink");
    }
  });

  it("H.4.1 — el input sr-only se posiciona respecto a SU tarjeta: la tarjeta es `relative` y es el primer ancestro posicionado del input", () => {
    // Comprueba la ESTRUCTURA (clases), no el desplazamiento: jsdom no hace layout ni desplaza una tira con overflow; que el navegador lleve la
    // tarjeta enfocada a la vista con las flechas solo se verifica a mano en un navegador.
    const { container } = render(<Harness />);
    const positioned = (el: Element) => /(^|\s)(relative|absolute|fixed|sticky)(\s|$)/.test(el.className);
    for (const r of radios()) {
      const card = r.closest("label")!;
      expect(card).toHaveClass("relative");
      let n: Element | null = r.parentElement;
      while (n && !positioned(n)) n = n.parentElement;
      expect(n).toBe(card);                                                              // ningún ancestro posicionado entre el input y la tarjeta
      expect(container.querySelector("ul")!.contains(card)).toBe(true);                  // y la tarjeta está dentro de la tira desplazable
    }
  });

  it("H7-05 — la tarjeta NO seleccionada tiene un límite perceptible (ring-control, ≥ 3:1) y la seleccionada se distingue con un anillo más grueso y oscuro", () => {
    render(<Harness initial="o2" />);
    const card = (i: number) => radios()[i]!.closest("label")!;
    for (const i of [0, 2]) { expect(card(i).className).toContain("ring-1 ring-control"); expect(card(i).className).not.toContain("ring-ink"); }
    expect(card(1).className).toContain("ring-2 ring-ink");
    expect(card(1).className).not.toContain("ring-control");
  });

  /**
   * G9-03 — `overflow-x-auto` recorta TAMBIÉN en vertical lo que sobresale de su caja. El contorno de foco de la tarjeta (anchura + separación) y el anillo de
   * selección sobresalen de ella: la tira necesita un relleno al menos igual por arriba, la izquierda, la derecha y abajo. Se calcula a partir de las clases reales.
   * LIMITACIÓN: jsdom no hace layout; que de verdad no se recorte solo se comprueba en un navegador.
   */
  it("G9-03 — el relleno de la tira cubre lo que sobresale de la tarjeta (contorno de foco y anillo de selección) por los cuatro lados", () => {
    const { container } = render(<Harness initial="o1" />);
    const strip = container.querySelector("ul")!;
    const raw = (cls: string, re: RegExp) => { const m = re.exec(cls); return m ? Number(m[1]) : 0; };          // anchura y separación del contorno, y anillo: ya en px
    const space = (cls: string, re: RegExp) => raw(cls, re) * 4;                                               // escala de espaciado de Tailwind: n × 4 px
    const card = radios()[0]!.closest("label")!.className;
    const overhang = Math.max(raw(card, /has-\[:focus-visible\]:outline-offset-(\d+)/) + raw(card, /has-\[:focus-visible\]:outline-(\d+)(?!\w)/), raw(card, /(?:^|\s)ring-(\d+)/));
    expect(overhang).toBeGreaterThanOrEqual(6);                                                             // 4 (separación) + 2 (anchura)
    const pad = space(strip.className, /(?:^|\s)p-(\d+)/);
    expect(strip.className).toContain("overflow-x-auto");                                                   // se conserva el desplazamiento horizontal
    expect(pad).toBeGreaterThanOrEqual(overhang);                                                           // relleno ≥ lo que sobresale, en los cuatro lados
    // Los márgenes negativos compensan el relleno arriba y a los lados: la tira se alinea y ocupa lo mismo que antes (antes: solo `pb-2` = 8 px abajo).
    expect(space(strip.className, /-mx-(\d+)/)).toBe(pad);
    expect(space(strip.className, /-mt-(\d+)/)).toBe(pad);
    expect(strip.className).not.toMatch(/(?:^|\s)-mb-/);
  });

  it("sin conjuntos no hay radios (el grupo queda vacío)", () => {
    render(<Harness outfits={[]} />);
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
  });
});

describe("OutfitPicker — selección", () => {
  it("sin selección inicial no hay ninguno marcado; con preselección válida, solo ese", () => {
    const a = render(<Harness />);
    expect(checked()).toEqual([]);
    a.unmount();
    render(<Harness initial="o2" />);
    expect(checked()).toEqual(["o2"]);
  });

  it("una preselección inexistente no marca nada", () => {
    render(<Harness initial="no-existe" />);
    expect(checked()).toEqual([]);
  });

  it("clic: marca el radio, llama a onChange con el id y solo uno queda marcado", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(screen.getByRole("radio", { name: /conjunto 2 de 3/ }));
    expect(onChange).toHaveBeenLastCalledWith("o2");
    expect(checked()).toEqual(["o2"]);
    await user.click(screen.getByText("Oficina"));                                       // también el texto de la tarjeta (es la etiqueta)
    expect(onChange).toHaveBeenLastCalledWith("o3");
    expect(checked()).toEqual(["o3"]);
  });
});

describe("OutfitPicker — teclado nativo", () => {
  it("sin selección, Tab entra en el grupo UNA vez (en el primero) y el siguiente Tab sale", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole("button", { name: "Antes" }).focus();
    await user.tab();
    expect(radios()[0]).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Después" })).toHaveFocus();
  });

  it("con selección, Tab entra directamente en el radio marcado y sale con el siguiente Tab", async () => {
    const user = userEvent.setup();
    render(<Harness initial="o2" />);
    screen.getByRole("button", { name: "Antes" }).focus();
    await user.tab();
    expect(radios()[1]).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Después" })).toHaveFocus();
  });

  it("flecha derecha/abajo y izquierda/arriba mueven foco y selección, con vuelta en los extremos", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial="o1" onChange={onChange} />);
    radios()[0]!.focus();
    await user.keyboard("{ArrowRight}");
    expect(radios()[1]).toHaveFocus(); expect(checked()).toEqual(["o2"]);
    await user.keyboard("{ArrowDown}");
    expect(radios()[2]).toHaveFocus(); expect(checked()).toEqual(["o3"]);
    await user.keyboard("{ArrowRight}");                                                  // vuelta al primero
    expect(radios()[0]).toHaveFocus(); expect(checked()).toEqual(["o1"]);
    await user.keyboard("{ArrowLeft}");                                                   // vuelta al último
    expect(radios()[2]).toHaveFocus(); expect(checked()).toEqual(["o3"]);
    await user.keyboard("{ArrowUp}");
    expect(radios()[1]).toHaveFocus(); expect(checked()).toEqual(["o2"]);
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(["o2", "o3", "o1", "o3", "o2"]);
  });

  it("la selección con teclado deja un único radio marcado y fuera del grupo no cambia nada", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole("button", { name: "Antes" }).focus();
    await user.tab();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(checked()).toEqual(["o3"]);
    expect(within(screen.getByRole("group", { name: "Conjuntos" })).getAllByRole("radio").filter((r) => (r as HTMLInputElement).checked)).toHaveLength(1);
  });
});
