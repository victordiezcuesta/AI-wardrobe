import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NETWORK_ERROR_MESSAGE } from "@/utils/api";
import { ForgotForm } from "@/features/authentication/components/token-forms";

/**
 * Fase F (M3) — recuperación de contraseña: antes `catch { setDone(false) }` tragaba cualquier fallo. `fetch` simulado: se ejercita el
 * recorrido real de `api()` y `ApiError` (estado HTTP, cuerpo de error del servidor), sin red.
 */
const SUCCESS = "Si la cuenta existe, te hemos enviado un enlace para crear una contraseña nueva.";
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const stub = (...responses: (Response | Error | Promise<Response>)[]) => {
  const f = vi.fn(async () => { const r = responses.length > 1 ? responses.shift()! : responses[0]!; if (r instanceof Error) throw r; return r instanceof Response ? r.clone() : r; });
  vi.stubGlobal("fetch", f);
  return f;
};
afterEach(() => { vi.unstubAllGlobals(); });

const submit = () => userEvent.click(screen.getByRole("button", { name: "Enviar enlace" }));
const type = (email = "a@b.co") => userEvent.type(screen.getByLabelText("Email"), email);
const notBody = () => { const a = document.activeElement as HTMLElement; expect(a).not.toBe(document.body); expect(a.matches(":disabled")).toBe(false); return a; };
const err = (status: number, code: string, message: string, issues?: unknown) => reply(status, { error: { code, message, ...(issues ? { issues } : {}) } });

describe("ForgotForm — errores visibles, anunciados y con foco", () => {
  it("error de red: aviso en español (no «Failed to fetch») con el foco en él", async () => {
    stub(new TypeError("Failed to fetch"));
    render(<ForgotForm />);
    await type(); await submit();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(NETWORK_ERROR_MESSAGE);
    expect(screen.queryByText(/Failed to fetch/)).not.toBeInTheDocument();
    await waitFor(() => expect(alert).toHaveFocus());
    expect(screen.queryByText(SUCCESS)).not.toBeInTheDocument();      // un fallo ya no parece un envío correcto
  });

  it.each([
    ["límite de intentos (429)", err(429, "RATE_LIMITED", "Demasiadas solicitudes. Inténtalo en 60s"), /Demasiadas solicitudes/],
    ["servidor (500)", err(500, "INTERNAL", "Error interno"), "Error interno"],
    ["origen no permitido (403)", err(403, "BAD_ORIGIN", "Origen no permitido"), "Origen no permitido"],
    ["respuesta que no es JSON (502)", new Response("<html>Bad gateway</html>", { status: 502 }), "Error inesperado"],
  ])("%s: aviso con el mensaje de la API y foco en él; el formulario sigue disponible", async (_n, response, text) => {
    stub(response);
    render(<ForgotForm />);
    await type(); await submit();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(text);
    await waitFor(() => expect(alert).toHaveFocus());
    expect(screen.getByRole("button", { name: "Enviar enlace" })).toBeEnabled();
    expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "false");
  });

  it("validación (422) del email: error en el campo, enlazado por aria-describedby, con el foco en el campo y sin aviso general", async () => {
    stub(err(422, "VALIDATION", "Datos no válidos", [{ path: "email", message: "Introduce un email válido" }]));
    render(<ForgotForm />);
    await type("no-es-email"); await submit();
    const input = screen.getByLabelText("Email");
    await waitFor(() => expect(input).toHaveAttribute("aria-invalid", "true"));
    expect(document.getElementById(input.getAttribute("aria-describedby")!)).toHaveTextContent("Introduce un email válido");
    await waitFor(() => expect(input).toHaveFocus());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("validación (422) sin campo representable: aviso general con el mensaje concreto y foco en él", async () => {
    stub(err(422, "VALIDATION", "Datos no válidos", [{ path: "", message: "Hay campos que no se reconocen" }]));
    render(<ForgotForm />);
    await type(); await submit();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Hay campos que no se reconocen");
    expect(screen.queryByText("Datos no válidos")).not.toBeInTheDocument();
    await waitFor(() => expect(alert).toHaveFocus());
    expect(notBody()).toBe(alert);
  });

  it("al reenviar, el error se sustituye o se limpia; un envío correcto enfoca el mensaje de éxito", async () => {
    stub(err(500, "INTERNAL", "Error interno"), err(429, "RATE_LIMITED", "Demasiadas solicitudes. Inténtalo en 5s"), reply(200, { ok: true, message: "x" }));
    render(<ForgotForm />);
    await type(); await submit();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Error interno"));
    await submit();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Demasiadas solicitudes/));
    expect(screen.queryByText("Error interno")).not.toBeInTheDocument();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    await submit();
    const ok = await screen.findByText(SUCCESS);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await waitFor(() => expect(ok).toHaveFocus());
    expect(notBody()).toBe(ok);
  });
});

describe("ForgotForm — éxito sin revelar si la cuenta existe", () => {
  it("el mensaje de éxito es el mismo para cualquier correo, no lo contiene y la petición solo envía el email", async () => {
    for (const email of ["existe@example.com", "no-existe@example.com"]) {
      const f = stub(reply(200, { ok: true, message: "Si la cuenta existe, recibirás un enlace." }));
      const { unmount } = render(<ForgotForm />);
      await type(email); await submit();
      const ok = await screen.findByText(SUCCESS);
      expect(ok.textContent).not.toContain(email);
      expect(f).toHaveBeenCalledTimes(1);
      const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("/api/auth/forgot-password");
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual({ email });
      unmount();
    }
  });
});

describe("ForgotForm — duplicados y teclado", () => {
  it("durante la carga, clics y Enter repetidos no envían de nuevo, y la carga no se anuncia como error", async () => {
    const f = stub(new Promise<Response>(() => undefined));
    render(<ForgotForm />);
    await type(); await submit();
    expect(screen.getByRole("button", { name: "Enviar enlace" })).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await submit();
    await userEvent.type(screen.getByLabelText("Email"), "{Enter}");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("solo con teclado: Enter envía y, tras un error, el foco está en el aviso y Tab llega al botón", async () => {
    stub(err(500, "INTERNAL", "Error interno"));
    const user = userEvent.setup();
    render(<ForgotForm />);
    await user.click(screen.getByLabelText("Email"));
    await user.keyboard("a@b.co{Enter}");
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert).toHaveFocus());
    await user.tab();
    expect(screen.getByRole("button", { name: "Enviar enlace" })).toHaveFocus();
  });
});
