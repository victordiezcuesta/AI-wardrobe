import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui";
import { ItemCard } from "@/features/wardrobe/components/item-card";
import { History } from "@/features/virtual-try-on/components/history";
import type { ItemDTO } from "@/features/wardrobe/types";
import type { TryOnDTO } from "@/features/virtual-try-on/types";

/** H.8.2 y H.8.3 — nombres accesibles de `item-card` y del historial del probador. LIMITACIÓN: no sustituye una prueba con lector de pantalla. */
const item = (o: Partial<ItemDTO> = {}): ItemDTO => ({
  id: "i1", name: "Chaqueta", category: "COAT", subcategory: null, description: null, primaryColor: null, secondaryColors: [], pattern: null, material: null,
  style: [], seasons: [], formality: null, occasions: [], imageUrl: null, thumbUrl: null, needsReview: false, aiConfidence: null, isFavorite: false,
  status: "AVAILABLE", createdAt: "2026-01-01T00:00:00.000Z", ...o,
});

describe("H.8.2 — item-card", () => {
  const renderCard = (o: Partial<ItemDTO> = {}, toggle = vi.fn()) => render(<ItemCard item={item(o)} onOpen={() => undefined} onToggleFavorite={toggle} />);

  it("una prenda disponible y sin revisión se llama «Abrir {nombre}»", () => {
    renderCard();
    expect(screen.getByRole("button", { name: "Abrir Chaqueta" })).toBeInTheDocument();
  });

  it("el nombre incluye el estado cuando no está disponible", () => {
    renderCard({ status: "UNAVAILABLE" });
    expect(screen.getByRole("button", { name: "Abrir Chaqueta, No disponible" })).toBeInTheDocument();
  });

  it("el nombre incluye «Revisar» cuando necesita revisión, y estado y revisión a la vez", () => {
    renderCard({ needsReview: true });
    expect(screen.getByRole("button", { name: "Abrir Chaqueta, Revisar" })).toBeInTheDocument();
  });

  it("estado y revisión a la vez aparecen los dos, en ese orden", () => {
    renderCard({ status: "DIRTY", needsReview: true });
    expect(screen.getByRole("button", { name: "Abrir Chaqueta, Sucia, Revisar" })).toBeInTheDocument();
  });

  it("el botón de favorito tiene un nombre FIJO que identifica la prenda y expresa el estado solo con aria-pressed", async () => {
    const user = userEvent.setup();
    const toggle = vi.fn();
    const { rerender } = renderCard({ isFavorite: false }, toggle);
    const fav = screen.getByRole("button", { name: "Favorita: Chaqueta" });
    expect(fav).toHaveAttribute("aria-pressed", "false");
    await user.click(fav);
    expect(toggle).toHaveBeenCalledTimes(1);
    rerender(<ItemCard item={item({ isFavorite: true })} onOpen={() => undefined} onToggleFavorite={toggle} />);
    const after = screen.getByRole("button", { name: "Favorita: Chaqueta" });   // el nombre no cambia
    expect(after).toHaveAttribute("aria-pressed", "true");
  });

  it("dos prendas distintas tienen nombres de favorito distintos", () => {
    render(<><ItemCard item={item({ id: "a", name: "Camisa" })} onOpen={() => undefined} onToggleFavorite={() => undefined} /><ItemCard item={item({ id: "b", name: "Jersey" })} onOpen={() => undefined} onToggleFavorite={() => undefined} /></>);
    expect(screen.getByRole("button", { name: "Favorita: Camisa" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Favorita: Jersey" })).toBeInTheDocument();
  });
});

describe("H.8.3 — historial del probador", () => {
  const img = (id: string): TryOnDTO => ({ id, status: "COMPLETED", scenario: "studio", pose: "standing", outfitId: null, errorMessage: null, attempts: 1, isFavorite: false,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", imageUrl: `https://example.test/${id}.jpg`, downloadUrl: `https://example.test/${id}/dl` });

  it("con imágenes del mismo escenario y pose, los botones de abrir y de favorita tienen nombres únicos con su posición", () => {
    render(<ToastProvider><History images={[img("a"), img("b"), img("c")]} hasMore={false} loadingMore={false} onMore={() => undefined} onChange={() => undefined} onRemove={() => undefined} /></ToastProvider>);
    const names = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(names.filter((n) => n?.startsWith("Abrir imagen"))).toHaveLength(3);
    expect(names.filter((n) => n?.startsWith("Favorita"))).toHaveLength(3);
    expect(new Set(names).size).toBe(names.length);
    expect(screen.getByRole("button", { name: /^Abrir imagen 2 de 3:/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Favorita: imagen 3 de 3" })).toHaveAttribute("aria-pressed", "false");
  });

  it("las miniaturas son decorativas (alt vacío): el nombre del botón ya las identifica", () => {
    const { container } = render(<ToastProvider><History images={[img("a"), img("b")]} hasMore={false} loadingMore={false} onMore={() => undefined} onChange={() => undefined} onRemove={() => undefined} /></ToastProvider>);
    for (const i of container.querySelectorAll("img")) expect(i).toHaveAttribute("alt", "");
  });
});
