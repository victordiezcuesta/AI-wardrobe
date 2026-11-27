import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LoginForm } from "@/features/authentication/components/login-form";
import { LOGIN_MESSAGES } from "@/features/authentication/login-errors";

/** Fase F (M3) — login: aviso accesible, foco tras un error, sin envíos duplicados y uso con teclado. `signIn` y router simulados. */
const signIn = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next-auth/react", () => ({ signIn }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }), useSearchParams: () => new URLSearchParams() }));

beforeEach(() => { signIn.mockReset(); push.mockReset(); refresh.mockReset(); });
const submit = () => userEvent.click(screen.getByRole("button", { name: "Entrar" }));
const fill = async () => { await userEvent.type(screen.getByLabelText("Email"), "a@b.co"); await userEvent.type(screen.getByLabelText("Contraseña"), "secreto-1"); };
const focusedOk = () => {
  const a = document.activeElement as HTMLElement;
  expect(a).not.toBe(document.body);
  expect(a.matches(":disabled")).toBe(false);
  return a;
};

describe("LoginForm — errores y anuncio", () => {
  it("credenciales incorrectas: una región role=alert con el mensaje, visible, y ningún campo marcado como inválido", async () => {
    signIn.mockResolvedValueOnce({ error: "CredentialsSignin", code: null });
    render(<LoginForm />);
    await fill(); await submit();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(LOGIN_MESSAGES.invalid);
    expect(alert).toBeVisible();
    expect(screen.getAllByRole("alert")).toHaveLength(1);                 // una sola región viva
    for (const l of ["Email", "Contraseña"]) expect(screen.getByLabelText(l)).toHaveAttribute("aria-invalid", "false");
    expect(screen.getByLabelText("Contraseña")).not.toHaveAttribute("aria-describedby"); // el error no se duplica en el campo
    expect(push).not.toHaveBeenCalled();
  });

  it("el foco va al aviso general (no al botón ni a body) y el aviso puede recibirlo", async () => {
    signIn.mockResolvedValueOnce({ error: "CredentialsSignin", code: null });
    render(<LoginForm />);
    await fill(); await submit();
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert).toHaveFocus());
    expect(focusedOk()).toBe(alert);
    expect(alert).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("button", { name: "Entrar" })).toBeEnabled();  // el botón se rehabilita; el foco no se queda en él
  });

  it.each([
    ["límite de intentos", { error: "CredentialsSignin", code: "rate_limited" }, LOGIN_MESSAGES.rateLimited],
    ["fallo del servidor", { error: "Configuration" }, LOGIN_MESSAGES.unexpected],
  ])("%s: mensaje propio en el aviso y foco en él", async (_n, res, text) => {
    signIn.mockResolvedValueOnce(res);
    render(<LoginForm />);
    await fill(); await submit();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(text);
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it("error de red (signIn rechaza): mensaje temporal en el aviso, distinto del de credenciales", async () => {
    signIn.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(<LoginForm />);
    await fill(); await submit();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(LOGIN_MESSAGES.unexpected);
    expect(alert).not.toHaveTextContent(LOGIN_MESSAGES.invalid);
    expect(screen.queryByText(/Failed to fetch/)).not.toBeInTheDocument();
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it("al reenviar, el aviso se sustituye (no se acumula), el foco vuelve a él y un acceso correcto lo limpia", async () => {
    signIn.mockResolvedValueOnce({ error: "CredentialsSignin", code: null });
    signIn.mockResolvedValueOnce({ error: "CredentialsSignin", code: "rate_limited" });
    signIn.mockResolvedValueOnce({ error: null });
    render(<LoginForm />);
    await fill(); await submit();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(LOGIN_MESSAGES.invalid));
    await submit();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(LOGIN_MESSAGES.rateLimited));
    expect(screen.queryByText(LOGIN_MESSAGES.invalid)).not.toBeInTheDocument();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveFocus());
    await submit();
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("el estado de carga no se anuncia como error: sin role=alert mientras se envía, y el botón queda ocupado y deshabilitado", async () => {
    signIn.mockReturnValueOnce(new Promise(() => undefined));
    render(<LoginForm />);
    await fill(); await submit();
    const button = screen.getByRole("button", { name: "Entrar" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("LoginForm — envíos duplicados y teclado", () => {
  it("durante la carga, clics y Enter repetidos no envían de nuevo", async () => {
    signIn.mockReturnValueOnce(new Promise(() => undefined));
    render(<LoginForm />);
    await fill(); await submit();
    await submit();
    await userEvent.type(screen.getByLabelText("Contraseña"), "{Enter}");
    await userEvent.type(screen.getByLabelText("Email"), "{Enter}");
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it("se puede usar solo con teclado: escribir, Enter para enviar, y tras el error el foco está en el aviso y Tab/Shift+Tab siguen el orden normal", async () => {
    signIn.mockResolvedValueOnce({ error: "CredentialsSignin", code: null });
    const user = userEvent.setup();
    render(<LoginForm />);
    await user.click(screen.getByLabelText("Email"));
    await user.keyboard("a@b.co");
    await user.tab();
    expect(screen.getByLabelText("Contraseña")).toHaveFocus();
    await user.keyboard("secreto-1{Enter}");
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert).toHaveFocus());
    await user.tab();                                           // desde el aviso, el siguiente es el botón
    expect(screen.getByRole("button", { name: "Entrar" })).toHaveFocus();
    await user.tab({ shift: true });                            // hacia atrás, a la contraseña: el aviso (tabindex=-1) no entra en el orden de Tab
    expect(screen.getByLabelText("Contraseña")).toHaveFocus();
    expect(signIn).toHaveBeenCalledTimes(1);
  });
});
