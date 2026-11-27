import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Modal, Tooltip } from "@/components/ui";

/**
 * H.8.1 — Tooltip (WCAG 1.4.13): descartable con Escape sin mover el foco, y con contenido sobre el que se puede mover el puntero.
 * LIMITACIÓN: jsdom no hace layout: que no haya hueco físico entre disparador y tooltip solo se comprueba por estructura (la caja del tooltip
 * es descendiente del elemento con `mouseleave`, y no lleva `pointer-events-none`); el movimiento real del puntero exige navegador.
 */
const tip = () => screen.queryByRole("tooltip");
const renderTip = () => render(<><Tooltip text="Guardar en favoritos"><button type="button">Favorito</button></Tooltip><button type="button">Otro</button></>);

describe("Tooltip", () => {
  it("aparece con el foco y se describe por aria-describedby; desaparece al perderlo", async () => {
    const user = userEvent.setup();
    renderTip();
    expect(tip()).toBeNull();
    await user.tab();
    expect(tip()).toHaveTextContent("Guardar en favoritos");
    const btn = screen.getByRole("button", { name: "Favorito" });
    expect(btn).toHaveAttribute("aria-describedby", tip()!.id);                         // H8-02: en el elemento enfocable, no en el contenedor
    expect(btn).toHaveAccessibleDescription("Guardar en favoritos");
    expect(btn.parentElement).not.toHaveAttribute("aria-describedby");
    await user.tab();
    expect(tip()).toBeNull();
    expect(btn).not.toHaveAttribute("aria-describedby");
  });

  it("H8-02 — conserva las props, el ref y los eventos del hijo, y concatena con un aria-describedby propio", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn(); const ref = { current: null as HTMLButtonElement | null };
    render(<><span id="otra">Atajo: F</span><Tooltip text="Guardar"><button type="button" ref={ref} onClick={onClick} data-x="1" aria-describedby="otra">Favorito</button></Tooltip></>);
    const btn = screen.getByRole("button", { name: "Favorito" });
    expect(ref.current).toBe(btn);
    expect(btn).toHaveAttribute("data-x", "1");
    expect(btn).toHaveAccessibleDescription("Atajo: F");
    await user.tab();
    expect(btn).toHaveAccessibleDescription("Atajo: F Guardar");
    await user.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("H8-02 — con un hijo que no es un elemento (texto) la descripción se asocia al contenedor, sin romper", () => {
    render(<Tooltip text="Ayuda">Texto suelto</Tooltip>);
    const wrapper = screen.getByText("Texto suelto");
    fireEvent.mouseEnter(wrapper);
    expect(wrapper).toHaveAttribute("aria-describedby", tip()!.id);
  });

  it("H8-03 — dentro de un diálogo, el primer Escape solo descarta el tooltip y el segundo cierra el diálogo", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Modal open onClose={onClose} title="Diálogo"><Tooltip text="Ayuda"><button type="button">Con ayuda</button></Tooltip></Modal>);
    const btn = await screen.findByRole("button", { name: "Con ayuda" });
    act(() => btn.focus());
    expect(tip()).not.toBeNull();
    await user.keyboard("{Escape}");
    expect(tip()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(btn).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape lo descarta sin mover el foco, y vuelve a mostrarse al volver a enfocar", async () => {
    const user = userEvent.setup();
    renderTip();
    await user.tab();
    expect(tip()).not.toBeNull();
    await user.keyboard("{Escape}");
    expect(tip()).toBeNull();
    expect(screen.getByRole("button", { name: "Favorito" })).toHaveFocus();            // el foco no se mueve
    expect(screen.getByRole("button", { name: "Favorito" })).not.toHaveAttribute("aria-describedby");
    await user.tab(); await user.tab({ shift: true });                                  // salir y volver
    expect(tip()).not.toBeNull();
  });

  it("Escape también lo descarta cuando solo está abierto por el puntero (sin foco en el disparador)", async () => {
    const user = userEvent.setup();
    renderTip();
    const wrapper = screen.getByRole("button", { name: "Favorito" }).parentElement!;
    fireEvent.mouseEnter(wrapper);
    expect(tip()).not.toBeNull();
    await user.keyboard("{Escape}");
    expect(tip()).toBeNull();
    fireEvent.mouseLeave(wrapper); fireEvent.mouseEnter(wrapper);
    expect(tip()).not.toBeNull();
  });

  it("solo escucha Escape mientras está abierto y no interfiere con otras teclas", async () => {
    const user = userEvent.setup();
    renderTip();
    await user.tab();
    await user.keyboard("a{ArrowDown}{Enter}");
    expect(tip()).not.toBeNull();
  });

  it("el tooltip se puede alcanzar con el puntero: es descendiente del elemento que gestiona mouseleave, sin pointer-events-none ni hueco", () => {
    renderTip();
    const wrapper = screen.getByRole("button", { name: "Favorito" }).parentElement!;
    fireEvent.mouseEnter(wrapper);
    const t = tip()!;
    expect(wrapper.contains(t)).toBe(true);
    for (let n: Element | null = t; n && n !== wrapper; n = n.parentElement) expect(n.className).not.toContain("pointer-events-none");
    const box = t.parentElement!;
    expect(box.className).toContain("bottom-full");                                    // pegado al disparador…
    expect(box.className).toContain("pb-1.5");                                         // …con un relleno que cubre el espacio visual
    fireEvent.mouseLeave(wrapper);
    expect(tip()).toBeNull();
  });
});
