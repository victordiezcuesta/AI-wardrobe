import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui";
import { ANNOUNCE_DELAY_MS, ShoppingView } from "@/features/shopping/components/shopping-view";
import { WardrobeView } from "@/features/wardrobe/components/wardrobe-view";

/**
 * H.8.4 y H.8.5 (parcial) — enlaces de compra y anuncio de resultados de la vista del armario, con `fetch` simulado.
 * LIMITACIÓN: jsdom no es un lector de pantalla; qué se anuncia de verdad y cuándo (NVDA/VoiceOver) se comprueba a mano.
 */
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

describe("H.8.4 — shopping-view: un único enlace accesible por producto", () => {
  const product = { id: "p1", name: "Camisa lino", brand: "Marca", store: "Tienda", priceCents: 3990, currency: "EUR", color: "blanco", imageUrl: "https://example.test/p.jpg",
    url: "https://example.test/buy", matchReason: null, combinesWith: [], score: 1 };
  const batch = { batchId: "b1", createdAt: "2026-01-01T00:00:00.000Z", fromCache: false, gaps: [{ id: "g1", label: "Una camisa", reason: "Te falta", category: "SHIRT", color: null, aiRanked: true, status: "found", combinesWith: [], products: [product] }] };
  const setup = () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url).includes("status") ? json({ configured: true, products: 1, stores: [], lastSyncAt: null }) : json({ batch })));
    render(<ToastProvider><ShoppingView /></ToastProvider>);
  };

  it("hay un solo enlace en el árbol accesible con nombre «Ver en Tienda: Camisa lino (se abre en una pestaña nueva)»", async () => {
    setup();
    await screen.findByText("Una camisa");
    const links = screen.getAllByRole("link", { name: /Camisa lino/ });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAccessibleName("Ver en Tienda: Camisa lino (se abre en una pestaña nueva)");
    expect(links[0]).toHaveAttribute("href", "https://example.test/buy");
    expect(links[0]).toHaveAttribute("target", "_blank");
    expect(links[0]).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("el enlace de la imagen sigue existiendo para el ratón, con el mismo destino, pero fuera del orden de Tab y del árbol accesible", async () => {
    setup();
    await screen.findByText("Una camisa");
    const all = document.querySelectorAll<HTMLAnchorElement>("a[href='https://example.test/buy']");
    expect(all).toHaveLength(2);
    const imageLink = [...all].find((a) => a.getAttribute("aria-hidden") === "true")!;
    expect(imageLink).toHaveAttribute("tabindex", "-1");
    expect(imageLink.querySelector("img")).toHaveAttribute("alt", "");
    expect(screen.getAllByRole("link").filter((l) => l.getAttribute("href") === "https://example.test/buy")).toHaveLength(1);
  });
});

describe("H8-01 y H8-06 — shopping-view: el estado sigue accesible y los filtros anuncian el resultado", () => {
  const mk = (id: string, store: string, cents: number) => ({ id, name: `Camisa ${id}`, brand: "Marca", store, priceCents: cents, currency: "EUR", color: "blanco", imageUrl: null,
    url: `https://example.test/${id}`, matchReason: null, combinesWith: [], score: 1 });
  const batch = { batchId: "b1", createdAt: "2026-01-01T00:00:00.000Z", fromCache: false, gaps: [{ id: "g1", label: "Una camisa", reason: "Te falta", category: "SHIRT", color: null, aiRanked: true, status: "found", combinesWith: [],
    products: [mk("a", "Tienda A", 1000), mk("b", "Tienda B", 5000)] }] };
  const setup = () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url).includes("status") ? json({ configured: true, products: 2, stores: [], lastSyncAt: null }) : json({ batch })));
    render(<ToastProvider><ShoppingView /></ToastProvider>);
  };
  const live = () => screen.getAllByRole("status").find((s) => s.classList.contains("sr-only"))!;

  it("H8-01 — «Producto encontrado» NO está dentro de ningún elemento aria-hidden (sigue en el árbol accesible) y no captura el puntero", async () => {
    setup();
    await screen.findByText("Una camisa");
    const badges = screen.getAllByText("Producto encontrado").filter((b) => b.closest("li"));   // los de las tarjetas de producto (el de la cabecera del hueco no)
    expect(badges).toHaveLength(2);
    for (const b of badges) {
      expect(b.closest("[aria-hidden='true']")).toBeNull();
      expect(b.closest("[inert]")).toBeNull();
      expect(b.parentElement!.className).toContain("pointer-events-none");        // el clic sobre la imagen sigue llegando al enlace
    }
    expect(screen.getAllByRole("link").filter((l) => /Ver en/.test(l.textContent ?? ""))).toHaveLength(2);
  });

  it("H8-06 — sin filtrar la región está vacía; tienda y marca anuncian al instante el recuento", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("Una camisa");
    expect(live()).toBeEmptyDOMElement();
    await user.selectOptions(screen.getByRole("combobox", { name: "Tienda" }), "Tienda A");
    expect(live()).toHaveTextContent("1 producto");
    await user.selectOptions(screen.getByRole("combobox", { name: "Tienda" }), "");
    expect(live()).toHaveTextContent("2 productos");
  });

  /** Corrección B — el precio máximo no anuncia cada pulsación. Se registran TODOS los textos que toma la región (MutationObserver), no solo el final. */
  describe("precio máximo: anuncio con debounce", () => {
    const watch = () => {
      const seen: string[] = [];
      const obs = new MutationObserver(() => { const t = live().textContent ?? ""; if (seen[seen.length - 1] !== t) seen.push(t); });
      obs.observe(live(), { childList: true, characterData: true, subtree: true });
      return { seen, stop: () => obs.disconnect() };
    };
    const ready = async () => {
      setup();
      await screen.findByText("Una camisa");
      vi.useFakeTimers({ shouldAdvanceTime: true });          // el reloj avanza también solo (user-event espera entre acciones); los límites usan margen
      return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    };
    const links = () => screen.queryAllByRole("link", { name: /Ver en/ }).length;
    const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

    it("escribir «100» no anuncia «1» ni «10» por el camino: solo, tras la pausa, el recuento del último valor (2 productos)", async () => {
      const user = await ready();
      const w = watch();
      await user.type(screen.getByLabelText("Precio máximo (€)"), "100");
      await tick(ANNOUNCE_DELAY_MS - 200);
      expect(live()).toBeEmptyDOMElement();                                  // aún sin anunciar
      await tick(400);
      expect(live()).toHaveTextContent("2 productos");
      expect(w.seen).toEqual(["2 productos"]);                               // ningún «0 productos» (1 €) ni «1 producto» (10 €) intermedios
      w.stop();
    });

    it("el filtrado VISUAL es inmediato aunque el anuncio espere: tras teclear «1» (1 €) ya no hay productos visibles, y la región sigue vacía", async () => {
      const user = await ready();
      expect(links()).toBe(2);
      await user.type(screen.getByLabelText("Precio máximo (€)"), "1");
      expect(links()).toBe(0);
      expect(live()).toBeEmptyDOMElement();
      await tick(ANNOUNCE_DELAY_MS);
      expect(live()).toHaveTextContent("0 productos");
    });

    it("cambios rápidos: cada pulsación reinicia la espera y el anuncio refleja SIEMPRE el último valor (nunca uno obsoleto)", async () => {
      const user = await ready();
      const w = watch();
      const input = screen.getByLabelText("Precio máximo (€)");
      await user.type(input, "20");                                          // 20 € → 1 producto
      await tick(300);
      await user.type(input, "{Backspace}{Backspace}60");                    // se corrige a 60 € → 2 productos, antes de que expire la primera espera
      await tick(ANNOUNCE_DELAY_MS - 200);
      expect(live()).toBeEmptyDOMElement();
      await tick(400);
      expect(live()).toHaveTextContent("2 productos");
      expect(w.seen).toEqual(["2 productos"]);
      w.stop();
    });

    it("al salir del campo se anuncia al momento, sin esperar", async () => {
      const user = await ready();
      await user.type(screen.getByLabelText("Precio máximo (€)"), "20");
      expect(live()).toBeEmptyDOMElement();
      await user.tab();                                                      // blur
      expect(live()).toHaveTextContent("1 producto");
      await tick(ANNOUNCE_DELAY_MS * 2);
      expect(live()).toHaveTextContent("1 producto");                        // y el temporizador pendiente no lo vuelve a anunciar
    });

    it("cambiar la tienda con un precio a medio teclear anuncia con ESE precio (combinación vigente), no con uno anterior", async () => {
      const user = await ready();
      await user.type(screen.getByLabelText("Precio máximo (€)"), "20");     // pendiente (el campo mantiene el foco)
      fireEvent.change(screen.getByRole("combobox", { name: "Tienda" }), { target: { value: "Tienda B" } });   // sin blur: B cuesta 50 €, con tope de 20 €
      expect(live()).toHaveTextContent("0 productos");
    });

    it("una vez anunciado un recuento, seguir tecleando no lo cambia hasta que pasa la espera (el anuncio no se adelanta al valor tecleado)", async () => {
      const user = await ready();
      const input = screen.getByLabelText("Precio máximo (€)");
      await user.type(input, "20");
      await user.tab();
      expect(live()).toHaveTextContent("1 producto");                        // 20 € → solo la de 10 €
      input.focus();
      await user.type(input, "0");                                           // 200 € → serían 2 productos, pero aún no se anuncia
      expect(live()).toHaveTextContent("1 producto");
      await tick(ANNOUNCE_DELAY_MS + 100);
      expect(live()).toHaveTextContent("2 productos");
    });

    it("limpieza: desmontar con la espera pendiente no deja temporizadores ni actualiza el estado", async () => {
      const user = await ready();
      const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
      await user.type(screen.getByLabelText("Precio máximo (€)"), "20");
      const before = vi.getTimerCount();
      expect(before).toBeGreaterThan(0);
      cleanup();
      expect(vi.getTimerCount()).toBeLessThan(before);
      expect(vi.getTimerCount()).toBe(0);
      await tick(ANNOUNCE_DELAY_MS * 2);
      expect(err).not.toHaveBeenCalled();
    });
  });
});

describe("H.8.2/H.8.5 — wardrobe-view: lista semántica y resultado anunciado", () => {
  const it1 = (id: string, name: string) => ({ id, name, category: "COAT", subcategory: null, description: null, primaryColor: null, secondaryColors: [], pattern: null, material: null,
    style: [], seasons: [], formality: null, occasions: [], imageUrl: null, thumbUrl: null, needsReview: false, aiConfidence: null, isFavorite: false, status: "AVAILABLE", createdAt: "2026-01-01T00:00:00.000Z" });
  const stub = (items: unknown[], nextCursor: string | null = null) => vi.stubGlobal("fetch", vi.fn(async () => json({ items, nextCursor })));
  const results = () => screen.getAllByRole("status").find((s) => s.classList.contains("sr-only"))!;

  it("las prendas forman una lista (ul/li)", async () => {
    stub([it1("a", "Camisa"), it1("b", "Jersey")]);
    render(<ToastProvider><WardrobeView /></ToastProvider>);
    const list = await screen.findByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  });

  it("H8-05 — la carga inicial NO anuncia el recuento; al buscar o filtrar sí (2 prendas, singular, «hay más» y sin resultados)", async () => {
    const user = userEvent.setup();
    stub([it1("a", "Camisa"), it1("b", "Jersey")]);
    render(<ToastProvider><WardrobeView /></ToastProvider>);
    await screen.findByRole("list");
    expect(results()).toBeEmptyDOMElement();
    await user.type(screen.getByRole("searchbox", { name: "Buscar por nombre" }), "a");
    await waitFor(() => expect(results()).toHaveTextContent("2 prendas"), { timeout: 3000 });
    stub([it1("a", "Camisa")], "next");
    await user.type(screen.getByRole("searchbox", { name: "Buscar por nombre" }), "b");
    await waitFor(() => expect(results()).toHaveTextContent("1 prenda, hay más por cargar"), { timeout: 3000 });
    stub([]);
    await user.click(screen.getByRole("button", { name: "Favoritas" }));
    await waitFor(() => expect(results()).toHaveTextContent("Ninguna prenda con estos filtros"), { timeout: 3000 });
  });

  it("mientras carga la región está vacía (no se anuncia nada durante la carga)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    render(<ToastProvider><WardrobeView /></ToastProvider>);
    expect(results()).toBeEmptyDOMElement();
  });
});
