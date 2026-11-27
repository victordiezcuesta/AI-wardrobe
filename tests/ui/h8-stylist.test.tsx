import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui";
import { GENERATING_ANNOUNCEMENT, StylistView } from "@/features/stylist/components/stylist-view";

/**
 * H.8.5 — `stylist-view`: región de estado siempre montada (generación) y resultado del historial anunciado, y lista semántica de conjuntos.
 * El flujo de generación se prueba con el formulario sustituido por un botón (H8-04). LIMITACIÓN: jsdom no es un lector de pantalla; que el progreso y el
 * resultado se ANUNCIEN de verdad (y no se repitan) requiere comprobación manual con NVDA/VoiceOver.
 */
// El formulario real exige lugar, fecha y varios campos; aquí solo interesa lo que ocurre al ENVIARLO, así que se sustituye por un botón que envía unos valores.
vi.mock("@/features/stylist/components/stylist-form", () => ({
  StylistForm: ({ onSubmit }: { onSubmit: (v: unknown) => void }) => <button type="button" onClick={() => onSubmit({ occasion: "cena" })}>Generar conjuntos</button>,
}));
// La tarjeta real tiene mucha lógica propia (alternativas, valoraciones…); aquí solo importan las dos acciones que cambian el HISTORIAL: descartar y quitar el favorito.
vi.mock("@/features/stylist/components/outfit-card", () => ({
  OutfitCard: ({ outfit, onDiscard, onChange }: { outfit: { id: string; name: string }; onDiscard: (id: string) => void; onChange: (o: unknown, a: unknown) => void }) => (
    <div>
      <span>{outfit.name}</span>
      <button type="button" onClick={() => onDiscard(outfit.id)}>Descartar {outfit.name}</button>
      <button type="button" onClick={() => onChange({ ...outfit, isFavorite: false }, {})}>Quitar favorito {outfit.name}</button>
    </div>
  ),
}));
beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => vi.unstubAllGlobals());
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const outfit = (id: string, name: string) => ({ id, name, description: "", occasion: null, reasoning: null, colorNotes: null, isFavorite: false, createdAt: "2026-01-01T00:00:00.000Z", items: [] });
const live = () => screen.getAllByRole("status").filter((s) => s.classList.contains("sr-only"));

function setup(byScope: Record<string, unknown[]>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const scope = /scope=(\w+)/.exec(String(url))?.[1] ?? "recent";
    return json({ outfits: byScope[scope] ?? [], alternativeItems: {} });
  }));
  render(<ToastProvider><StylistView /></ToastProvider>);
}

describe("stylist-view — accesibilidad de listas y resultados", () => {
  it("hay una región de estado de generación SIEMPRE montada y vacía mientras no se genera (antes, el aria-live solo existía durante la generación)", async () => {
    setup({ recent: [outfit("o1", "Look A")] });
    await screen.findByText("Look A");
    expect(live().length).toBeGreaterThanOrEqual(2);
    expect(live().some((s) => s.textContent === "")).toBe(true);
  });

  it("el historial es una lista (ul/li) y la carga inicial NO lo anuncia", async () => {
    setup({ recent: [outfit("o1", "Look A"), outfit("o2", "Look B")] });
    await screen.findByText("Look A");
    const lists = screen.getAllByRole("list");
    expect(lists.some((l) => within(l).queryAllByRole("listitem").length === 2)).toBe(true);
    for (const r of live()) expect(r).toBeEmptyDOMElement();
  });

  it("al cambiar el filtro (acción del usuario) se anuncia el resultado del nuevo ámbito, con y sin resultados", async () => {
    const user = userEvent.setup();
    setup({ recent: [outfit("o1", "Look A")], favorites: [] });
    await screen.findByText("Look A");
    await user.click(screen.getByRole("button", { name: "Favoritos" }));
    await waitFor(() => expect(live().map((s) => s.textContent)).toContain("Ningún conjunto favorito"));
    await user.click(screen.getByRole("button", { name: "Recientes" }));
    await waitFor(() => expect(live().map((s) => s.textContent)).toContain("1 conjunto"));
  });

  it("descartar un conjunto (acción independiente que cambia el historial) anuncia el nuevo recuento", async () => {
    const user = userEvent.setup();
    setup({ recent: [outfit("o1", "Look A"), outfit("o2", "Look B")] });
    await screen.findByText("Look A");
    await user.click(screen.getByRole("button", { name: "Descartar Look A" }));
    await waitFor(() => expect(live().map((s) => s.textContent)).toContain("1 conjunto"));
  });

  it("mientras carga el historial la región está vacía (no anuncia «cargando» ni resultados intermedios)", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    render(<ToastProvider><StylistView /></ToastProvider>);
    for (const s of live()) expect(s).toBeEmptyDOMElement();
  });
});

describe("H8-04 — flujo de generación: progreso y resultado", () => {
  const gen = (n: number) => ({ outfits: Array.from({ length: n }, (_, i) => outfit(`g${i}`, `Nuevo ${i + 1}`)), alternativeItems: {}, warning: null });
  function setupGen(post: () => Promise<Response>) {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => (init?.method === "POST" ? post() : json({ outfits: [], alternativeItems: {} }))));
    render(<ToastProvider><StylistView /></ToastProvider>);
  }

  it("al generar: la región ya montada anuncia el inicio, luego «N conjuntos listos»; los resultados forman una lista y no hay aria-live condicional", async () => {
    const user = userEvent.setup();
    let resolve!: (r: Response) => void;
    setupGen(() => new Promise<Response>((r) => { resolve = r; }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Generar conjuntos" })).toBeInTheDocument());
    const region = live().find((s) => s.textContent === "")!;                         // la región de generación existe ANTES de generar
    await user.click(screen.getByRole("button", { name: "Generar conjuntos" }));
    await waitFor(() => expect(region).toHaveTextContent(GENERATING_ANNOUNCEMENT));
    expect(region.isConnected).toBe(true);                                             // es la MISMA región (no se remonta)
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(1);                  // solo la de los avisos: ya no hay un aria-live que aparezca con la carga
    await act(async () => { resolve(json(gen(2))); });
    await waitFor(() => expect(region).toHaveTextContent("2 conjuntos listos"));
    const list = (await screen.findByRole("heading", { name: "Tus conjuntos" })).closest("section")!.querySelector("ul")!;
    expect(within(list as HTMLElement).getAllByRole("listitem")).toHaveLength(2);
  });

  /** Corrección C — textos que toman las regiones de estado durante todo el flujo (MutationObserver): no solo el estado final. */
  const trace = () => {
    const seen = new Map<Element, string[]>();
    const obs = new MutationObserver(() => { for (const r of live()) { const a = seen.get(r) ?? []; if (a[a.length - 1] !== r.textContent) a.push(r.textContent ?? ""); seen.set(r, a); } });
    for (const r of live()) { seen.set(r, [r.textContent ?? ""]); obs.observe(r, { childList: true, characterData: true, subtree: true }); }
    return { seen, stop: () => obs.disconnect() };
  };

  it("C — tras generar, la recarga del historial NO produce un segundo anuncio: la región del historial no recibe texto en todo el flujo", async () => {
    const user = userEvent.setup();
    let gets = 0; let resolve!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => {
      if (init?.method === "POST") return new Promise<Response>((r) => { resolve = r; });
      gets++;
      return json({ outfits: gets === 1 ? [outfit("h1", "Previo")] : [outfit("g0", "Nuevo 1"), outfit("g1", "Nuevo 2"), outfit("h1", "Previo")], alternativeItems: {} });
    }));
    render(<ToastProvider><StylistView /></ToastProvider>);
    await screen.findByText("Previo");
    await user.click(screen.getByRole("button", { name: "Generar conjuntos" }));
    const t = trace();
    await act(async () => { resolve(json(gen(2))); });
    await waitFor(() => expect(gets).toBe(2));                                  // la recarga del historial SÍ ocurrió
    await screen.findAllByText("Nuevo 1");
    const regions = live();
    const announcers = regions.filter((r) => t.seen.get(r)?.includes("2 conjuntos listos"));
    expect(announcers).toHaveLength(1);                                          // un único anuncio útil: el de la generación
    for (const r of regions.filter((x) => !announcers.includes(x))) expect(t.seen.get(r)!.filter((x) => x !== "")).toEqual([]);   // ninguna otra región recibió texto
    t.stop();
  });

  it("C — tras una generación, una acción independiente posterior sí se anuncia (sin repetir «N conjuntos listos»)", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async (u: string, init?: RequestInit) => (init?.method === "POST" ? json(gen(2)) : json({ outfits: String(u).includes("favorites") ? [] : [outfit("h1", "Previo")], alternativeItems: {} }))));
    render(<ToastProvider><StylistView /></ToastProvider>);
    await screen.findByText("Previo");
    await user.click(screen.getByRole("button", { name: "Generar conjuntos" }));
    await waitFor(() => expect(live().map((s) => s.textContent)).toContain("2 conjuntos listos"));
    await user.click(screen.getByRole("button", { name: "Favoritos" }));
    await waitFor(() => expect(live().map((s) => s.textContent)).toContain("Ningún conjunto favorito"));
  });

  it("C — con un anuncio previo del historial, generar lo limpia y la recarga no lo repite; después, quitar un favorito (acción del usuario) vuelve a anunciar", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async (u: string, init?: RequestInit) =>
      init?.method === "POST" ? json(gen(2)) : json({ outfits: String(u).includes("favorites") ? [outfit("f1", "Fav A"), outfit("f2", "Fav B")] : [outfit("h1", "Previo")], alternativeItems: {} })));
    render(<ToastProvider><StylistView /></ToastProvider>);
    await screen.findByText("Previo");
    await user.click(screen.getByRole("button", { name: "Favoritos" }));
    await screen.findByText("Fav A");
    await waitFor(() => expect(live().map((s) => s.textContent)).toContain("2 conjuntos"));
    const t = trace();
    await user.click(screen.getByRole("button", { name: "Generar conjuntos" }));
    await waitFor(() => expect(live().map((s) => s.textContent)).toContain("2 conjuntos listos"));
    const hist = live().find((r) => (t.seen.get(r) ?? []).includes("2 conjuntos"))!;
    await waitFor(() => expect(hist).toBeEmptyDOMElement());                     // generar limpia el anuncio anterior…
    const after = t.seen.get(hist)!.slice(t.seen.get(hist)!.lastIndexOf("2 conjuntos") + 1);
    expect(after.filter((x) => x !== "")).toEqual([]);                           // …y la recarga posterior no lo repite
    t.stop();
    await user.click(screen.getByRole("button", { name: "Quitar favorito Fav A" }));
    await waitFor(() => expect(live().map((s) => s.textContent)).toContain("1 conjunto"));
  });

  /** G9-02 — los pasos visuales cambian cada 2,5 s y NO se anuncian: la región toma el texto de inicio una sola vez y no vuelve a cambiar mientras se genera. */
  it("G9-02 — durante una generación larga la región no cambia (un solo anuncio de inicio) aunque los pasos visuales sigan rotando", async () => {
    const user = userEvent.setup();
    let resolve!: (r: Response) => void;
    setupGen(() => new Promise<Response>((r) => { resolve = r; }));
    await waitFor(() => screen.getByRole("button", { name: "Generar conjuntos" }));
    const region = live().find((s) => s.textContent === "")!;
    const seen: string[] = [];
    const obs = new MutationObserver(() => { const t = region.textContent ?? ""; if (seen.at(-1) !== t) seen.push(t); });
    obs.observe(region, { childList: true, characterData: true, subtree: true });
    await user.click(screen.getByRole("button", { name: "Generar conjuntos" }));
    await waitFor(() => expect(region).toHaveTextContent(GENERATING_ANNOUNCEMENT));
    const visible = () => screen.getByText(/…$/, { selector: "p.font-display" }).textContent;
    const first = visible();
    await waitFor(() => expect(visible()).not.toBe(first), { timeout: 4000 });          // el paso visible SÍ cambia (≈2,5 s)…
    expect(region).toHaveTextContent(GENERATING_ANNOUNCEMENT);                            // …y la región, no
    await act(async () => { resolve(json(gen(2))); });
    await waitFor(() => expect(region).toHaveTextContent("2 conjuntos listos"));
    expect(seen).toEqual([GENERATING_ANNOUNCEMENT, "2 conjuntos listos"]);               // exactamente dos anuncios en todo el flujo
    obs.disconnect();
  }, 12000);

  it("singular, y una nueva generación limpia el resultado anterior antes de anunciar el inicio", async () => {
    const user = userEvent.setup();
    let calls = 0; let resolve2!: (r: Response) => void;
    setupGen(() => (++calls === 1 ? Promise.resolve(json(gen(1))) : new Promise<Response>((r) => { resolve2 = r; })));
    await waitFor(() => screen.getByRole("button", { name: "Generar conjuntos" }));
    const region = live().find((s) => s.textContent === "")!;
    await user.click(screen.getByRole("button", { name: "Generar conjuntos" }));
    await waitFor(() => expect(region).toHaveTextContent("1 conjunto listo"));
    await user.click(screen.getByRole("button", { name: "Generar conjuntos" }));
    await waitFor(() => expect(region).toHaveTextContent(GENERATING_ANNOUNCEMENT));
    await act(async () => { resolve2(json(gen(3))); });
    await waitFor(() => expect(region).toHaveTextContent("3 conjuntos listos"));
  });

  it("si la generación falla, la región queda vacía (el error lo comunica el aviso) y no anuncia un éxito", async () => {
    const user = userEvent.setup();
    setupGen(() => Promise.resolve(new Response(JSON.stringify({ error: { code: "X", message: "No se pudo" } }), { status: 500, headers: { "Content-Type": "application/json" } })));
    await waitFor(() => screen.getByRole("button", { name: "Generar conjuntos" }));
    const region = live().find((s) => s.textContent === "")!;
    await user.click(screen.getByRole("button", { name: "Generar conjuntos" }));
    await screen.findByText("No se pudo");
    expect(region).toBeEmptyDOMElement();
  });
});
