import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui";
import { OutfitCard } from "@/features/stylist/components/outfit-card";
import type { OutfitDTO } from "@/features/stylist/types";

/**
 * G9-05 — las acciones de cada conjunto se repiten con el mismo texto visible: el nombre accesible incluye el del conjunto (solo para tecnología de apoyo) y el
 * `article` se nombra con su encabezado. LIMITACIÓN: jsdom no es un lector de pantalla; cómo se lee en una lista de botones se comprueba con NVDA/Orca.
 */
afterEach(() => vi.unstubAllGlobals());
const outfit = (id: string, name: string): OutfitDTO => ({ id, name, description: "Descripción", occasion: "Cena", reasoning: null, colorNotes: null, weatherNotes: null, styleFit: null, location: null,
  isFavorite: false, discarded: false, rating: null, createdAt: "2026-01-01T00:00:00.000Z", items: [] });
const ACTIONS = ["Me lo pongo", "Me gusta", "No me convence", "Ver cómo me queda", "Descartar"] as const;
const two = () => render(<ToastProvider><OutfitCard outfit={outfit("a", "Look casual")} alternatives={{}} onChange={() => undefined} onDiscard={() => undefined} />
  <OutfitCard outfit={outfit("b", "Look de oficina")} alternatives={{}} onChange={() => undefined} onDiscard={() => undefined} /></ToastProvider>);
const actionsOf = (art: HTMLElement) => [...within(art).getAllByRole("button"), ...within(art).getAllByRole("link")].filter((e) => ACTIONS.some((a) => e.textContent?.startsWith(a)));

describe("G9-05 — nombres accesibles de las acciones del conjunto", () => {
  it("cada artículo se llama como el encabezado de su conjunto (aria-labelledby → h3)", () => {
    two();
    const a = screen.getByRole("article", { name: "Look casual" });
    expect(a).toHaveAttribute("aria-labelledby", within(a).getByRole("heading", { level: 3 }).id);
    expect(screen.getByRole("article", { name: "Look de oficina" })).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(2);
  });

  it("las cinco acciones tienen nombre distinto en cada conjunto: «Acción: Nombre»", () => {
    two();
    for (const name of ["Look casual", "Look de oficina"]) {
      for (const act of ACTIONS) expect(screen.getByRole(act === "Ver cómo me queda" ? "link" : "button", { name: `${act}: ${name}` })).toBeInTheDocument();
    }
    const names = [...screen.getAllByRole("button"), ...screen.getAllByRole("link")].map((e) => e.getAttribute("aria-label") ?? e.textContent);
    expect(new Set(names).size).toBe(names.length);                                       // ningún nombre se repite entre botones y enlaces
  });

  it("el texto VISIBLE no cambia y el nombre accesible empieza por él (2.5.3 Label in Name); el nombre del conjunto añadido solo es para tecnología de apoyo", () => {
    two();
    const art = screen.getByRole("article", { name: "Look casual" });
    for (const el of actionsOf(art)) {
      const visible = ACTIONS.find((a) => el.textContent?.startsWith(a))!;
      expect(el.textContent).toBe(`${visible}: Look casual`);
      const extra = el.querySelector(".sr-only")!;
      expect(extra).toHaveTextContent(": Look casual");
      expect(el.textContent!.replace(extra.textContent!, "")).toBe(visible);              // sin el span oculto queda exactamente el texto de siempre
    }
    expect(actionsOf(art)).toHaveLength(5);
  });

  it("el comportamiento de los controles no cambia: «Me gusta» envía el feedback del conjunto correcto, «Ver cómo me queda» enlaza a su conjunto", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ outfit: outfit("b", "Look de oficina"), alternativeItems: {} }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    two();
    expect(screen.getByRole("link", { name: "Ver cómo me queda: Look de oficina" })).toHaveAttribute("href", "/try-on?outfit=b");
    await user.click(screen.getByRole("button", { name: "Me gusta: Look de oficina" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/outfits/b/feedback");
    expect(JSON.parse(String(init.body))).toEqual({ type: "LIKE" });
  });

  it("el favorito y el resto del artículo no se alteran (sigue «Favorito: nombre» con aria-pressed)", () => {
    two();
    const art = screen.getByRole("article", { name: "Look casual" });
    expect(within(art).getByRole("button", { name: "Favorito: Look casual" })).toHaveAttribute("aria-pressed", "false");
  });
});

/** O-6 — conjuntos con el MISMO nombre: `distinguish` (posición en su lista, aportada por quien los lista) se añade solo para tecnología de apoyo. */
describe("O-6 — conjuntos con nombre idéntico", () => {
  const dup = () => render(<ToastProvider>
    <OutfitCard outfit={outfit("a", "Look casual")} alternatives={{}} onChange={() => undefined} onDiscard={() => undefined} distinguish="conjunto nuevo 1 de 2" />
    <OutfitCard outfit={outfit("b", "Look casual")} alternatives={{}} onChange={() => undefined} onDiscard={() => undefined} distinguish="conjunto nuevo 2 de 2" />
  </ToastProvider>);

  it("los dos artículos y sus encabezados tienen nombres accesibles distintos, y cada aria-labelledby apunta a un encabezado único existente", () => {
    const { container } = dup();
    const arts = screen.getAllByRole("article");
    expect(arts.map((a) => a.getAttribute("aria-labelledby"))).toHaveLength(2);
    expect(screen.getByRole("article", { name: "Look casual (conjunto nuevo 1 de 2)" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Look casual (conjunto nuevo 2 de 2)" })).toBeInTheDocument();
    const ids = arts.map((a) => a.getAttribute("aria-labelledby")!);
    expect(new Set(ids).size).toBe(2);                                                          // identificadores únicos
    for (const [i, id] of ids.entries()) expect(arts[i]!.querySelector(`h3[id="${CSS.escape(id)}"]`)).not.toBeNull();   // sin referencias rotas
    const allIds = [...container.querySelectorAll("[id]")].map((e) => e.id);
    expect(new Set(allIds).size).toBe(allIds.length);                                           // sin ids duplicados en la página
    expect(screen.getByRole("heading", { level: 3, name: "Look casual (conjunto nuevo 2 de 2)" })).toBeInTheDocument();
  });

  it("las cinco acciones y el favorito son distinguibles entre los dos conjuntos, y empiezan por el texto visible", () => {
    dup();
    for (const pos of ["conjunto nuevo 1 de 2", "conjunto nuevo 2 de 2"]) {
      for (const act of ACTIONS) expect(screen.getByRole(act === "Ver cómo me queda" ? "link" : "button", { name: `${act}: Look casual (${pos})` })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: `Favorito: Look casual (${pos})` })).toHaveAttribute("aria-pressed", "false");
    }
    const names = [...screen.getAllByRole("button"), ...screen.getAllByRole("link")].map((e) => e.getAttribute("aria-label") ?? e.textContent);
    expect(new Set(names).size).toBe(names.length);                                             // ningún nombre repetido en toda la página
    for (const el of [...screen.getAllByRole("button"), ...screen.getAllByRole("link")]) {
      const visible = ACTIONS.find((a) => el.textContent?.startsWith(a));
      if (visible) expect(el.textContent!.startsWith(visible)).toBe(true);
    }
  });

  it("el texto VISIBLE no cambia: sin el contenido solo para tecnología de apoyo queda el texto de siempre", () => {
    dup();
    const art = screen.getByRole("article", { name: "Look casual (conjunto nuevo 1 de 2)" });
    for (const el of actionsOf(art)) {
      const extra = el.querySelector(".sr-only")!;
      const visible = ACTIONS.find((a) => el.textContent?.startsWith(a))!;
      expect(el.textContent!.replace(extra.textContent!, "")).toBe(visible);
    }
    const h3 = within(art).getByRole("heading", { level: 3 });
    expect(h3.textContent!.replace(h3.querySelector(".sr-only")!.textContent!, "").trim()).toBe("Look casual");   // el espacio que separa no se ve (espacio final de un bloque)
  });

  it("sin `distinguish` (nombres únicos) no se añade nada: los nombres siguen siendo «Acción: Nombre»", () => {
    two();
    expect(screen.getByRole("article", { name: "Look casual" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Me gusta: Look casual" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Favorito: Look casual" })).toBeInTheDocument();
  });

  it("el comportamiento no cambia: cada «Me gusta» actúa sobre SU conjunto aunque se llamen igual", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ outfit: outfit("b", "Look casual"), alternativeItems: {} }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    dup();
    await user.click(screen.getByRole("button", { name: "Me gusta: Look casual (conjunto nuevo 2 de 2)" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("/api/outfits/b/feedback");
    expect(screen.getByRole("link", { name: "Ver cómo me queda: Look casual (conjunto nuevo 1 de 2)" })).toHaveAttribute("href", "/try-on?outfit=a");
  });
});
