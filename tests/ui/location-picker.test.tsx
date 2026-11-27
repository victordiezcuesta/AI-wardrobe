import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { ToastProvider } from "@/components/ui";
import { LocationPicker } from "@/features/stylist/components/location-picker";
import { findBlocks, parseCss } from "../helpers/css";

/**
 * G9-04 — las sugerencias de lugar llenan una lista con `overflow-hidden` (esquinas redondeadas): el contorno global de foco (fuera de la caja) se recortaría.
 * En esos botones se dibuja hacia DENTRO. LIMITACIÓN: jsdom no hace layout ni calcula el recorte real; se comprueban estructura, clases y la cascada del CSS.
 */
afterEach(() => vi.unstubAllGlobals());
const cities = [{ name: "Madrid", region: "Comunidad de Madrid", country: "España", latitude: 40.4, longitude: -3.7 }, { name: "Madridejos", region: "Toledo", country: "España", latitude: 39.4, longitude: -3.5 }];

async function withResults() {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ cities }), { status: 200, headers: { "Content-Type": "application/json" } })));
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(<ToastProvider><LocationPicker value={null} onChange={onChange} /></ToastProvider>);
  await user.type(screen.getByRole("textbox", { name: "Lugar" }), "Mad");
  const list = (await screen.findByText("Madrid, Comunidad de Madrid, España", {}, { timeout: 3000 })).closest("ul")!;
  return { user, list, onChange };
}

describe("G9-04 — sugerencias de lugar", () => {
  it("la lista conserva el recorte redondeado y cada botón dibuja su contorno de foco hacia dentro (-outline-offset-2, con `!`)", async () => {
    const { list } = await withResults();
    expect(list.className).toContain("overflow-hidden");
    expect(list.className).toContain("rounded-field");
    const buttons = within(list).getAllByRole("button");
    expect(buttons).toHaveLength(2);
    for (const b of buttons) {
      expect(b.className).toContain("focus-visible:-outline-offset-2!");
      expect(b.className).toContain("w-full");                                           // llenan la lista: por eso el contorno exterior se recortaría
    }
  });

  it("el `!` es necesario: el estilo global de foco NO está en ninguna capa y, por eso, gana a las utilidades sin importante", () => {
    const css = parseCss(readFileSync("src/app/globals.css", "utf8"));
    expect(css.children.some((b) => b.prelude === ":focus-visible" && b.decls["outline-offset"] === "2px")).toBe(true);   // al nivel superior (sin capa)
    expect(findBlocks(css, (p) => p.startsWith("@layer")).flatMap((l) => l.children).some((b) => b.prelude === ":focus-visible")).toBe(false);
  });

  it("el comportamiento no cambia: con teclado se llega a las sugerencias, se enfocan y Enter elige el lugar", async () => {
    const { user, list, onChange } = await withResults();
    const [first] = within(list).getAllByRole("button");
    await user.tab();                                                                    // del campo hacia la primera sugerencia
    expect(first).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith({ name: "Madrid, Comunidad de Madrid, España", latitude: 40.4, longitude: -3.7 });
    await waitFor(() => expect(screen.queryByText("Madridejos, Toledo, España")).not.toBeInTheDocument());
  });
});
