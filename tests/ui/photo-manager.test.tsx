import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui";
import { PhotoManager } from "@/features/virtual-try-on/components/photo-manager";
import type { PhotoDTO } from "@/features/virtual-try-on/types";

/**
 * Fase H.4 — gestor de fotografías: nombres accesibles ÚNICOS con la posición en la lista actual («Usar foto 2 de 3»), `aria-pressed` y
 * comportamiento de selección y borrado intactos. LIMITACIÓN: jsdom no es un lector de pantalla; lo que anuncia de verdad cada botón se
 * comprueba con NVDA/VoiceOver. La subida (canvas/`prepareImage`) no se prueba aquí: no forma parte de H.4.
 */
const photos = (n: number): PhotoDTO[] => Array.from({ length: n }, (_, i) => ({ publicId: `p${i + 1}`, url: `https://example.test/p${i + 1}.jpg` }));

afterEach(() => vi.unstubAllGlobals());

function Harness({ initial, onSelect }: { initial: PhotoDTO[]; onSelect?: (id: string) => void }) {
  const [list, setList] = useState(initial);
  const [selected, setSelected] = useState<string | null>(initial[0]?.publicId ?? null);
  return (
    <ToastProvider>
      <PhotoManager photos={list} selected={selected} onSelect={(id) => { setSelected(id); onSelect?.(id); }} onChange={setList} />
    </ToastProvider>
  );
}
const usar = () => screen.getAllByRole("button", { name: /^Usar foto/ });
const eliminar = () => screen.getAllByRole("button", { name: /^Eliminar foto/ });
const deleteOk = () => { const f = vi.fn(async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })); vi.stubGlobal("fetch", f); return f; };

describe("PhotoManager — nombres accesibles", () => {
  it("«Usar foto i de n» y «Eliminar foto i de n» con la posición de cada una", () => {
    render(<Harness initial={photos(3)} />);
    expect(usar().map((b) => b.getAttribute("aria-label"))).toEqual(["Usar foto 1 de 3", "Usar foto 2 de 3", "Usar foto 3 de 3"]);
    expect(eliminar().map((b) => b.getAttribute("aria-label"))).toEqual(["Eliminar foto 1 de 3", "Eliminar foto 2 de 3", "Eliminar foto 3 de 3"]);
  });

  it("ningún botón de la lista comparte nombre accesible con otro", () => {
    render(<Harness initial={photos(3)} />);
    const names = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(new Set(names).size).toBe(names.length);
    expect(screen.queryByRole("button", { name: "Usar esta foto" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Eliminar foto" })).not.toBeInTheDocument();
  });

  it("las imágenes son decorativas (alt vacío): el nombre lo da el botón, sin «Tu foto» repetido", () => {
    const { container } = render(<Harness initial={photos(2)} />);
    const imgs = [...container.querySelectorAll("img")];
    expect(imgs).toHaveLength(2);
    for (const img of imgs) expect(img).toHaveAttribute("alt", "");
    expect(screen.queryAllByRole("img")).toHaveLength(0);
  });

  it("con una sola foto: «Usar foto 1 de 1»", () => {
    render(<Harness initial={photos(1)} />);
    expect(screen.getByRole("button", { name: "Usar foto 1 de 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Eliminar foto 1 de 1" })).toBeInTheDocument();
  });
});

describe("PhotoManager — selección y aria-pressed", () => {
  it("aria-pressed solo en la seleccionada; elegir otra llama a onSelect con su publicId y mueve el estado", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness initial={photos(3)} onSelect={onSelect} />);
    expect(usar().map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false", "false"]);
    await user.click(screen.getByRole("button", { name: "Usar foto 3 de 3" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("p3");
    expect(usar().map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "false", "true"]);
  });

  it("se puede elegir con el teclado (Tab hasta el botón y Enter)", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness initial={photos(2)} onSelect={onSelect} />);
    screen.getByRole("button", { name: "Usar foto 2 de 2" }).focus();
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("p2");
  });
});

describe("PhotoManager — borrado", () => {
  it("eliminar abre la confirmación, llama a DELETE con el publicId de ESA foto y retira la foto", async () => {
    const user = userEvent.setup();
    const fetchMock = deleteOk();
    render(<Harness initial={photos(3)} />);
    await user.click(screen.getByRole("button", { name: "Eliminar foto 2 de 3" }));
    const dlg = screen.getByRole("dialog", { name: "¿Eliminar esta foto?" });
    expect(fetchMock).not.toHaveBeenCalled();                                              // no borra sin confirmar
    await user.click(within(dlg).getByRole("button", { name: "Eliminar" }));
    await waitFor(() => expect(usar()).toHaveLength(2));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/photos?publicId=p2");
    expect(init.method).toBe("DELETE");
  });

  it("cancelar no borra nada", async () => {
    const user = userEvent.setup();
    const fetchMock = deleteOk();
    render(<Harness initial={photos(2)} />);
    await user.click(screen.getByRole("button", { name: "Eliminar foto 1 de 2" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancelar" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(usar()).toHaveLength(2);
  });

  it("tras eliminar la foto del medio, las posiciones se recalculan sobre la lista actual", async () => {
    const user = userEvent.setup();
    deleteOk();
    render(<Harness initial={photos(3)} />);
    await user.click(screen.getByRole("button", { name: "Eliminar foto 2 de 3" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Eliminar" }));
    await waitFor(() => expect(usar()).toHaveLength(2));
    expect(usar().map((b) => b.getAttribute("aria-label"))).toEqual(["Usar foto 1 de 2", "Usar foto 2 de 2"]);
    expect(eliminar().map((b) => b.getAttribute("aria-label"))).toEqual(["Eliminar foto 1 de 2", "Eliminar foto 2 de 2"]);
    await user.click(screen.getByRole("button", { name: "Usar foto 2 de 2" }));            // la antigua tercera es ahora la segunda
    expect(usar().map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
  });

  it("si se elimina la seleccionada, se selecciona la primera restante (comportamiento previo)", async () => {
    const user = userEvent.setup();
    deleteOk();
    const onSelect = vi.fn();
    render(<Harness initial={photos(3)} onSelect={onSelect} />);
    await user.click(screen.getByRole("button", { name: "Eliminar foto 1 de 3" }));         // la seleccionada por defecto
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Eliminar" }));
    await waitFor(() => expect(usar()).toHaveLength(2));
    expect(onSelect).toHaveBeenCalledWith("p2");
    expect(usar().map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
  });
});
