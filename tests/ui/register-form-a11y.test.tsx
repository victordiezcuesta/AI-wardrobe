import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, NETWORK_ERROR_MESSAGE } from "@/utils/api";
import { RegisterForm } from "@/features/authentication/components/register-form";

/** Fase F (M3) — registro: aviso accesible, foco (primer campo inválido / aviso general / mensaje de éxito), duplicados y teclado. */
const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/utils/api", async (orig) => ({ ...(await orig<typeof import("@/utils/api")>()), api: apiMock }));
beforeEach(() => { apiMock.mockReset(); });

const validation = (issues: { path: string; message: string }[]) => new ApiError("Datos no válidos", 422, issues, "VALIDATION");
const submit = () => userEvent.click(screen.getByRole("button", { name: "Crear cuenta" }));
const notBody = () => { const a = document.activeElement as HTMLElement; expect(a).not.toBe(document.body); expect(a.matches(":disabled")).toBe(false); return a; };

describe("RegisterForm — foco tras un error", () => {
  it("con errores de campo, el foco va al primer campo inválido en orden de documento (aunque no sea el primero recibido)", async () => {
    apiMock.mockRejectedValueOnce(validation([{ path: "password", message: "Incluye un número" }, { path: "email", message: "Introduce un email válido" }]));
    render(<RegisterForm />);
    await submit();
    await waitFor(() => expect(screen.getByLabelText("Email")).toHaveFocus()); // email va antes que contraseña en el formulario
    expect(notBody()).toBe(screen.getByLabelText("Email"));
  });

  it("con un solo campo inválido (contraseña), el foco va a ese campo, no al botón", async () => {
    apiMock.mockRejectedValueOnce(validation([{ path: "password", message: "Mínimo 10 caracteres" }]));
    render(<RegisterForm />);
    await submit();
    await waitFor(() => expect(screen.getByLabelText("Contraseña")).toHaveFocus());
    expect(screen.getByRole("button", { name: "Crear cuenta" })).toBeEnabled();
  });

  it("con un error general (sin campo), el foco va al aviso general", async () => {
    apiMock.mockRejectedValueOnce(validation([{ path: "", message: "Hay campos que no se reconocen" }]));
    render(<RegisterForm />);
    await submit();
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert).toHaveFocus());
    expect(alert).toHaveTextContent("Hay campos que no se reconocen");
    expect(notBody()).toBe(alert);
  });

  it("con error de campo Y general: el foco va al campo (prioridad) y el aviso general sigue anunciado, una sola vez", async () => {
    apiMock.mockRejectedValueOnce(validation([{ path: "email", message: "Introduce un email válido" }, { path: "x.y", message: "Valor no válido" }]));
    render(<RegisterForm />);
    await submit();
    await waitFor(() => expect(screen.getByLabelText("Email")).toHaveFocus());
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent("Valor no válido");
    expect(screen.getByRole("alert")).not.toHaveTextContent("Introduce un email válido"); // el error de campo no se duplica en el aviso
  });

  it.each([
    ["red", new TypeError("Failed to fetch"), NETWORK_ERROR_MESSAGE],
    ["servidor (500)", new ApiError("Error interno", 500, undefined, "INTERNAL"), "Error interno"],
    ["límite (429)", new ApiError("Demasiadas solicitudes. Inténtalo en 60s", 429, undefined, "RATE_LIMITED"), /Demasiadas solicitudes/],
  ])("%s: aviso anunciado con el foco en él y ningún campo inválido", async (_n, error, text) => {
    apiMock.mockRejectedValueOnce(error);
    render(<RegisterForm />);
    await submit();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(text);
    await waitFor(() => expect(alert).toHaveFocus());
    for (const l of ["Nombre (opcional)", "Email", "Contraseña"]) expect(screen.getByLabelText(l)).toHaveAttribute("aria-invalid", "false");
  });
});

describe("RegisterForm — región viva y reenvíos", () => {
  it("el aviso es una única región role=alert aunque haya varios mensajes", async () => {
    apiMock.mockRejectedValueOnce(validation([{ path: "", message: "Uno" }, { path: "a.b", message: "Dos" }, { path: "c", message: "Tres" }]));
    render(<RegisterForm />);
    await submit();
    const alert = await screen.findByRole("alert");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    for (const m of ["Uno", "Dos", "Tres"]) expect(alert).toHaveTextContent(m);
    expect(alert.querySelector("[role=alert], [aria-live]")).toBeNull();    // sin regiones vivas anidadas
  });

  it("al reenviar, el aviso se sustituye, el foco se recoloca y un envío correcto lo limpia y enfoca el mensaje de éxito", async () => {
    apiMock.mockRejectedValueOnce(validation([{ path: "", message: "Primero" }]));
    apiMock.mockRejectedValueOnce(validation([{ path: "", message: "Segundo" }]));
    apiMock.mockResolvedValueOnce({ ok: true });
    render(<RegisterForm />);
    await submit();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveFocus());
    await submit();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Segundo"));
    expect(screen.queryByText("Primero")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveFocus());
    await submit();
    const ok = await screen.findByText(/Revisa tu correo/);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await waitFor(() => expect(ok).toHaveFocus());           // el formulario desaparece: el foco no cae en body
    expect(notBody()).toBe(ok);
  });

  it("el estado de carga no es un error: sin role=alert mientras se envía", async () => {
    apiMock.mockReturnValueOnce(new Promise(() => undefined));
    render(<RegisterForm />);
    await submit();
    expect(screen.getByRole("button", { name: "Crear cuenta" })).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("RegisterForm — duplicados y teclado", () => {
  it("durante la carga, clics y Enter repetidos no envían de nuevo", async () => {
    apiMock.mockReturnValueOnce(new Promise(() => undefined));
    render(<RegisterForm />);
    await submit(); await submit();
    await userEvent.type(screen.getByLabelText("Email"), "{Enter}");
    await userEvent.type(screen.getByLabelText("Contraseña"), "{Enter}");
    expect(apiMock).toHaveBeenCalledTimes(1);
  });

  it("solo con teclado: Enter desde la contraseña envía, el foco acaba en el campo inválido y Tab sigue el orden normal", async () => {
    apiMock.mockRejectedValueOnce(validation([{ path: "email", message: "Introduce un email válido" }]));
    const user = userEvent.setup();
    render(<RegisterForm />);
    await user.click(screen.getByLabelText("Contraseña"));
    await user.keyboard("Abcdefghi1{Enter}");
    await waitFor(() => expect(screen.getByLabelText("Email")).toHaveFocus());
    await user.tab();
    expect(screen.getByLabelText("Contraseña")).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Crear cuenta" })).toHaveFocus();
    expect(apiMock).toHaveBeenCalledTimes(1);
  });
});
