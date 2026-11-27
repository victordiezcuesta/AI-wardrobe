import { StrictMode, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmDialog, Modal } from "@/components/ui";
import { activeScrollLocks } from "@/utils/scroll-lock";
import { openModalCount } from "@/utils/modal-stack";

/**
 * Fase C — comportamiento del componente `Modal` compartido (y de `ConfirmDialog` sobre él), con la interacción real de user-event
 * sobre jsdom y las animaciones reales de framer-motion. Qué NO demuestra jsdom: no implementa `inert` (un navegador real impide
 * foco y clics en lo inerte; aquí se comprueban el atributo y la lógica propia de foco) ni la maquetación real; el comportamiento en
 * Chrome se verifica aparte.
 */
const closed = () => waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument(), { timeout: 4000 });
const dialog = (name: string) => screen.getByRole("dialog", { name });
const btn = (name: string, root: HTMLElement | Document = document.body) => within(root as HTMLElement).getByRole("button", { name });
const isInert = (el: Element) => el.hasAttribute("inert");

/** Un modal con fondo: elementos enfocables en la página, un aviso (región viva) y contenido variado dentro del diálogo. */
function Single({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <main data-testid="pagina">
        <button type="button" onClick={() => setOpen(true)}>Abrir</button>
        <input aria-label="Campo de fondo" />
        <a href="#fondo">Enlace de fondo</a>
      </main>
      <div role="status" data-testid="aviso">Aviso</div>
      <Modal open={open} onClose={() => { onClose?.(); setOpen(false); }} title="Diálogo">
        <input aria-label="Nombre" />
        <button type="button" disabled>Deshabilitado</button>
        <button type="button" hidden>Oculto por atributo</button>
        <input type="hidden" name="h" value="1" />
        <input type="file" aria-label="Archivo oculto" style={{ display: "none" }} />
        <button type="button">Aceptar</button>
      </Modal>
    </>
  );
}

/** Dos diálogos anidados como en item-editor: el ConfirmDialog va DENTRO del panel del exterior. */
function Nested({ onOuterClose, onInnerClose }: { onOuterClose?: () => void; onInnerClose?: () => void }) {
  const [outer, setOuter] = useState(false);
  const [inner, setInner] = useState(false);
  return (
    <>
      <main data-testid="pagina"><button type="button" onClick={() => setOuter(true)}>Abrir exterior</button></main>
      <div role="status" data-testid="aviso">Aviso</div>
      <Modal open={outer} onClose={() => { onOuterClose?.(); setOuter(false); }} title="Exterior">
        <input aria-label="Campo exterior" />
        <button type="button" onClick={() => setInner(true)}>Eliminar</button>
        <ConfirmDialog open={inner} title="¿Seguro?" description="Se borrará." confirmLabel="Confirmar" destructive onConfirm={() => undefined} onClose={() => { onInnerClose?.(); setInner(false); }} />
      </Modal>
    </>
  );
}

afterEach(() => { document.body.removeAttribute("style"); });

describe("Modal — apertura, foco inicial y ciclo de foco", () => {
  it("1. al abrir, el diálogo está etiquetado y el foco pasa a un elemento dentro de él", async () => {
    const user = userEvent.setup();
    render(<Single />);
    await user.click(btn("Abrir"));
    expect(dialog("Diálogo")).toHaveAttribute("aria-modal", "true");
    expect(dialog("Diálogo")).toContainElement(document.activeElement as HTMLElement);
    expect(btn("Cerrar")).toHaveFocus();
  });

  it("2. el ciclo de foco excluye lo deshabilitado, lo oculto, input[type=hidden] y el input de archivo oculto", async () => {
    const user = userEvent.setup();
    render(<Single />);
    await user.click(btn("Abrir"));
    const visited = new Set<string>();
    for (let i = 0; i < 9; i++) { await user.tab(); visited.add(document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? "?"); }
    expect(visited).toEqual(new Set(["Cerrar", "Nombre", "Aceptar"]));
  });

  it("3. Tab y Shift+Tab mantienen el foco dentro y dan la vuelta en los extremos", async () => {
    const user = userEvent.setup();
    render(<Single />);
    await user.click(btn("Abrir"));
    expect(btn("Cerrar")).toHaveFocus();
    await user.tab({ shift: true });
    expect(btn("Aceptar")).toHaveFocus();     // desde el primero, Shift+Tab → último (no sale al fondo)
    await user.tab();
    expect(btn("Cerrar")).toHaveFocus();      // desde el último, Tab → primero (no entra en el input de archivo oculto)
    await user.tab();
    expect(screen.getByLabelText("Nombre")).toHaveFocus();
    await user.tab({ shift: true });
    expect(btn("Cerrar")).toHaveFocus();
  });
});

describe("Modal — Tab con un elemento que no acepta el foco", () => {
  it("3b. si un elemento tabulable rechaza el foco (p. ej. contenido de un <details> cerrado), Tab y Shift+Tab lo saltan y no se atascan", async () => {
    const user = userEvent.setup();
    function Con() {
      const [open, setOpen] = useState(true);
      return (<main><Modal open={open} onClose={() => setOpen(false)} title="Diálogo"><button type="button">A</button><button type="button">B</button><button type="button">C</button></Modal></main>);
    }
    render(<Con />);
    const rechaza = vi.fn();
    (btn("B") as HTMLElement).focus = rechaza as unknown as HTMLElement["focus"]; // instrumentación por instancia: B no acepta el foco
    expect(btn("Cerrar")).toHaveFocus();
    await user.tab(); expect(btn("A")).toHaveFocus();
    await user.tab(); expect(btn("C")).toHaveFocus();               // B rechaza: se salta en vez de quedarse en A
    await user.tab(); expect(btn("Cerrar")).toHaveFocus();          // vuelta
    await user.tab({ shift: true }); expect(btn("C")).toHaveFocus();
    await user.tab({ shift: true }); expect(btn("A")).toHaveFocus(); // hacia atrás también salta B
    expect(rechaza).toHaveBeenCalledTimes(2);                       // una llamada por pulsación que lo alcanza: sin bucles
  });
});

describe("Modal — Escape", () => {
  it("4. Escape cierra un modal normal una sola vez y se desmonta tras la animación", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Single onClose={onClose} />);
    await user.click(btn("Abrir"));
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    await closed();
    expect(openModalCount()).toBe(0);
  });

  it("5. con modales anidados, Escape cierra solo el superior", async () => {
    const user = userEvent.setup();
    const onOuter = vi.fn(); const onInner = vi.fn();
    render(<Nested onOuterClose={onOuter} onInnerClose={onInner} />);
    await user.click(btn("Abrir exterior"));
    await user.click(btn("Eliminar", dialog("Exterior")));
    expect(screen.getAllByRole("dialog")).toHaveLength(2);
    await user.keyboard("{Escape}");
    expect(onInner).toHaveBeenCalledTimes(1);
    expect(onOuter).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1), { timeout: 4000 });
    expect(dialog("Exterior")).toBeInTheDocument();
  });

  it("6. el modal exterior sigue funcionando tras cerrar el interior (foco, Tab, Escape y reabrir el interior)", async () => {
    const user = userEvent.setup();
    const onOuter = vi.fn();
    render(<Nested onOuterClose={onOuter} />);
    await user.click(btn("Abrir exterior"));
    await user.click(btn("Eliminar", dialog("Exterior")));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1), { timeout: 4000 });
    // El foco sigue atrapado en el exterior: Tab recorre solo sus controles
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) { await user.tab(); seen.add(document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? "?"); }
    expect(seen).toEqual(new Set(["Cerrar", "Campo exterior", "Eliminar"]));
    // Se puede volver a abrir el interior y cerrar con su botón «Cancelar»
    await user.click(btn("Eliminar", dialog("Exterior")));
    expect(screen.getAllByRole("dialog")).toHaveLength(2);
    await user.click(btn("Cancelar", dialog("¿Seguro?")));
    await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1), { timeout: 4000 });
    // y Escape cierra ahora el exterior
    await user.keyboard("{Escape}");
    expect(onOuter).toHaveBeenCalledTimes(1);
    await closed();
  });
});

describe("Modal — restauración del foco", () => {
  it("7. al cerrar, el foco vuelve al elemento que abrió el modal", async () => {
    const user = userEvent.setup();
    render(<Single />);
    await user.click(btn("Abrir"));
    expect(btn("Abrir")).not.toHaveFocus();
    await user.keyboard("{Escape}");
    expect(btn("Abrir")).toHaveFocus();
    await closed();
    expect(btn("Abrir")).toHaveFocus();
  });

  it("7b. también al cerrar con el botón «Cerrar» y con un clic en el fondo", async () => {
    const user = userEvent.setup();
    render(<Single />);
    await user.click(btn("Abrir"));
    await user.click(btn("Cerrar"));
    expect(btn("Abrir")).toHaveFocus();
    await closed();
    await user.click(btn("Abrir"));
    await user.click(dialog("Diálogo").parentElement!.firstElementChild as HTMLElement); // el fondo (primer hijo de la raíz)
    expect(btn("Abrir")).toHaveFocus();
    await closed();
  });

  it("8. al cerrar el interior, el foco vuelve al exterior (al botón que lo abrió); al cerrar el exterior, al origen", async () => {
    const user = userEvent.setup();
    render(<Nested />);
    await user.click(btn("Abrir exterior"));
    await user.click(btn("Eliminar", dialog("Exterior")));
    expect(dialog("¿Seguro?")).toContainElement(document.activeElement as HTMLElement); // el foco está en el interior
    await user.keyboard("{Escape}");
    expect(btn("Eliminar", dialog("Exterior"))).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(btn("Abrir exterior")).toHaveFocus();
    await closed();
  });

  it("si el elemento que abrió el modal desaparece mientras está abierto, el foco va a la región principal y no a <body>", async () => {
    function Removable() {
      const [show, setShow] = useState(true); const [open, setOpen] = useState(false);
      return (
        <main data-testid="principal">
          {show && <button type="button" onClick={() => setOpen(true)}>Abrir</button>}
          <Modal open={open} onClose={() => setOpen(false)} title="Diálogo"><button type="button" onClick={() => setShow(false)}>Quitar origen</button></Modal>
        </main>
      );
    }
    const user = userEvent.setup();
    render(<Removable />);
    await user.click(btn("Abrir"));
    await user.click(btn("Quitar origen"));
    expect(screen.queryByRole("button", { name: "Abrir" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.getByTestId("principal")).toHaveFocus();
    await closed();
  });
});

describe("Modal — bloqueo de scroll", () => {
  it("9 y 10. el scroll sigue bloqueado mientras quede un modal abierto y se restaura el valor original al cerrar el último", async () => {
    const user = userEvent.setup();
    document.body.style.overflow = "scroll"; // estado original del documento
    render(<Nested />);
    await user.click(btn("Abrir exterior"));
    expect(document.body.style.overflow).toBe("hidden");
    await user.click(btn("Eliminar", dialog("Exterior")));
    expect(activeScrollLocks()).toBe(2);
    await user.keyboard("{Escape}");                       // se cierra el interior…
    expect(document.body.style.overflow).toBe("hidden");   // …el scroll sigue bloqueado por el exterior
    expect(activeScrollLocks()).toBe(1);
    await user.keyboard("{Escape}");                       // se cierra el último
    expect(document.body.style.overflow).toBe("scroll");
    expect(activeScrollLocks()).toBe(0);
    await closed();
  });
});

describe("Modal — aislamiento del contenido de fondo", () => {
  it("11. el fondo queda inerte y no recibe foco (ni por Tab ni de forma programática); el diálogo y los avisos no", async () => {
    const user = userEvent.setup();
    render(<Single />);
    await user.click(btn("Abrir"));
    const main = screen.getByTestId("pagina");
    expect(isInert(main)).toBe(true);
    expect(isInert(screen.getByTestId("aviso"))).toBe(false);  // una región viva no se silencia
    expect(isInert(dialog("Diálogo"))).toBe(false);
    expect(isInert(dialog("Diálogo").parentElement as HTMLElement)).toBe(false);
    // Tab nunca llega al fondo
    for (let i = 0; i < 8; i++) { await user.tab(); expect(main).not.toContainElement(document.activeElement as HTMLElement); }
    // Foco programático al fondo (jsdom no implementa inert: lo impide el listener de focusin del diálogo)
    screen.getByLabelText("Campo de fondo").focus();
    expect(screen.getByLabelText("Campo de fondo")).not.toHaveFocus();
    expect(dialog("Diálogo")).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard("{Escape}");
    expect(isInert(main)).toBe(false);                          // al cerrar, el fondo vuelve a estar activo
    await closed();
  });

  it("11b. con anidados, mientras el interior está abierto el contenido del exterior también es inerte; el interior y el exterior (ancestro) no", async () => {
    const user = userEvent.setup();
    render(<Nested />);
    await user.click(btn("Abrir exterior"));
    const outer = dialog("Exterior");
    await user.click(btn("Eliminar", outer));
    const inner = dialog("¿Seguro?");
    expect(isInert(screen.getByLabelText("Campo exterior"))).toBe(true);
    expect(isInert(btn("Eliminar", outer))).toBe(true);
    expect(isInert(inner)).toBe(false);
    expect(isInert(btn("Confirmar", inner))).toBe(false);
    expect(isInert(outer)).toBe(false);                         // el panel del exterior es ancestro del interior: no se inutiliza
    expect(isInert(screen.getByTestId("pagina"))).toBe(true);
    screen.getByLabelText("Campo exterior").focus();            // contenido del exterior: tampoco recibe foco
    expect(screen.getByLabelText("Campo exterior")).not.toHaveFocus();
    expect(inner).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1), { timeout: 4000 });
    expect(isInert(screen.getByLabelText("Campo exterior"))).toBe(false);   // el exterior vuelve a estar activo
    expect(isInert(screen.getByTestId("pagina"))).toBe(true);               // y el fondo sigue aislado
    await user.keyboard("{Escape}");
    expect(document.querySelectorAll("[inert]").length).toBe(1);            // solo el diálogo ya cerrado, mientras dura su animación de salida
    expect(isInert(screen.getByTestId("pagina"))).toBe(false);              // el fondo ya está activo
    await closed();
    expect(document.querySelectorAll("[inert]").length).toBe(0);            // desmontado: no queda ningún inert
  });
});

describe("Modal — ciclo de vida", () => {
  it("12. al desmontar con diálogos anidados abiertos se limpian listeners, scroll, inert y pila", async () => {
    const user = userEvent.setup();
    const add = vi.spyOn(document, "addEventListener"); const remove = vi.spyOn(document, "removeEventListener");
    const onOuter = vi.fn(); const onInner = vi.fn();
    const { unmount } = render(<Nested onOuterClose={onOuter} onInnerClose={onInner} />);
    document.body.style.overflow = "auto";
    await user.click(btn("Abrir exterior"));
    await user.click(btn("Eliminar", dialog("Exterior")));
    const keydown = (m: typeof add) => m.mock.calls.filter(([t]) => t === "keydown").length;
    const focusin = (m: typeof add) => m.mock.calls.filter(([t]) => t === "focusin").length;
    // Un único par de listeners aunque haya dos diálogos abiertos (sin listeners duplicados)
    expect([keydown(add), focusin(add)]).toEqual([1, 1]);
    unmount();
    expect([keydown(remove), focusin(remove)]).toEqual([1, 1]);
    expect(openModalCount()).toBe(0);
    expect(activeScrollLocks()).toBe(0);
    expect(document.body.style.overflow).toBe("auto");
    expect(document.querySelectorAll("[inert]").length).toBe(0);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onOuter).not.toHaveBeenCalled();
    expect(onInner).not.toHaveBeenCalled();
    add.mockRestore(); remove.mockRestore();
  });

  it("Strict Mode (montaje, desmontaje y remontaje de efectos) deja la pila, el scroll y el foco coherentes", async () => {
    function Abierto({ onClose }: { onClose: () => void }) {
      const [open, setOpen] = useState(true);
      return (<main><button type="button">Origen</button><Modal open={open} onClose={() => { onClose(); setOpen(false); }} title="Diálogo"><input aria-label="Texto" /></Modal></main>);
    }
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<StrictMode><Abierto onClose={onClose} /></StrictMode>);
    expect(openModalCount()).toBe(1);
    expect(activeScrollLocks()).toBe(1);
    expect(document.body.style.overflow).toBe("hidden");
    expect(btn("Cerrar")).toHaveFocus();
    expect(isInert(dialog("Diálogo").parentElement as HTMLElement)).toBe(false);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(openModalCount()).toBe(0);
    expect(activeScrollLocks()).toBe(0);
    expect(document.body.style.overflow).toBe("");
    await closed();
  });

  it("un onClose en línea que cambia en cada render no reinicia el foco ni el registro, y Escape usa siempre el más reciente", async () => {
    const log = vi.fn();
    function Escribiendo() {
      const [texto, setTexto] = useState(""); const [open, setOpen] = useState(true); const [busy, setBusy] = useState(false);
      return (
        <main>
          <Modal open={open} onClose={() => { if (busy) return; log(texto.length); setOpen(false); }} title="Escribir">
            <input aria-label="Texto" value={texto} onChange={(e) => setTexto(e.target.value)} />
            <button type="button" onClick={() => setBusy((b) => !b)}>{busy ? "Libre" : "Ocupado"}</button>
          </Modal>
        </main>
      );
    }
    const user = userEvent.setup();
    render(<Escribiendo />);
    await user.click(screen.getByLabelText("Texto"));
    await user.keyboard("abc");                         // 3 renders del padre, 3 onClose distintos
    expect(screen.getByLabelText("Texto")).toHaveFocus(); // antes el foco volvía al primer control en cada render
    expect(screen.getByLabelText("Texto")).toHaveValue("abc");
    expect(openModalCount()).toBe(1);
    expect(activeScrollLocks()).toBe(1);
    await user.click(btn("Ocupado"));                   // «ocupado»: el onClose más reciente ignora Escape (patrón de privacy-panel)
    await user.keyboard("{Escape}");
    expect(log).not.toHaveBeenCalled();
    expect(dialog("Escribir")).toBeInTheDocument();
    await user.click(btn("Libre"));
    await user.keyboard("{Escape}");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(3);                // el cierre más reciente (con texto de 3 caracteres)
    await closed();
  });
});
