import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, NETWORK_ERROR_MESSAGE } from "@/utils/api";
import { RegisterForm } from "@/features/authentication/components/register-form";

/** Fase E — registro: todos los errores por campo, errores globales, red y limpieza al reenviar. `api` simulada (sin red). */
const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/utils/api", async (orig) => ({ ...(await orig<typeof import("@/utils/api")>()), api: apiMock }));

const validation = (issues: { path: string; message: string }[]) => new ApiError("Datos no válidos", 422, issues, "VALIDATION");
const ids = (el: Element) => (el.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
const submit = async () => { await userEvent.click(screen.getByRole("button", { name: "Crear cuenta" })); };
const textOf = (name: string) => { const el = screen.getByLabelText(name); const id = ids(el).find((i) => i.endsWith("-error")); return id ? document.getElementById(id)!.textContent : null; };

beforeEach(() => { apiMock.mockReset(); });

describe("RegisterForm — errores de validación", () => {
  it("varios errores de un mismo campo se muestran todos (la contraseña, junto a su ayuda), sin duplicados", async () => {
    apiMock.mockRejectedValueOnce(validation([
      { path: "password", message: "Mínimo 10 caracteres" }, { path: "password", message: "Incluye una mayúscula" },
      { path: "password", message: "Incluye un número" }, { path: "password", message: "Incluye un número" },
    ]));
    render(<RegisterForm />);
    await submit();
    const pass = await screen.findByLabelText("Contraseña");
    await waitFor(() => expect(pass).toHaveAttribute("aria-invalid", "true"));
    const list = document.getElementById(ids(pass).find((i) => i.endsWith("-error"))!)!;
    expect([...list.querySelectorAll("li")].map((l) => l.textContent)).toEqual(["Mínimo 10 caracteres", "Incluye una mayúscula", "Incluye un número"]);
    expect(ids(pass)).toHaveLength(2); // ayuda + errores
    expect(screen.getByText(/Mínimo 10 caracteres, con mayúscula/)).toBeVisible(); // la ayuda no desaparece
  });

  it("errores en campos distintos: cada mensaje en su campo; los demás campos quedan válidos", async () => {
    apiMock.mockRejectedValueOnce(validation([{ path: "email", message: "Introduce un email válido" }, { path: "name", message: "Máximo 80 caracteres" }]));
    render(<RegisterForm />);
    await submit();
    await waitFor(() => expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true"));
    expect(textOf("Email")).toBe("Introduce un email válido");
    expect(textOf("Nombre (opcional)")).toBe("Máximo 80 caracteres");
    expect(screen.getByLabelText("Contraseña")).toHaveAttribute("aria-invalid", "false");
  });

  it("path vacío = error global: se muestra como error del formulario y no en ningún campo", async () => {
    apiMock.mockRejectedValueOnce(validation([{ path: "", message: "Hay campos que no se reconocen" }]));
    render(<RegisterForm />);
    await submit();
    expect(await screen.findByText("Hay campos que no se reconocen")).toBeVisible();
    for (const n of ["Email", "Contraseña", "Nombre (opcional)"]) expect(screen.getByLabelText(n)).toHaveAttribute("aria-invalid", "false");
  });

  it("un path que el formulario no representa no se atribuye a un campo: su mensaje concreto se muestra como error general", async () => {
    apiMock.mockRejectedValueOnce(validation([{ path: "desconocido.x", message: "Valor no válido" }]));
    render(<RegisterForm />);
    await submit();
    expect(await screen.findByText("Valor no válido")).toBeVisible();
    expect(screen.queryByText("Datos no válidos")).not.toBeInTheDocument(); // el mensaje concreto no se sustituye por el genérico
    for (const n of ["Email", "Contraseña", "Nombre (opcional)"]) expect(screen.getByLabelText(n)).toHaveAttribute("aria-invalid", "false");
  });

  it("un error de campo y otro no representable a la vez: cada uno donde corresponde, ninguno se pierde ni cambia de sitio", async () => {
    apiMock.mockRejectedValueOnce(validation([{ path: "email", message: "Introduce un email válido" }, { path: "desconocido.x", message: "Valor no válido" }]));
    render(<RegisterForm />);
    await submit();
    expect(await screen.findByText("Valor no válido")).toBeVisible();
    expect(textOf("Email")).toBe("Introduce un email válido");
    expect(screen.getByLabelText("Email").closest("div")).not.toHaveTextContent("Valor no válido"); // no se asigna al campo
    expect(screen.getByLabelText("Contraseña")).toHaveAttribute("aria-invalid", "false");
    expect(screen.getByLabelText("Nombre (opcional)")).toHaveAttribute("aria-invalid", "false");
  });

  it("varios errores no representables y globales: todos visibles, y un mensaje repetido entre ambos grupos sale una sola vez", async () => {
    apiMock.mockRejectedValueOnce(validation([
      { path: "", message: "Hay campos que no se reconocen" }, { path: "a.b", message: "Valor no válido" },
      { path: "c", message: "Hay campos que no se reconocen" }, { path: "d", message: "Otro problema" }, { path: "e", message: "Otro problema" },
    ]));
    render(<RegisterForm />);
    await submit();
    expect(await screen.findByText("Valor no válido")).toBeVisible();
    expect(screen.getAllByText("Hay campos que no se reconocen")).toHaveLength(1);
    expect(screen.getAllByText("Otro problema")).toHaveLength(1);
    for (const n of ["Email", "Contraseña", "Nombre (opcional)"]) expect(screen.getByLabelText(n)).toHaveAttribute("aria-invalid", "false");
  });

  it("los errores generales se actualizan al reenviar y desaparecen con un envío correcto", async () => {
    apiMock.mockRejectedValueOnce(validation([{ path: "a", message: "Primer aviso" }]));
    apiMock.mockRejectedValueOnce(validation([{ path: "b", message: "Segundo aviso" }]));
    apiMock.mockResolvedValueOnce({ ok: true });
    render(<RegisterForm />);
    await submit();
    expect(await screen.findByText("Primer aviso")).toBeVisible();
    await submit();
    expect(await screen.findByText("Segundo aviso")).toBeVisible();
    expect(screen.queryByText("Primer aviso")).not.toBeInTheDocument();
    await submit();
    expect(await screen.findByText(/Revisa tu correo/)).toBeVisible();
    expect(screen.queryByText("Segundo aviso")).not.toBeInTheDocument();
  });

  it("al reenviar, los errores anteriores desaparecen (éxito) o se sustituyen por los nuevos (sin acumularse)", async () => {
    apiMock.mockRejectedValueOnce(validation([{ path: "email", message: "Introduce un email válido" }, { path: "password", message: "Incluye un número" }]));
    apiMock.mockRejectedValueOnce(validation([{ path: "email", message: "Máximo 254 caracteres" }]));
    apiMock.mockResolvedValueOnce({ ok: true });
    render(<RegisterForm />);
    await submit();
    await waitFor(() => expect(textOf("Email")).toBe("Introduce un email válido"));
    await submit();
    await waitFor(() => expect(textOf("Email")).toBe("Máximo 254 caracteres"));
    expect(textOf("Contraseña")).toBeNull(); // el error anterior de la contraseña ya no está
    expect(screen.getByLabelText("Contraseña")).toHaveAttribute("aria-invalid", "false");
    await submit();
    expect(await screen.findByText(/Revisa tu correo/)).toBeVisible();
    expect(screen.queryByText("Máximo 254 caracteres")).not.toBeInTheDocument();
  });
});

describe("RegisterForm — errores que no son de validación", () => {
  it("fallo de red: mensaje general en español, ningún campo marcado", async () => {
    apiMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(<RegisterForm />);
    await submit();
    expect(await screen.findByText(NETWORK_ERROR_MESSAGE)).toBeVisible();
    expect(screen.queryByText(/Failed to fetch/)).not.toBeInTheDocument();
    for (const n of ["Email", "Contraseña", "Nombre (opcional)"]) expect(screen.getByLabelText(n)).toHaveAttribute("aria-invalid", "false");
  });

  it("error del servidor (500) y límite de intentos (429): mensaje general, no error de campo", async () => {
    apiMock.mockRejectedValueOnce(new ApiError("Error interno", 500, undefined, "INTERNAL"));
    render(<RegisterForm />);
    await submit();
    expect(await screen.findByText("Error interno")).toBeVisible();
    apiMock.mockRejectedValueOnce(new ApiError("Demasiadas solicitudes. Inténtalo en 60s", 429, undefined, "RATE_LIMITED"));
    await submit();
    await waitFor(() => expect(screen.queryByText("Error interno")).not.toBeInTheDocument()); // se sustituye, no se acumula
    expect(screen.getByText(/Demasiadas solicitudes/)).toBeVisible();
    expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "false");
  });

  it("el error global desaparece al reenviar con éxito", async () => {
    apiMock.mockRejectedValueOnce(new TypeError("x")).mockResolvedValueOnce({ ok: true });
    render(<RegisterForm />);
    await submit();
    expect(await screen.findByText(NETWORK_ERROR_MESSAGE)).toBeVisible();
    await submit();
    expect(await screen.findByText(/Revisa tu correo/)).toBeVisible();
    expect(screen.queryByText(NETWORK_ERROR_MESSAGE)).not.toBeInTheDocument();
  });
});
