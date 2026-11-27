import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { ToastProvider } from "@/components/ui";
import { JobCard } from "@/features/virtual-try-on/components/job-card";
import type { TryOnDTO } from "@/features/virtual-try-on/types";

/**
 * G9-01 — el contador `{seconds} s` cambia cada segundo: NO puede estar dentro de una región viva (un `status` es atómico y se releería entera cada segundo).
 * LIMITACIÓN: jsdom no es un lector de pantalla; que no se repita el habla se comprueba con NVDA/Orca. Aquí se prueba la estructura: ningún ancestro del contador
 * es una región viva y el texto visible sigue actualizándose.
 */
const job = (status: TryOnDTO["status"], extra: Partial<TryOnDTO> = {}): TryOnDTO => ({ id: "j1", status, scenario: "studio", pose: "standing", outfitId: null, errorMessage: null, attempts: 1,
  isFavorite: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", imageUrl: null, downloadUrl: null, ...extra });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const live = (el: Element) => el.closest("[role=status], [role=alert], [aria-live]");

describe("G9-01 — JobCard", () => {
  it("el contador de segundos no está dentro de ninguna región viva y la tarjeta activa no contiene ningún [role=status]/[aria-live]", () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    const { container } = render(<ToastProvider><JobCard job={job("PROCESSING")} onUpdate={() => undefined} /></ToastProvider>);
    const counter = screen.getByText(/^0 s ·/);
    expect(live(counter)).toBeNull();
    const card = counter.closest("div.grid")!;                                              // la tarjeta (el contenedor también incluye la región de avisos del proveedor)
    expect(card.querySelector("[role=status], [aria-live]")).toBeNull();
    expect(card.getAttribute("role")).toBeNull();
    expect(card.querySelector("[role=alert]")).toBeNull();
    expect(container.contains(card)).toBe(true);
  });

  it("la información visual se conserva: el tiempo transcurrido avanza cada segundo y el mensaje de progreso cambia con el tiempo", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    render(<ToastProvider><JobCard job={job("PENDING")} onUpdate={() => undefined} /></ToastProvider>);
    expect(screen.getByText("Preparando tu foto y las prendas…")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByText(/^3 s ·/)).toBeInTheDocument();
    expect(live(screen.getByText(/^3 s ·/))).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByText(/^13 s ·/)).toBeInTheDocument();
    expect(screen.getByText("Vistiéndote con el conjunto…")).toBeInTheDocument();           // a los 12 s cambia el mensaje
  });

  it("el estado de fallo conserva su `role=alert` (se monta ya con contenido, que es como se anuncia un alert) y no tiene contador", () => {
    const { container } = render(<ToastProvider><JobCard job={job("FAILED", { errorMessage: "Falló el proveedor" })} onUpdate={() => undefined} /></ToastProvider>);
    const alert = container.querySelector("[role=alert]")!;
    expect(alert).toHaveTextContent("No se ha podido generar la imagen");
    expect(alert).toHaveTextContent("Falló el proveedor");
    expect(alert.querySelector("[role=status]")).toBeNull();
  });

  it("una generación terminada no pinta nada (el aviso de fin lo da TryOnStudio)", () => {
    const { container } = render(<ToastProvider><JobCard job={job("COMPLETED")} onUpdate={() => undefined} /></ToastProvider>);
    expect(container.querySelector(":scope > :not([data-dialog-companion])")).toBeNull();
  });
});
