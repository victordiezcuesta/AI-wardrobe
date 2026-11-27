import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PasswordPanel } from "@/features/profile/components/password-panel";
import { PASSWORD_MESSAGES } from "@/features/profile/change-password";

/** Fase E — cambio de contraseña: varias reglas a la vez, errores de servidor por campo, globales, red y limpieza. `fetch` simulado. */
const stub = (status: number, body: unknown) => {
  const f = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", f);
  return f;
};
afterEach(() => { vi.unstubAllGlobals(); });

const field = (label: string) => screen.getByLabelText(label);
const ids = (el: Element) => (el.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
const errorEl = (label: string) => { const id = ids(field(label)).find((i) => i.endsWith("-error")); return id ? document.getElementById(id) : null; };
const messages = (label: string) => { const el = errorEl(label); return !el ? [] : el.tagName === "UL" ? [...el.querySelectorAll("li")].map((n) => n.textContent) : [el.textContent]; };
const fill = async (cur: string, nue: string, conf: string) => {
  await userEvent.type(field("Contraseña actual"), cur);
  await userEvent.type(field("Nueva contraseña"), nue);
  await userEvent.type(field("Confirma la nueva contraseña"), conf);
};
const send = () => userEvent.click(screen.getByRole("button", { name: "Cambiar contraseña" }));

describe("PasswordPanel — validación en el cliente", () => {
  it("varias reglas de la contraseña a la vez (mínimo, mayúscula y número), junto a la ayuda, sin enviar nada", async () => {
    const f = stub(200, { ok: true });
    render(<PasswordPanel />);
    await fill("actual-1", "corta", "corta");
    await send();
    await waitFor(() => expect(field("Nueva contraseña")).toHaveAttribute("aria-invalid", "true"));
    expect(messages("Nueva contraseña")).toEqual(["Mínimo 10 caracteres", "Incluye una mayúscula", "Incluye un número"]);
    expect(ids(field("Nueva contraseña"))).toHaveLength(2);                 // ayuda + errores
    expect(screen.getByText(/Máximo 72 bytes UTF-8/)).toBeVisible();          // la ayuda sigue visible
    expect(f).not.toHaveBeenCalled();
  });

  it("errores en campos distintos a la vez; el foco va al primero con error", async () => {
    render(<PasswordPanel />);
    await userEvent.type(field("Nueva contraseña"), "corta");
    await send();
    await waitFor(() => expect(field("Contraseña actual")).toHaveAttribute("aria-invalid", "true"));
    expect(messages("Contraseña actual")).toEqual([PASSWORD_MESSAGES.currentRequired]);
    expect(messages("Nueva contraseña")).toHaveLength(3);
    expect(messages("Confirma la nueva contraseña")).toEqual([PASSWORD_MESSAGES.mismatch]);
    expect(field("Contraseña actual")).toHaveFocus();
  });

  it("los errores se actualizan al corregir y se limpian al enviar bien", async () => {
    const f = stub(200, { ok: true });
    render(<PasswordPanel />);
    await fill("actual-1", "corta", "corta");
    await send();
    await waitFor(() => expect(messages("Nueva contraseña")).toHaveLength(3));
    await userEvent.clear(field("Nueva contraseña")); await userEvent.clear(field("Confirma la nueva contraseña"));
    await userEvent.type(field("Nueva contraseña"), "Abcdefghij"); await userEvent.type(field("Confirma la nueva contraseña"), "Abcdefghij");
    await send();
    await waitFor(() => expect(messages("Nueva contraseña")).toEqual(["Incluye un número"])); // solo la regla que sigue sin cumplirse
    await userEvent.clear(field("Nueva contraseña")); await userEvent.clear(field("Confirma la nueva contraseña"));
    await userEvent.type(field("Nueva contraseña"), "Abcdefghi1"); await userEvent.type(field("Confirma la nueva contraseña"), "Abcdefghi1");
    await send();
    expect(await screen.findByText(PASSWORD_MESSAGES.success)).toBeVisible();
    expect(f).toHaveBeenCalledTimes(1);
    for (const l of ["Contraseña actual", "Nueva contraseña", "Confirma la nueva contraseña"]) {
      expect(field(l)).toHaveAttribute("aria-invalid", "false");
      expect(errorEl(l)).toBeNull();
    }
  });
});

describe("PasswordPanel — respuestas del servidor", () => {
  it("422 de validación con varios mensajes y varios campos: todos visibles, cada uno en su campo, sin duplicados", async () => {
    stub(422, { error: { code: "VALIDATION", message: "Datos no válidos", issues: [
      { path: "newPassword", message: "Incluye una minúscula" }, { path: "newPassword", message: "Incluye un número" }, { path: "newPassword", message: "Incluye un número" },
      { path: "currentPassword", message: "Máximo 128 caracteres" },
    ] } });
    render(<PasswordPanel />);
    await fill("actual-1", "Abcdefghi1", "Abcdefghi1");
    await send();
    await waitFor(() => expect(field("Nueva contraseña")).toHaveAttribute("aria-invalid", "true"));
    expect(messages("Nueva contraseña")).toEqual(["Incluye una minúscula", "Incluye un número"]);
    expect(messages("Contraseña actual")).toEqual(["Máximo 128 caracteres"]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(); // no es un error global
  });

  it("422 con un path global o no representable: no se atribuye a ningún campo; se muestra el aviso general", async () => {
    stub(422, { error: { code: "VALIDATION", message: "Datos no válidos", issues: [{ path: "", message: "Hay campos que no se reconocen" }] } });
    render(<PasswordPanel />);
    await fill("actual-1", "Abcdefghi1", "Abcdefghi1");
    await send();
    expect(await screen.findByRole("alert")).toHaveTextContent(PASSWORD_MESSAGES.validation);
    for (const l of ["Contraseña actual", "Nueva contraseña", "Confirma la nueva contraseña"]) expect(field(l)).toHaveAttribute("aria-invalid", "false");
  });

  it("contraseña actual incorrecta: error de ese campo; al reenviar con éxito desaparece", async () => {
    stub(403, { error: { code: "BAD_PASSWORD", message: "x" } });
    render(<PasswordPanel />);
    await fill("mala", "Abcdefghi1", "Abcdefghi1");
    await send();
    await waitFor(() => expect(messages("Contraseña actual")).toEqual([PASSWORD_MESSAGES.badPassword]));
    stub(200, { ok: true });
    await send();
    expect(await screen.findByText(PASSWORD_MESSAGES.success)).toBeVisible();
    expect(errorEl("Contraseña actual")).toBeNull();
  });

  it("errores globales (sesión caducada, límite, servidor) y de red: alerta general, ningún campo marcado, y se limpian al reintentar", async () => {
    for (const [status, body, text] of [
      [401, { error: { code: "UNAUTHORIZED", message: "x" } }, PASSWORD_MESSAGES.unauthorized],
      [429, { error: { code: "RATE_LIMITED", message: "x" } }, PASSWORD_MESSAGES.rateLimited],
      [500, { error: { code: "INTERNAL", message: "x" } }, PASSWORD_MESSAGES.generic],
    ] as const) {
      stub(status, body);
      const { unmount } = render(<PasswordPanel />);
      await fill("actual-1", "Abcdefghi1", "Abcdefghi1");
      await send();
      expect(await screen.findByRole("alert")).toHaveTextContent(text);
      for (const l of ["Contraseña actual", "Nueva contraseña", "Confirma la nueva contraseña"]) expect(field(l)).toHaveAttribute("aria-invalid", "false");
      unmount();
    }
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    render(<PasswordPanel />);
    await fill("actual-1", "Abcdefghi1", "Abcdefghi1");
    await send();
    expect(await screen.findByRole("alert")).toHaveTextContent(PASSWORD_MESSAGES.generic);
    stub(200, { ok: true });
    await send();
    expect(await screen.findByText(PASSWORD_MESSAGES.success)).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("no se duplican mensajes: cada texto de error aparece una sola vez en la página", async () => {
    render(<PasswordPanel />);
    await userEvent.type(field("Nueva contraseña"), "corta");
    await send();
    await waitFor(() => expect(messages("Nueva contraseña")).toHaveLength(3));
    const panel = screen.getByRole("region", { name: "Contraseña" });
    for (const m of ["Mínimo 10 caracteres", "Incluye una mayúscula", "Incluye un número", PASSWORD_MESSAGES.mismatch].filter((m) => m !== PASSWORD_MESSAGES.mismatch)) {
      expect(within(panel).getAllByText(m, { selector: "li" })).toHaveLength(1);
    }
  });
});
