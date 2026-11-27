import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { nextTabIndex, Tabs, type TabItem } from "@/components/ui/tabs";

/**
 * Fase H.3 — componente de pestañas (patrón WAI-ARIA APG, horizontal, activación automática). Se prueba el comportamiento observable con
 * user-event: foco real (`document.activeElement`), selección, contenido de cada panel, Tab, y que las teclas ajenas NO se interceptan.
 * LIMITACIÓN: jsdom no es un lector de pantalla; el anuncio real de «pestaña 2 de 3, seleccionada» solo se comprueba con NVDA/VoiceOver.
 */
type K = "a" | "b" | "c";
const TABS: readonly TabItem<K>[] = [{ key: "a", label: "Primera" }, { key: "b", label: "Segunda" }, { key: "c", label: "Tercera" }];

function Harness({ initial = "a", onChange, keepMounted }: { initial?: K; onChange?: (k: K) => void; keepMounted?: boolean }) {
  const [value, setValue] = useState<K>(initial);
  return (
    <>
      <button type="button">Antes</button>
      <Tabs
        label="Secciones"
        tabs={TABS}
        value={value}
        onChange={(k) => { setValue(k); onChange?.(k); }}
        keepMounted={keepMounted}
        panels={{ a: <button type="button">Acción A</button>, b: <p>Texto B</p>, c: <input aria-label="Campo C" /> }}
      />
      <button type="button">Después</button>
    </>
  );
}
const tabs = () => screen.getAllByRole("tab");
const tab = (name: string) => screen.getByRole("tab", { name });
const selected = () => tabs().filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.textContent);
const focused = () => document.activeElement?.textContent;
/** Lleva el foco a la pestaña seleccionada con Tab real (Antes → pestaña seleccionada). */
async function focusSelectedTab(user: ReturnType<typeof userEvent.setup>) { await user.tab(); await user.tab(); }

describe("nextTabIndex (teclas del patrón, horizontal)", () => {
  it.each([
    ["ArrowRight", 0, 3, 1], ["ArrowRight", 1, 3, 2], ["ArrowRight", 2, 3, 0],       // de la última da la vuelta a la primera
    ["ArrowLeft", 2, 3, 1], ["ArrowLeft", 1, 3, 0], ["ArrowLeft", 0, 3, 2],         // de la primera da la vuelta a la última
    ["Home", 2, 3, 0], ["Home", 0, 3, 0], ["End", 0, 3, 2], ["End", 2, 3, 2],
    ["ArrowRight", 0, 1, 0], ["ArrowLeft", 0, 1, 0],
  ])("%s desde %i de %i → %i", (key, current, count, expected) => { expect(nextTabIndex(key, current, count)).toBe(expected); });
  it.each(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Enter", " ", "Tab", "Escape", "a", "Backspace"])("la tecla %j no es del componente (null)", (key) => {
    expect(nextTabIndex(key, 1, 3)).toBeNull();
  });
  it("sin pestañas no hace nada", () => { expect(nextTabIndex("ArrowRight", 0, 0)).toBeNull(); });
});

describe("estructura accesible", () => {
  it("el tablist tiene nombre accesible y orientación horizontal por defecto", () => {
    render(<Harness />);
    const list = screen.getByRole("tablist", { name: "Secciones" });
    expect(list).toBeInTheDocument();
    expect(list).not.toHaveAttribute("aria-orientation", "vertical");
    expect(tabs()).toHaveLength(3);
  });

  it("cada pestaña controla su panel y cada panel está etiquetado por su pestaña; todos los ids son únicos y existen", () => {
    render(<Harness />);
    const ids: string[] = [];
    for (const t of tabs()) {
      expect(t.id).not.toBe("");
      const panel = document.getElementById(t.getAttribute("aria-controls")!);
      expect(panel).not.toBeNull();                                  // nunca apunta a un elemento inexistente (también las inactivas)
      expect(panel).toHaveAttribute("role", "tabpanel");
      expect(panel).toHaveAttribute("aria-labelledby", t.id);
      ids.push(t.id, panel!.id);
    }
    expect(new Set(ids).size).toBe(6);
    const allIds = [...document.querySelectorAll("[id]")].map((e) => e.id);
    expect(new Set(allIds).size).toBe(allIds.length);                // ningún id duplicado en el documento
    expect(screen.getByRole("tabpanel", { name: "Primera" })).toBeInTheDocument();   // el panel activo toma su nombre de la pestaña
  });

  it("dos conjuntos de pestañas en la misma página no comparten ids", () => {
    render(<><Harness /><Harness /></>);
    const allIds = [...document.querySelectorAll("[id]")].map((e) => e.id);
    expect(allIds).toHaveLength(12);
    expect(new Set(allIds).size).toBe(12);
  });

  it("estado inicial: aria-selected solo en la primera; tabIndex 0 solo en la seleccionada y -1 en las demás", () => {
    render(<Harness />);
    expect(tabs().map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    expect(tabs().map((t) => t.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    expect(tabs().every((t) => t.getAttribute("type") === "button")).toBe(true);
  });

  it("solo el panel activo se muestra y tiene contenido; los demás existen, están ocultos y vacíos", () => {
    const { container } = render(<Harness initial="b" />);
    const panels = [...container.querySelectorAll<HTMLElement>("[role=tabpanel]")];
    expect(panels).toHaveLength(3);
    expect(panels.filter((p) => !p.hidden)).toHaveLength(1);
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Texto B");
    for (const p of panels.filter((x) => x.hidden)) expect(p).toBeEmptyDOMElement();
  });
});

describe("teclado: el foco acompaña a la selección", () => {
  it("Tab llega a la pestaña seleccionada (no a las demás) y desde ella sale hacia el contenido del panel", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.tab();
    expect(focused()).toBe("Antes");
    await user.tab();
    expect(tab("Primera")).toHaveFocus();                            // la «Segunda» y la «Tercera» no son parada de Tab
    await user.tab();
    expect(focused()).toBe("Acción A");                              // sale del tablist hacia el panel
    await user.tab();
    expect(focused()).toBe("Después");
    await user.tab({ shift: true }); await user.tab({ shift: true });
    expect(tab("Primera")).toHaveFocus();                            // Shift+Tab vuelve a la pestaña seleccionada
  });

  it("flecha derecha: mueve el foco Y la selección a la siguiente pestaña, y en la última da la vuelta a la primera", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await focusSelectedTab(user);
    for (const [name, content] of [["Segunda", "Texto B"], ["Tercera", null], ["Primera", "Acción A"]] as const) {
      await user.keyboard("{ArrowRight}");
      expect(tab(name)).toHaveFocus();                               // el foco real está en la pestaña nueva
      expect(selected()).toEqual([name]);
      expect(tab(name)).toHaveAttribute("tabindex", "0");
      expect(tabs().filter((t) => t !== tab(name)).every((t) => t.getAttribute("tabindex") === "-1")).toBe(true);
      expect(screen.getByRole("tabpanel", { name })).toBeInTheDocument();
      if (content) expect(screen.getByRole("tabpanel")).toHaveTextContent(content);
    }
  });

  it("flecha izquierda: va a la anterior y en la primera da la vuelta a la última", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await focusSelectedTab(user);
    for (const name of ["Tercera", "Segunda", "Primera"]) {
      await user.keyboard("{ArrowLeft}");
      expect(tab(name)).toHaveFocus();
      expect(selected()).toEqual([name]);
    }
  });

  it("Inicio y Fin seleccionan la primera y la última pestaña y llevan allí el foco (también si ya estás en ella)", async () => {
    const user = userEvent.setup();
    render(<Harness initial="b" />);
    await focusSelectedTab(user);
    await user.keyboard("{End}");
    expect(tab("Tercera")).toHaveFocus(); expect(selected()).toEqual(["Tercera"]);
    await user.keyboard("{End}");
    expect(tab("Tercera")).toHaveFocus(); expect(selected()).toEqual(["Tercera"]);
    await user.keyboard("{Home}");
    expect(tab("Primera")).toHaveFocus(); expect(selected()).toEqual(["Primera"]);
    await user.keyboard("{Home}");
    expect(tab("Primera")).toHaveFocus(); expect(selected()).toEqual(["Primera"]);
  });

  it("tras moverte con flechas, Tab sigue desde la pestaña nueva hacia el contenido de SU panel (o a lo siguiente si no tiene controles)", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await focusSelectedTab(user);
    await user.keyboard("{ArrowRight}");                             // Segunda: su panel no tiene controles
    await user.tab();
    expect(focused()).toBe("Después");
    await user.tab({ shift: true });
    expect(tab("Segunda")).toHaveFocus();
    await user.keyboard("{ArrowRight}");                             // Tercera: panel con un campo
    await user.tab();
    expect(screen.getByRole("textbox", { name: "Campo C" })).toHaveFocus();
  });

  it("Enter y espacio sobre la pestaña enfocada no cambian la selección ni mueven el foco (ya está seleccionada)", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    await focusSelectedTab(user);
    await user.keyboard("{Enter}"); await user.keyboard(" ");
    expect(tab("Primera")).toHaveFocus();
    expect(selected()).toEqual(["Primera"]);
    expect(onChange.mock.calls.every(([k]) => k === "a")).toBe(true);
  });
});

describe("ratón y táctil", () => {
  it("un clic selecciona la pestaña, actualiza el contenido y el roving tabindex; el clic en la ya seleccionada no cambia nada", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(tab("Tercera"));
    expect(selected()).toEqual(["Tercera"]);
    expect(screen.getByRole("textbox", { name: "Campo C" })).toBeInTheDocument();
    expect(tabs().map((t) => t.getAttribute("tabindex"))).toEqual(["-1", "-1", "0"]);
    await user.click(tab("Tercera"));
    expect(selected()).toEqual(["Tercera"]);
    await user.click(tab("Primera"));
    expect(screen.getByRole("button", { name: "Acción A" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Campo C" })).not.toBeInTheDocument();
  });

  it("un toque (pointer táctil) también selecciona", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.pointer({ keys: "[TouchA]", target: tab("Segunda") });
    expect(selected()).toEqual(["Segunda"]);
  });
});

describe("la selección no cambia por recibir foco, y las teclas ajenas no se interceptan", () => {
  it("enfocar una pestaña (por Tab o por programa) NO la selecciona", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    await focusSelectedTab(user);
    tab("Segunda").focus();
    expect(tab("Segunda")).toHaveFocus();
    expect(selected()).toEqual(["Primera"]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Enter", " ", "Escape", "Tab", "a", "Delete"])("la tecla %j no se intercepta: ni preventDefault, ni selección, ni foco", (key) => {
    render(<Harness initial="b" />);
    const t = tab("Segunda");
    t.focus();
    const notPrevented = fireEvent.keyDown(t, { key });
    expect(notPrevented).toBe(true);
    expect(selected()).toEqual(["Segunda"]);
    expect(t).toHaveFocus();
  });

  it.each(["ArrowLeft", "ArrowRight", "Home", "End"])("las combinaciones con Alt, Ctrl, Meta o Shift sobre %s no se interceptan", (key) => {
    render(<Harness initial="b" />);
    const t = tab("Segunda");
    t.focus();
    for (const mod of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
      expect(fireEvent.keyDown(t, { key, ...mod })).toBe(true);     // p. ej. Alt+← («atrás» del navegador) o Ctrl+Inicio
      expect(selected()).toEqual(["Segunda"]);
      expect(t).toHaveFocus();
    }
  });

  it.each(["ArrowLeft", "ArrowRight", "Home", "End"])("%s sí se gestiona: se cancela su acción por defecto para no desplazar la página", (key) => {
    render(<Harness initial="b" />);
    const t = tab("Segunda");
    t.focus();
    expect(fireEvent.keyDown(t, { key })).toBe(false);
  });

  it("las teclas escritas dentro del panel no pasan por el componente (un campo de texto conserva sus flechas)", async () => {
    const user = userEvent.setup();
    render(<Harness initial="c" />);
    const input = screen.getByRole("textbox", { name: "Campo C" });
    await user.type(input, "abc{ArrowLeft}{ArrowLeft}X{Home}Y{End}Z");
    expect(input).toHaveValue("YaXbcZ");                              // edición normal: ←, Inicio y Fin actuaron sobre el texto
    expect(selected()).toEqual(["Tercera"]);
    expect(input).toHaveFocus();
  });
});

describe("keepMounted (H.3.1): el contenido de los paneles inactivos conserva su estado", () => {
  it("por defecto el contenido inactivo se desmonta: lo escrito se pierde al cambiar de pestaña (comportamiento base del componente)", async () => {
    const user = userEvent.setup();
    render(<Harness initial="c" />);
    await user.type(screen.getByRole("textbox", { name: "Campo C" }), "Hola");
    await user.click(tab("Primera"));
    await user.click(tab("Tercera"));
    expect(screen.getByRole("textbox", { name: "Campo C" })).toHaveValue("");
  });

  it("con keepMounted lo escrito se conserva al cambiar con el ratón y con las flechas, incluso pasando por varias pestañas", async () => {
    const user = userEvent.setup();
    render(<Harness initial="c" keepMounted />);
    await user.type(screen.getByRole("textbox", { name: "Campo C" }), "Hola");
    await user.click(tab("Primera"));
    await user.click(tab("Tercera"));
    expect(screen.getByRole("textbox", { name: "Campo C" })).toHaveValue("Hola");
    tab("Tercera").focus();
    await user.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}{ArrowLeft}{ArrowLeft}{ArrowLeft}{Home}{End}");   // explorando sin soltar la pestaña
    expect(tab("Tercera")).toHaveFocus();
    expect(screen.getByRole("textbox", { name: "Campo C" })).toHaveValue("Hola");
  });

  it("todos los paneles tienen su contenido en el DOM, pero solo el activo se muestra y solo él entra en el árbol de accesibilidad", () => {
    const { container } = render(<Harness keepMounted />);
    const panels = [...container.querySelectorAll<HTMLElement>("[role=tabpanel]")];
    expect(panels).toHaveLength(3);
    expect(panels.filter((p) => !p.hidden)).toHaveLength(1);
    for (const p of panels) expect(p).not.toBeEmptyDOMElement();                       // el contenido oculto sigue montado…
    expect(screen.getByRole("button", { name: "Acción A" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Campo C" })).not.toBeInTheDocument();  // …pero no está en el árbol de accesibilidad
    expect(container.querySelector("input[aria-label='Campo C']")).not.toBeNull();
  });

  it("el contenido oculto no recibe foco con Tab: se salta el campo del panel inactivo", async () => {
    const user = userEvent.setup();
    render(<Harness keepMounted />);
    await focusSelectedTab(user);
    await user.tab(); expect(focused()).toBe("Acción A");
    await user.tab(); expect(focused()).toBe("Después");                                   // nunca «Campo C», que está en un panel oculto
  });

  it("las relaciones ARIA y el contenido de cada pestaña siguen siendo los correctos", async () => {
    const user = userEvent.setup();
    render(<Harness keepMounted />);
    for (const t of tabs()) {
      const panel = document.getElementById(t.getAttribute("aria-controls")!);
      expect(panel).toHaveAttribute("aria-labelledby", t.id);
    }
    await user.click(tab("Segunda"));
    expect(screen.getByRole("tabpanel", { name: "Segunda" })).toHaveTextContent("Texto B");
    await user.click(tab("Tercera"));
    expect(screen.getByRole("tabpanel", { name: "Tercera" })).toContainElement(screen.getByRole("textbox", { name: "Campo C" }));
  });
});

describe("H.3.1.1 — el foco no se pierde al activar una pestaña con un clic", () => {
  // `fireEvent.click` NO mueve el foco (como Safari con los botones): el resultado se comprueba de forma explícita, sin depender de jsdom.
  it("con el foco dentro del panel activo, activar otra pestaña con un clic deja el foco en el botón de esa pestaña", () => {
    render(<Harness keepMounted />);
    screen.getByRole("button", { name: "Acción A" }).focus();
    expect(screen.getByRole("button", { name: "Acción A" })).toHaveFocus();
    fireEvent.click(tab("Segunda"));
    expect(tab("Segunda")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Acción A", hidden: true })).not.toBeVisible();
    expect(tab("Segunda")).toHaveFocus();
    expect(document.body).not.toHaveFocus();
  });

  it("también sin keepMounted (el panel que tenía el foco se desmonta)", () => {
    render(<Harness />);
    screen.getByRole("button", { name: "Acción A" }).focus();
    fireEvent.click(tab("Tercera"));
    expect(tab("Tercera")).toHaveFocus();
  });

  it("si la pestaña ya está activa, el clic no cambia el foco ni llama a onChange", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} keepMounted />);
    screen.getByRole("button", { name: "Acción A" }).focus();
    fireEvent.click(tab("Primera"));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Acción A" })).toHaveFocus();
  });

  it("el teclado no cambia: las flechas siguen moviendo foco y selección, y un clic real conserva roving tabindex", async () => {
    const user = userEvent.setup();
    render(<Harness keepMounted />);
    tab("Primera").focus();
    await user.keyboard("{ArrowRight}");
    expect(tab("Segunda")).toHaveFocus();
    await user.click(tab("Tercera"));
    expect(tab("Tercera")).toHaveFocus();
    expect(tabs().map((t) => t.tabIndex)).toEqual([-1, -1, 0]);
  });
});
