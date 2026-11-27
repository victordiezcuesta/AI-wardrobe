import { useState } from "react";
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui";
import { AddItems } from "@/features/wardrobe/components/add-items";

/**
 * H.6.1 — radios «Tipo de foto» de «Añadir prendas»: el input es `sr-only` y el foco debe verse en SU tarjeta (mismo patrón que `OutfitPicker`).
 * LIMITACIÓN: jsdom no aplica Tailwind; se comprueban estructura y clases, no el aspecto ni que el contorno quede sin recortar (revisión manual).
 */
function Pagina() {
  const [open, setOpen] = useState(false);
  return (
    <ToastProvider>
      <main><button type="button" onClick={() => setOpen(true)}>Abrir</button></main>
      <AddItems open={open} onClose={() => setOpen(false)} onAdded={() => undefined} />
    </ToastProvider>
  );
}
async function abrir() {
  const user = userEvent.setup();
  render(<Pagina />);
  await user.click(screen.getByRole("button", { name: "Abrir" }));
  const dlg = await screen.findByRole("dialog", { name: "Añadir prendas" });
  return { user, dlg, grupo: within(dlg).getByRole("group", { name: "Tipo de foto" }) };
}

describe("H.6.1 — radios de «Añadir prendas»", () => {
  it("grupo «Tipo de foto» con dos radios nativos sr-only; el modo inicial es «Una prenda por foto»", async () => {
    const { grupo } = await abrir();
    const radios = within(grupo).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.labels![0]!.textContent)).toEqual(["Una prenda por foto", "Varias prendas en una foto"]);
    for (const r of radios) { expect(r.type).toBe("radio"); expect(r).toHaveClass("sr-only"); expect(r.name).toBe("mode"); }
    expect(radios.map((r) => r.checked)).toEqual([true, false]);
  });

  it("cada tarjeta lleva el indicador de foco (has-[:focus-visible]) y es `relative` (primer ancestro posicionado del input)", async () => {
    const { grupo } = await abrir();
    for (const r of within(grupo).getAllByRole("radio")) {
      const card = r.closest("label")!;
      expect(card).toHaveClass("relative");
      for (const c of ["has-[:focus-visible]:outline-2", "has-[:focus-visible]:outline-offset-2", "has-[:focus-visible]:outline-ink"]) expect(card.className).toContain(c);
      expect(r.parentElement).toBe(card);                                                // sin ancestro intermedio que lo posicione
    }
  });

  it("el foco con teclado cae en el radio de la tarjeta correcta, y las flechas lo mueven con la selección", async () => {
    const { user, dlg, grupo } = await abrir();
    const [a, b] = within(grupo).getAllByRole("radio") as HTMLInputElement[];
    // desde la pestaña seleccionada, Tab lleva al radio marcado (única parada del grupo)
    within(dlg).getByRole("tab", { name: "Con fotos" }).focus();
    await user.tab();
    expect(a).toHaveFocus();
    expect(a!.closest("label")!.className).toContain("has-[:focus-visible]:outline-2");
    await user.keyboard("{ArrowRight}");
    expect(b).toHaveFocus(); expect(b!.checked).toBe(true); expect(a!.checked).toBe(false);
    await user.keyboard("{ArrowRight}");                                                 // vuelta
    expect(a).toHaveFocus(); expect(a!.checked).toBe(true);
  });

  it("el estado seleccionado conserva su apariencia (borde y fondo) y el no seleccionado el suyo", async () => {
    const { user, grupo } = await abrir();
    const [a, b] = within(grupo).getAllByRole("radio") as HTMLInputElement[];
    expect(a!.closest("label")!.className).toContain("border-ink bg-linen");
    expect(b!.closest("label")!.className).toContain("border-control");
    await user.click(b!);
    expect(b!.closest("label")!.className).toContain("border-ink bg-linen");
    expect(a!.closest("label")!.className).toContain("border-control");
  });
});
