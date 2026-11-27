import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui";
import { AddItems } from "@/features/wardrobe/components/add-items";
import { ItemEditor } from "@/features/wardrobe/components/item-editor";
import { History } from "@/features/virtual-try-on/components/history";
import type { ItemDTO } from "@/features/wardrobe/types";
import type { TryOnDTO } from "@/features/virtual-try-on/types";
import { activeScrollLocks } from "@/utils/scroll-lock";
import { openModalCount } from "@/utils/modal-stack";

/**
 * Fase C — los escenarios EXACTOS de la auditoría 22.4 con los componentes REALES (no con maquetas): «Añadir prendas» con sus dos
 * `<input type="file" class="hidden">`, la ficha de prenda con su diálogo de confirmación anidado dentro del panel, y el historial de
 * imágenes con el diálogo de confirmación como hermano. jsdom no aplica Tailwind: la clase `hidden` se simula con la misma regla CSS.
 * jsdom tampoco implementa `inert`; se comprueba el atributo y la lógica propia de foco (el comportamiento en Chrome se verifica aparte).
 */
const closedAll = () => waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument(), { timeout: 4000 });
const dialog = (name: string) => screen.getByRole("dialog", { name });
const btn = (name: string | RegExp, root: HTMLElement = document.body) => within(root).getByRole("button", { name });
const isInert = (el: Element) => !!el.closest("[inert]");
const label = (el: Element | null) => el?.getAttribute("aria-label") ?? (el instanceof HTMLInputElement ? el.labels?.[0]?.textContent?.trim() : undefined) ?? el?.textContent?.trim();

const item: ItemDTO = {
  id: "i1", name: "Camiseta de prueba", category: "TSHIRT", subcategory: null, description: null, primaryColor: null, secondaryColors: [],
  pattern: null, material: null, style: [], seasons: [], formality: null, occasions: [], imageUrl: null, thumbUrl: null, needsReview: false,
  aiConfidence: null, isFavorite: false, status: "AVAILABLE", createdAt: "2026-01-01T00:00:00.000Z",
};
const image: TryOnDTO = {
  id: "t1", status: "COMPLETED", scenario: "studio", pose: "standing", outfitId: null, errorMessage: null, attempts: 1, isFavorite: false,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", imageUrl: "https://example.test/i.png", downloadUrl: "/descarga",
};

let style: HTMLStyleElement;
beforeEach(() => { style = document.createElement("style"); style.textContent = ".hidden{display:none}"; document.head.appendChild(style); });
afterEach(() => { style.remove(); document.body.removeAttribute("style"); vi.unstubAllGlobals(); });

describe("«Añadir prendas» (add-items) — el input de archivo oculto ya no rompe el ciclo de foco", () => {
  function Pagina() {
    const [open, setOpen] = useState(false);
    return (
      <ToastProvider>
        <main><button type="button" onClick={() => setOpen(true)}>Añadir prendas</button></main>
        <AddItems open={open} onClose={() => setOpen(false)} onAdded={() => undefined} />
      </ToastProvider>
    );
  }

  it("Tab desde el último botón vuelve al primero y Shift+Tab desde el primero va al último, sin pasar por los input[type=file] ocultos ni salir al fondo", async () => {
    const user = userEvent.setup();
    render(<Pagina />);
    await user.click(btn("Añadir prendas"));
    const dlg = dialog("Añadir prendas");
    const files = dlg.querySelectorAll<HTMLInputElement>("input[type=file]");
    expect(files).toHaveLength(2);                                  // los dos inputs ocultos existen en el DOM…
    expect(getComputedStyle(files[0]!).display).toBe("none");       // …y están realmente ocultos
    expect(btn("Cerrar", dlg)).toHaveFocus();
    const order: string[] = [];
    for (let i = 0; i < 7; i++) { await user.tab(); order.push(label(document.activeElement)!); }
    // H.3: las pestañas usan roving tabindex (patrón APG): solo la SELECCIONADA es tabulable, «Manualmente» se alcanza con las flechas. El ciclo
    // sigue cerrándose dentro del diálogo, sin pasar por los input[type=file] ocultos.
    expect(order).toEqual(["Con fotos", "Una prenda por foto", "Elegir fotos", "Hacer foto", "Cerrar", "Con fotos", "Una prenda por foto"]); // da la vuelta
    for (const f of Array.from(files)) expect(f).not.toHaveFocus();
  });

  it("Shift+Tab desde el primer control va al último («Hacer foto») sin salir al fondo, el fondo queda inerte y Escape devuelve el foco al botón que lo abrió", async () => {
    const user = userEvent.setup();
    render(<Pagina />);
    await user.click(btn("Añadir prendas"));
    const dlg = dialog("Añadir prendas");
    expect(btn("Cerrar", dlg)).toHaveFocus();
    await user.tab({ shift: true });
    expect(btn("Hacer foto", dlg)).toHaveFocus();
    expect(screen.getByRole("main")).toSatisfy(isInert);
    await user.keyboard("{Escape}");
    expect(btn("Añadir prendas")).toHaveFocus();
    await closedAll();
  });
});

describe("ficha de prenda (item-editor) — confirmación anidada dentro del panel", () => {
  function Ficha({ onClose, onDeleted }: { onClose?: () => void; onDeleted?: (id: string) => void }) {
    const [editing, setEditing] = useState<ItemDTO | null>(null);
    const [exists, setExists] = useState(true);
    return (
      <ToastProvider>
        <main data-testid="principal">{exists && <button type="button" onClick={() => setEditing(item)}>Abrir ficha</button>}</main>
        <ItemEditor item={editing} onClose={() => { onClose?.(); setEditing(null); }} onSaved={() => undefined} onDeleted={(id) => { onDeleted?.(id); setExists(false); }} />
      </ToastProvider>
    );
  }

  it("Escape sobre «¿Eliminar esta prenda?» cierra SOLO la confirmación: el editor sigue abierto y el foco vuelve a «Eliminar» (antes se cerraban los dos)", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Ficha onClose={onClose} />);
    await user.click(btn("Abrir ficha"));
    const editor = dialog("Camiseta de prueba");
    await user.click(btn("Eliminar", editor));
    const confirm = dialog("¿Eliminar esta prenda?");
    expect(screen.getAllByRole("dialog")).toHaveLength(2);
    expect(isInert(screen.getByLabelText("Nombre"))).toBe(true);    // el contenido del editor queda inerte mientras la confirmación está abierta
    expect(isInert(confirm)).toBe(false);
    // Tab dentro de la confirmación nunca llega a «Cerrar» del editor ni a sus campos (antes: Cancelar → Eliminar → Cerrar del editor)
    const seen = new Set<string>();
    for (let i = 0; i < 7; i++) { await user.tab(); expect(confirm).toContainElement(document.activeElement as HTMLElement); seen.add(label(document.activeElement)!); }
    expect(seen).toEqual(new Set(["Cerrar", "Cancelar", "Eliminar"]));
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1), { timeout: 4000 }); // solo se fue la confirmación
  });

  it("tras cerrar la confirmación con Escape, el editor sigue activo: foco en «Eliminar», scroll bloqueado y un segundo Escape lo cierra devolviendo el foco a la tarjeta", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Ficha onClose={onClose} />);
    await user.click(btn("Abrir ficha"));
    await user.click(btn("Eliminar", dialog("Camiseta de prueba")));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1), { timeout: 4000 });
    expect(btn("Eliminar", dialog("Camiseta de prueba"))).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");            // el scroll sigue bloqueado por el editor
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(btn("Abrir ficha")).toHaveFocus();
    await closedAll();
    expect(document.body.style.overflow).toBe("");
  });

  it("al confirmar el borrado se cierran los dos a la vez; como la tarjeta ya no existe, el foco va a la región principal (no a <body>) y se libera todo", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })));
    const user = userEvent.setup();
    const onDeleted = vi.fn();
    render(<Ficha onDeleted={onDeleted} />);
    await user.click(btn("Abrir ficha"));
    await user.click(btn("Eliminar", dialog("Camiseta de prueba")));
    await user.click(btn("Eliminar", dialog("¿Eliminar esta prenda?")));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith("i1"), { timeout: 4000 });
    await closedAll();
    expect(screen.getByTestId("principal")).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
    expect(openModalCount()).toBe(0);
    expect(activeScrollLocks()).toBe(0);
    expect(document.body.style.overflow).toBe("");
    expect(document.querySelectorAll("[inert]").length).toBe(0);
  });
});

describe("historial de imágenes (history) — confirmación como diálogo hermano", () => {
  function Historial({ onRemove }: { onRemove?: (id: string) => void }) {
    return (
      <ToastProvider>
        <main><History images={[image]} hasMore={false} loadingMore={false} onMore={() => undefined} onChange={() => undefined} onRemove={onRemove ?? (() => undefined)} /></main>
      </ToastProvider>
    );
  }

  it("Escape sobre «¿Eliminar esta imagen?» cierra solo la confirmación y el foco vuelve a «Eliminar» del visor; después Escape devuelve el foco a la miniatura", async () => {
    const user = userEvent.setup();
    render(<Historial />);
    const tile = btn(/Abrir imagen/);
    await user.click(tile);
    const viewer = dialog("Tu imagen");
    await user.click(btn("Eliminar", viewer));
    const confirm = dialog("¿Eliminar esta imagen?");
    expect(isInert(viewer)).toBe(true);                             // hermanos: el visor queda inerte bajo la confirmación
    expect(isInert(confirm)).toBe(false);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1), { timeout: 4000 });
    expect(isInert(dialog("Tu imagen"))).toBe(false);               // el visor vuelve a estar activo
    expect(btn("Eliminar", dialog("Tu imagen"))).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");
    await user.keyboard("{Escape}");
    expect(tile).toHaveFocus();
    await closedAll();
  });

  it("al confirmar el borrado se cierran ambos y se libera el scroll, el aislamiento y los listeners", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } })));
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(<Historial onRemove={onRemove} />);
    await user.click(btn(/Abrir imagen/));
    await user.click(btn("Eliminar", dialog("Tu imagen")));
    await user.click(btn("Eliminar", dialog("¿Eliminar esta imagen?")));
    await waitFor(() => expect(onRemove).toHaveBeenCalledWith("t1"), { timeout: 4000 });
    await closedAll();
    expect(openModalCount()).toBe(0);
    expect(activeScrollLocks()).toBe(0);
    expect(document.body.style.overflow).toBe("");
    expect(document.querySelectorAll("[inert]").length).toBe(0);
    expect(btn(/Abrir imagen/)).toHaveFocus();                      // la miniatura sigue ahí: el foco vuelve a ella
  });
});
