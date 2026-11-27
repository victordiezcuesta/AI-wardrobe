import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui";
import { TRYON_ANNOUNCEMENTS, TryOnStudio } from "@/features/virtual-try-on/components/tryon-studio";
import type { TryOnDTO } from "@/features/virtual-try-on/types";

/**
 * G9-01 — anuncios del ciclo de una generación en `TryOnStudio`: región de estado persistente que anuncia inicio, reintento y final, SOLO en transiciones (el
 * sondeo repite el mismo estado cada 3 s). La tarjeta real se sustituye por botones que simulan lo que le llega por sondeo. LIMITACIÓN: jsdom no es un lector.
 */
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
const captured = vi.hoisted(() => new Map<string, (j: TryOnDTO) => void>());      // onUpdate de cada tarjeta, para simular respuestas de sondeo tardías o duplicadas
const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
vi.mock("@/features/virtual-try-on/components/job-card", () => ({
  JobCard: ({ job, onUpdate }: { job: TryOnDTO; onUpdate: (j: TryOnDTO) => void }) => {
    captured.set(job.id, onUpdate);
    return (
      <div data-job={job.id}>
        <span>Trabajo {job.status}</span>
        <button type="button" onClick={() => onUpdate({ ...job })}>Sondeo igual</button>
        <button type="button" onClick={() => onUpdate({ ...job, status: "PROCESSING", updatedAt: at(2) })}>Sondeo procesando</button>
        <button type="button" onClick={() => onUpdate({ ...job, status: "FAILED", updatedAt: at(10) })}>Falla</button>
        <button type="button" onClick={() => onUpdate({ ...job, status: "PENDING", updatedAt: at(20) })}>Reintenta</button>
        <button type="button" onClick={() => onUpdate({ ...job, status: "COMPLETED", updatedAt: at(30), imageUrl: "https://example.test/i.jpg", downloadUrl: "https://example.test/d" })}>Termina</button>
      </div>
    );
  },
}));
afterEach(() => { vi.unstubAllGlobals(); captured.clear(); });

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
const img = (status: TryOnDTO["status"], id = "n1"): TryOnDTO => ({ id, status, scenario: "studio", pose: "standing", outfitId: "o1", errorMessage: null, attempts: 1, isFavorite: false,
  createdAt: at(0), updatedAt: at(0), imageUrl: null, downloadUrl: null });
const outfit = { id: "o1", name: "Look A", description: "", occasion: null, reasoning: null, colorNotes: null, weatherNotes: null, styleFit: null, location: null, isFavorite: false, discarded: false, rating: null,
  createdAt: "2026-01-01T00:00:00.000Z", items: [] };

function setup(initialJobs: TryOnDTO[] = []) {
  captured.clear();
  let created = 0;                                                                  // cada POST crea un trabajo con id distinto: n1, n2…
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === "POST" && u.startsWith("/api/try-on")) return json({ image: img("PENDING", `n${++created}`) });
    if (u.startsWith("/api/consent")) return json({ granted: true, at: null, version: "1" });
    if (u.startsWith("/api/photos")) return json({ photos: [{ publicId: "p1", url: "https://example.test/p1.jpg" }] });
    if (u.startsWith("/api/outfits")) return json({ outfits: [outfit] });
    if (u.startsWith("/api/try-on")) return json({ images: initialJobs, nextCursor: null });
    return json({});
  }));
  render(<ToastProvider><TryOnStudio /></ToastProvider>);
}
const region = () => screen.getAllByRole("status").find((s) => s.classList.contains("sr-only") && s.textContent !== undefined && !s.closest("[data-dialog-companion]"))!;
const generate = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole("radio", { name: /Look A/ }));
  await user.click(screen.getByRole("button", { name: /Ver cómo me queda/ }));
};
const trace = () => {
  const seen: string[] = [];
  const r = region();
  seen.push(r.textContent ?? "");
  const obs = new MutationObserver(() => { const t = region().textContent ?? ""; if (seen.at(-1) !== t) seen.push(t); });
  obs.observe(r, { childList: true, characterData: true, subtree: true });
  return { seen, stop: () => obs.disconnect() };
};

describe("G9-01 — anuncios de la generación del probador", () => {
  it("sin generaciones, la región existe y está vacía; un trabajo pendiente al cargar la página NO se anuncia", async () => {
    setup([img("PROCESSING", "previo")]);
    await screen.findByText("Trabajo PROCESSING");
    expect(region()).toBeEmptyDOMElement();
  });

  it("al generar se anuncia el inicio; los sondeos con el mismo estado no cambian la región; al terminar se anuncia el final (una vez por transición)", async () => {
    const user = userEvent.setup();
    setup();
    await generate(user);
    const t = trace();
    await screen.findByText("Trabajo PENDING");
    await waitFor(() => expect(region()).toHaveTextContent(TRYON_ANNOUNCEMENTS.started));
    const poll = (name: string) => act(() => { fireEvent.click(screen.getByRole("button", { name })); });       // el sondeo llega sin interacción del usuario: sin user-event (más rápido)
    for (let i = 0; i < 4; i++) poll("Sondeo igual");                                                         // el sondeo repite el estado
    poll("Sondeo procesando");                                                                                // PENDING → PROCESSING: sigue generando, sin anuncio nuevo
    for (let i = 0; i < 3; i++) poll("Sondeo igual");
    expect(region()).toHaveTextContent(TRYON_ANNOUNCEMENTS.started);
    poll("Termina");
    await waitFor(() => expect(region()).toHaveTextContent(TRYON_ANNOUNCEMENTS.done));
    expect(t.seen.filter((x) => x !== "")).toEqual([TRYON_ANNOUNCEMENTS.started, TRYON_ANNOUNCEMENTS.done]);   // exactamente dos anuncios
    t.stop();
  });

  it("un fallo no anuncia éxito (lo comunica la tarjeta con su alert) y reintentar anuncia el reintento", async () => {
    const user = userEvent.setup();
    setup();
    await generate(user);
    await waitFor(() => expect(region()).toHaveTextContent(TRYON_ANNOUNCEMENTS.started));
    await user.click(screen.getByRole("button", { name: "Falla" }));
    expect(region()).toHaveTextContent(TRYON_ANNOUNCEMENTS.started);                                          // sin «lista» ni nada nuevo
    expect(region()).not.toHaveTextContent(TRYON_ANNOUNCEMENTS.done);
    await user.click(screen.getByRole("button", { name: "Reintenta" }));
    await waitFor(() => expect(region()).toHaveTextContent(TRYON_ANNOUNCEMENTS.retrying));
  });

  it("si la generación no se puede iniciar (error del servidor) no se anuncia inicio", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === "POST") return json({ error: { code: "X", message: "No se pudo" } }, 500);
      if (u.startsWith("/api/consent")) return json({ granted: true, at: null, version: "1" });
      if (u.startsWith("/api/photos")) return json({ photos: [{ publicId: "p1", url: "https://example.test/p1.jpg" }] });
      if (u.startsWith("/api/outfits")) return json({ outfits: [outfit] });
      return json({ images: [], nextCursor: null });
    }));
    render(<ToastProvider><TryOnStudio /></ToastProvider>);
    await generate(user);
    await screen.findByText("No se pudo");
    expect(region()).toBeEmptyDOMElement();
  });

  /** Cada anuncio es un NODO nuevo en la región: se observan las adiciones, no el texto final, porque dos anuncios idénticos seguidos no cambian el texto. */
  const additions = () => {
    const added: string[] = [];
    const take = (recs: MutationRecord[]) => { for (const r of recs) for (const n of r.addedNodes) if (n.nodeType === 1) added.push(n.textContent ?? ""); };
    const obs = new MutationObserver(take);
    obs.observe(region(), { childList: true });
    // Las devoluciones de llamada del observador son asíncronas: `read()` procesa los registros pendientes en el acto para poder comprobar justo después de cada acción.
    return { read: () => { take(obs.takeRecords()); return [...added]; }, stop: () => obs.disconnect() };
  };
  const card = (id: string) => document.querySelector<HTMLElement>(`[data-job="${id}"]`)!;
  const press = (id: string, name: string) => act(() => { fireEvent.click(within(card(id)).getByRole("button", { name })); });
  const startTwo = async (user: ReturnType<typeof userEvent.setup>) => {
    await generate(user);
    await waitFor(() => expect(card("n1")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: /Ver cómo me queda/ }));
    await waitFor(() => expect(card("n2")).toBeTruthy());
  };

  it("O-1 — dos trabajos DISTINTOS que terminan seguidos producen dos anuncios de final (el texto es idéntico, pero cada uno es un anuncio nuevo)", async () => {
    const user = userEvent.setup();
    setup();
    await generate(user);
    await waitFor(() => expect(card("n1")).toBeTruthy());
    const a = additions();
    await user.click(screen.getByRole("button", { name: /Ver cómo me queda/ }));
    await waitFor(() => expect(card("n2")).toBeTruthy());
    press("n1", "Termina");
    press("n2", "Termina");
    expect(a.read()).toEqual([TRYON_ANNOUNCEMENTS.started, TRYON_ANNOUNCEMENTS.done, TRYON_ANNOUNCEMENTS.done]);   // inicio del segundo, y los dos finales
    expect(region().childElementCount).toBe(1);                                                                  // la región no acumula: solo el último anuncio
    expect(region()).toHaveTextContent(TRYON_ANNOUNCEMENTS.done);
    a.stop();
  });

  it("O-1 — dos generaciones iniciadas seguidas también se anuncian las dos (inicio idéntico, nodos distintos)", async () => {
    const user = userEvent.setup();
    setup();
    await generate(user);
    await waitFor(() => expect(card("n1")).toBeTruthy());
    const a = additions();
    await user.click(screen.getByRole("button", { name: /Ver cómo me queda/ }));
    await waitFor(() => expect(card("n2")).toBeTruthy());
    expect(a.read()).toEqual([TRYON_ANNOUNCEMENTS.started]);
    a.stop();
  });

  it("el MISMO trabajo no se anuncia dos veces: una respuesta COMPLETED duplicada, o una obsoleta que llega después, se ignora", async () => {
    const user = userEvent.setup();
    setup();
    await generate(user);
    await waitFor(() => expect(card("n1")).toBeTruthy());
    const done = { ...img("COMPLETED", "n1"), updatedAt: at(30), imageUrl: "https://example.test/i.jpg", downloadUrl: "https://example.test/d" };
    const update = captured.get("n1")!;                                             // la tarjeta se desmonta al terminar, pero sus sondeos en vuelo aún llaman a onUpdate
    const a = additions();
    act(() => update(done));
    expect(a.read()).toEqual([TRYON_ANNOUNCEMENTS.done]);
    act(() => update(done));                                                         // duplicada
    act(() => update({ ...done, status: "PROCESSING", updatedAt: at(5) }));          // obsoleta (un sondeo anterior que llega tarde)
    act(() => update(done));                                                         // y otra vez la final
    expect(a.read()).toEqual([TRYON_ANNOUNCEMENTS.done]);                              // sigue habiendo UN solo anuncio de final
    expect(screen.queryByText(/Trabajo/)).not.toBeInTheDocument();                   // y el trabajo no «resucita» en la lista
    a.stop();
  });

  it("respuestas desordenadas: un PROCESSING más antiguo que un FAILED ya visto se descarta (no se anuncia reintento ni se revive la tarjeta)", async () => {
    const user = userEvent.setup();
    setup();
    await generate(user);
    await waitFor(() => expect(card("n1")).toBeTruthy());
    press("n1", "Falla");
    expect(screen.getByText("Trabajo FAILED")).toBeInTheDocument();
    const a = additions();
    act(() => captured.get("n1")!({ ...img("PROCESSING", "n1"), updatedAt: at(3) }));   // más antigua que el fallo (at(10))
    expect(screen.getByText("Trabajo FAILED")).toBeInTheDocument();
    expect(a.read()).toEqual([]);
    press("n1", "Reintenta");                                                         // un reintento REAL (más reciente) sí se anuncia
    expect(a.read()).toEqual([TRYON_ANNOUNCEMENTS.retrying]);
    a.stop();
  });

  it("generaciones simultáneas con resultados distintos (uno falla, otro termina): cada uno su anuncio y el fallo no anuncia éxito", async () => {
    const user = userEvent.setup();
    setup();
    await startTwo(user);
    const a = additions();
    press("n1", "Falla");
    expect(a.read()).toEqual([]);                                                      // el fallo lo comunica la tarjeta (alert), no la región
    press("n2", "Termina");
    expect(a.read()).toEqual([TRYON_ANNOUNCEMENTS.done]);
    press("n1", "Reintenta");
    expect(a.read()).toEqual([TRYON_ANNOUNCEMENTS.done, TRYON_ANNOUNCEMENTS.retrying]);
    a.stop();
  });
});
