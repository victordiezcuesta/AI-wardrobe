import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui";
import { AddItems } from "@/features/wardrobe/components/add-items";
import type { ItemDTO } from "@/features/wardrobe/types";

/**
 * Fase H.3 — las pestañas de «Añadir prendas» con el componente REAL dentro del modal real: nombre del tablist, contenido de cada
 * pestaña, teclado (flechas, Inicio, Fin), ratón, integración con el ciclo de foco del diálogo, y que el comportamiento previo se mantiene
 * (el modo de foto persiste al cambiar de pestaña; Escape cierra). jsdom no aplica Tailwind: `.hidden` se simula con su regla CSS.
 */
let style: HTMLStyleElement;
beforeEach(() => { style = document.createElement("style"); style.textContent = ".hidden{display:none}"; document.head.appendChild(style); });
afterEach(() => { style.remove(); document.body.removeAttribute("style"); vi.unstubAllGlobals(); });

function Pagina({ onClose, onAdded }: { onClose?: () => void; onAdded?: (items: ItemDTO[]) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <ToastProvider>
      <main><button type="button" onClick={() => setOpen(true)}>Añadir prendas</button></main>
      <AddItems open={open} onClose={() => { onClose?.(); setOpen(false); }} onAdded={(items) => onAdded?.(items)} />
    </ToastProvider>
  );
}
async function abrir() {
  const user = userEvent.setup();
  render(<Pagina />);
  await user.click(screen.getByRole("button", { name: "Añadir prendas" }));
  const dlg = screen.getByRole("dialog", { name: "Añadir prendas" });
  return { user, dlg };
}
const tab = (dlg: HTMLElement, name: string) => within(dlg).getByRole("tab", { name });
const selectedTabs = (dlg: HTMLElement) => within(dlg).getAllByRole("tab").filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.textContent);

describe("«Añadir prendas»: pestañas accesibles", () => {
  it("el tablist se llama «Forma de añadir prendas», con las pestañas «Con fotos» (seleccionada) y «Manualmente»", async () => {
    const { dlg } = await abrir();
    const list = within(dlg).getByRole("tablist", { name: "Forma de añadir prendas" });
    expect(within(list).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Con fotos", "Manualmente"]);
    expect(selectedTabs(dlg)).toEqual(["Con fotos"]);
    expect(within(dlg).getAllByRole("tab").map((t) => t.getAttribute("tabindex"))).toEqual(["0", "-1"]);
  });

  it("cada pestaña controla su panel; el activo es «Con fotos» con SU contenido y sin el de la otra", async () => {
    const { dlg } = await abrir();
    for (const t of within(dlg).getAllByRole("tab")) {
      const panel = document.getElementById(t.getAttribute("aria-controls")!);
      expect(panel).toHaveAttribute("role", "tabpanel");
      expect(panel).toHaveAttribute("aria-labelledby", t.id);
    }
    const panel = within(dlg).getByRole("tabpanel", { name: "Con fotos" });
    expect(within(panel).getByRole("button", { name: "Elegir fotos" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Hacer foto" })).toBeInTheDocument();
    expect(within(panel).getByRole("group", { name: "Tipo de foto" })).toBeInTheDocument();
    expect(within(dlg).queryByRole("textbox", { name: "Nombre" })).not.toBeInTheDocument();
  });

  it("flecha derecha: «Manualmente» queda seleccionada Y enfocada y muestra su formulario (sin el contenido de fotos)", async () => {
    const { user, dlg } = await abrir();
    tab(dlg, "Con fotos").focus();
    await user.keyboard("{ArrowRight}");
    expect(tab(dlg, "Manualmente")).toHaveFocus();
    expect(selectedTabs(dlg)).toEqual(["Manualmente"]);
    const panel = within(dlg).getByRole("tabpanel", { name: "Manualmente" });
    expect(within(panel).getByRole("textbox", { name: "Nombre" })).toBeInTheDocument();
    expect(within(panel).getByRole("combobox", { name: "Categoría" })).toBeInTheDocument();
    expect(within(panel).getByRole("combobox", { name: "Color principal" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Añadir" })).toBeDisabled();            // sin nombre, como antes
    expect(within(dlg).queryByRole("button", { name: "Elegir fotos" })).not.toBeInTheDocument();
  });

  it("flecha derecha en la última da la vuelta a la primera; flecha izquierda en la primera va a la última; Inicio y Fin", async () => {
    const { user, dlg } = await abrir();
    tab(dlg, "Con fotos").focus();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(tab(dlg, "Con fotos")).toHaveFocus(); expect(selectedTabs(dlg)).toEqual(["Con fotos"]);
    await user.keyboard("{ArrowLeft}");
    expect(tab(dlg, "Manualmente")).toHaveFocus(); expect(selectedTabs(dlg)).toEqual(["Manualmente"]);
    await user.keyboard("{Home}");
    expect(tab(dlg, "Con fotos")).toHaveFocus(); expect(selectedTabs(dlg)).toEqual(["Con fotos"]);
    await user.keyboard("{End}");
    expect(tab(dlg, "Manualmente")).toHaveFocus(); expect(selectedTabs(dlg)).toEqual(["Manualmente"]);
  });

  it("el ratón sigue funcionando: un clic cambia de pestaña y de contenido, y otro vuelve", async () => {
    const { user, dlg } = await abrir();
    await user.click(tab(dlg, "Manualmente"));
    expect(selectedTabs(dlg)).toEqual(["Manualmente"]);
    expect(within(dlg).getByRole("textbox", { name: "Nombre" })).toBeInTheDocument();
    await user.click(tab(dlg, "Con fotos"));
    expect(selectedTabs(dlg)).toEqual(["Con fotos"]);
    expect(within(dlg).getByRole("button", { name: "Elegir fotos" })).toBeInTheDocument();
  });

  it("en el ciclo de foco del diálogo, desde la pestaña seleccionada Tab va al contenido de su panel y no a la otra pestaña", async () => {
    const { user, dlg } = await abrir();
    tab(dlg, "Con fotos").focus();
    await user.tab();
    expect(document.activeElement).toBe(within(dlg).getByRole("radio", { name: "Una prenda por foto" }));
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(tab(dlg, "Con fotos")).toHaveFocus();
    tab(dlg, "Con fotos").focus();
    await user.keyboard("{ArrowRight}");
    await user.tab();
    expect(within(dlg).getByRole("textbox", { name: "Nombre" })).toHaveFocus();
  });

  it("comportamiento previo intacto: el modo de foto elegido persiste al cambiar de pestaña", async () => {
    const { user, dlg } = await abrir();
    await user.click(within(dlg).getByRole("radio", { name: "Varias prendas en una foto" }));
    expect(within(dlg).getByRole("radio", { name: "Varias prendas en una foto" })).toBeChecked();
    await user.click(tab(dlg, "Manualmente"));
    await user.click(tab(dlg, "Con fotos"));
    expect(within(dlg).getByRole("radio", { name: "Varias prendas en una foto" })).toBeChecked();
  });

  it("las flechas no estorban al diálogo: Escape sigue cerrándolo y devuelve el foco al botón que lo abrió", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Pagina onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "Añadir prendas" }));
    const dlg = screen.getByRole("dialog", { name: "Añadir prendas" });
    tab(dlg, "Con fotos").focus();
    await user.keyboard("{ArrowRight}{ArrowLeft}{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument(), { timeout: 4000 });
    expect(screen.getByRole("button", { name: "Añadir prendas" })).toHaveFocus();
  });
});

const item: ItemDTO = {
  id: "i1", name: "Chaqueta", category: "COAT", subcategory: null, description: null, primaryColor: null, secondaryColors: [],
  pattern: null, material: null, style: [], seasons: [], formality: null, occasions: [], imageUrl: null, thumbUrl: null, needsReview: false,
  aiConfidence: null, isFavorite: false, status: "AVAILABLE", createdAt: "2026-01-01T00:00:00.000Z",
};
const created = () => new Response(JSON.stringify({ item }), { status: 201, headers: { "Content-Type": "application/json" } });
const nombre = (dlg: HTMLElement) => within(dlg).getByRole("textbox", { name: "Nombre" });

describe("H.3.1 — lo escrito en el formulario manual no se pierde al cambiar de pestaña", () => {
  it("escribir, ir a «Con fotos» y volver: nombre, categoría y color siguen ahí (ratón)", async () => {
    const { user, dlg } = await abrir();
    await user.click(tab(dlg, "Manualmente"));
    await user.type(nombre(dlg), "Chaqueta de lana");
    await user.selectOptions(within(dlg).getByRole("combobox", { name: "Categoría" }), "COAT");
    await user.selectOptions(within(dlg).getByRole("combobox", { name: "Color principal" }), "negro");
    await user.click(tab(dlg, "Con fotos"));
    expect(within(dlg).queryByRole("textbox", { name: "Nombre" })).not.toBeInTheDocument();      // oculto: ni visible ni en el árbol de accesibilidad
    await user.click(tab(dlg, "Manualmente"));
    expect(nombre(dlg)).toHaveValue("Chaqueta de lana");
    expect(within(dlg).getByRole("combobox", { name: "Categoría" })).toHaveValue("COAT");
    expect(within(dlg).getByRole("combobox", { name: "Color principal" })).toHaveValue("negro");
    expect(within(dlg).getByRole("button", { name: "Añadir" })).toBeEnabled();
  });

  it("explorando las pestañas con las flechas (el caso accidental de H.3) tampoco se pierde nada", async () => {
    const { user, dlg } = await abrir();
    await user.click(tab(dlg, "Manualmente"));
    await user.type(nombre(dlg), "Camisa");
    tab(dlg, "Manualmente").focus();
    await user.keyboard("{ArrowRight}{ArrowLeft}{Home}{End}{ArrowLeft}{ArrowRight}");
    expect(selectedTabs(dlg)).toEqual(["Manualmente"]);
    expect(nombre(dlg)).toHaveValue("Camisa");
  });

  it("el contenido oculto no entra en el orden de Tab: desde «Con fotos» nunca se llega al campo «Nombre» oculto", async () => {
    const { user, dlg } = await abrir();
    await user.click(tab(dlg, "Manualmente"));
    const campo = nombre(dlg);                                                                      // localizado por rol y nombre mientras es visible
    await user.type(campo, "Camisa");
    await user.click(tab(dlg, "Con fotos"));
    expect(campo).toBeInTheDocument();                                                              // sigue montado, solo oculto
    const visited: Element[] = [];
    for (let i = 0; i < 8; i++) { await user.tab(); visited.push(document.activeElement!); }
    expect(visited).not.toContain(campo);
    expect(visited.every((el) => dlg.contains(el))).toBe(true);                                  // y el foco no sale del diálogo
  });

  it("el envío del formulario sigue funcionando tras cambiar de pestaña: envía los datos conservados, avisa y cierra el diálogo", async () => {
    const fetchMock = vi.fn(async () => created());
    vi.stubGlobal("fetch", fetchMock);
    const onAdded = vi.fn(); const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Pagina onAdded={onAdded} onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "Añadir prendas" }));
    const dlg = screen.getByRole("dialog", { name: "Añadir prendas" });
    await user.click(tab(dlg, "Manualmente"));
    await user.type(nombre(dlg), "Chaqueta");
    await user.selectOptions(within(dlg).getByRole("combobox", { name: "Categoría" }), "COAT");
    await user.selectOptions(within(dlg).getByRole("combobox", { name: "Color principal" }), "negro");
    await user.click(tab(dlg, "Con fotos"));
    await user.click(tab(dlg, "Manualmente"));
    await user.click(within(dlg).getByRole("button", { name: "Añadir" }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/wardrobe");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ name: "Chaqueta", category: "COAT", primaryColor: "negro" });
    expect(onAdded).toHaveBeenCalledWith([item]);
    expect(await screen.findByText("Prenda añadida")).toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("con el envío en curso, cambiar de pestaña y volver NO permite enviar otra vez (el botón sigue ocupado)", async () => {
    let resolve!: (r: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((r) => { resolve = r; }));
    vi.stubGlobal("fetch", fetchMock);
    const onAdded = vi.fn();
    const user = userEvent.setup();
    render(<Pagina onAdded={onAdded} />);
    await user.click(screen.getByRole("button", { name: "Añadir prendas" }));
    const dlg = screen.getByRole("dialog", { name: "Añadir prendas" });
    await user.click(tab(dlg, "Manualmente"));
    await user.type(nombre(dlg), "Chaqueta");
    await user.click(within(dlg).getByRole("button", { name: "Añadir" }));
    expect(within(dlg).getByRole("button", { name: "Añadir" })).toBeDisabled();
    await user.click(tab(dlg, "Con fotos"));
    await user.click(tab(dlg, "Manualmente"));
    const boton = within(dlg).getByRole("button", { name: "Añadir" });
    expect(boton).toBeDisabled();
    expect(boton).toHaveAttribute("aria-busy", "true");
    await user.click(boton);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolve(created());
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
  });

  it("el estado vive lo que vive el diálogo: al cerrarlo y volver a abrirlo, el formulario empieza vacío (como antes)", async () => {
    const user = userEvent.setup();
    render(<Pagina />);
    await user.click(screen.getByRole("button", { name: "Añadir prendas" }));
    let dlg = screen.getByRole("dialog", { name: "Añadir prendas" });
    await user.click(tab(dlg, "Manualmente"));
    await user.type(nombre(dlg), "Chaqueta");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument(), { timeout: 4000 });
    await user.click(screen.getByRole("button", { name: "Añadir prendas" }));
    dlg = screen.getByRole("dialog", { name: "Añadir prendas" });
    expect(selectedTabs(dlg)).toEqual(["Manualmente"]);      // la pestaña elegida persiste (su estado vive en AddItems, como antes de H.3)
    expect(nombre(dlg)).toHaveValue("");                       // pero el formulario se monta de nuevo y empieza vacío
    await user.click(tab(dlg, "Con fotos"));
    await user.click(tab(dlg, "Manualmente"));
    expect(nombre(dlg)).toHaveValue("");
  });
});
