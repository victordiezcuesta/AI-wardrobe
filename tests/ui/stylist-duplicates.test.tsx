import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui";
import { StylistView } from "@/features/stylist/components/stylist-view";

/**
 * O-6 — integración en `StylistView` con el `OutfitCard` REAL: qué conjuntos reciben el disambiguador. Solo los que comparten nombre con OTRO conjunto distinto (por `id`)
 * entre los dos listados; el resto conserva su nombre. LIMITACIÓN: jsdom no es un lector de pantalla.
 */
vi.mock("@/features/stylist/components/stylist-form", () => ({
  StylistForm: ({ onSubmit }: { onSubmit: (v: unknown) => void }) => <button type="button" onClick={() => onSubmit({ occasion: "cena" })}>Generar conjuntos</button>,
}));
beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => vi.unstubAllGlobals());

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
const outfit = (id: string, name: string) => ({ id, name, description: "", occasion: null, reasoning: null, colorNotes: null, weatherNotes: null, styleFit: null, location: null,
  isFavorite: false, discarded: false, rating: null, createdAt: "2026-01-01T00:00:00.000Z", items: [] });

function setup(history: ReturnType<typeof outfit>[], generated: ReturnType<typeof outfit>[] = []) {
  vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => (init?.method === "POST" ? json({ outfits: generated, alternativeItems: {}, warning: null }) : json({ outfits: history, alternativeItems: {} }))));
  render(<ToastProvider><StylistView /></ToastProvider>);
}
const articleNames = () => screen.getAllByRole("article").map((a) => a.getAttribute("aria-labelledby")).map((id) => document.getElementById(id!)!.textContent);
const allActionNames = () => [...screen.getAllByRole("button"), ...screen.getAllByRole("link")].map((e) => e.getAttribute("aria-label") ?? e.textContent);

describe("O-6 — StylistView con nombres de conjunto repetidos", () => {
  it("dos conjuntos del historial con el mismo nombre se distinguen por su posición; el de nombre único no cambia", async () => {
    setup([outfit("h1", "Look casual"), outfit("h2", "Look casual"), outfit("h3", "Oficina")]);
    await screen.findAllByRole("article");
    expect(articleNames()).toEqual(["Look casual (del historial 1 de 3)", "Look casual (del historial 2 de 3)", "Oficina"]);
    expect(screen.getByRole("button", { name: "Me gusta: Look casual (del historial 2 de 3)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Me gusta: Oficina" })).toBeInTheDocument();
  });

  it("tras generar, un conjunto nuevo con el nombre de uno del historial se distingue de él (listas distintas) y todos los nombres de acción son únicos", async () => {
    const user = userEvent.setup();
    setup([outfit("h1", "Look casual"), outfit("h2", "Oficina")], [outfit("g1", "Look casual")]);
    await screen.findAllByRole("article");
    expect(articleNames()).toEqual(["Look casual", "Oficina"]);                       // sin repetidos todavía: nombres sin cambios
    await user.click(screen.getByRole("button", { name: "Generar conjuntos" }));
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(3));
    expect(articleNames()).toEqual(expect.arrayContaining(["Look casual (conjunto nuevo 1 de 1)", "Look casual (del historial 1 de 2)", "Oficina"]));
    const names = allActionNames();
    expect(new Set(names).size).toBe(names.length);
  });

  it("el MISMO conjunto en las dos listas (mismo id) no se considera duplicado por sí solo: conserva su nombre", async () => {
    const user = userEvent.setup();
    setup([outfit("o1", "Look casual")], [outfit("o1", "Look casual")]);
    await screen.findAllByRole("article");
    await user.click(screen.getByRole("button", { name: "Generar conjuntos" }));
    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2));
    expect(articleNames()).toEqual(["Look casual", "Look casual"]);
  });

  it("la comparación ignora mayúsculas y espacios de los extremos", async () => {
    setup([outfit("h1", "Look Casual"), outfit("h2", "  look casual ")]);
    await screen.findAllByRole("article");
    expect(articleNames()).toEqual(["Look Casual (del historial 1 de 2)", "  look casual  (del historial 2 de 2)"]);
  });
});
