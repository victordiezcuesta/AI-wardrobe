import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui";
import { ApiError, NETWORK_ERROR_MESSAGE } from "@/utils/api";
import { ProfileForm, type ProfileFormValues } from "@/features/profile/components/profile-form";

/** Fase E — perfil: errores repetidos por campo, paths anidados y de lista, globales, red y limpieza al reenviar. `api` y router simulados. */
const apiMock = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn());
vi.mock("@/utils/api", async (orig) => ({ ...(await orig<typeof import("@/utils/api")>()), api: apiMock }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));

const initial: ProfileFormValues = {
  name: "", age: null, heightCm: null, presentation: "", usualStyles: [], exploreStyles: [], favoriteColors: [], avoidedColors: [],
  favoriteBrands: [], budgetMin: null, budgetMax: null, sizes: {}, fitPreference: "", favoriteGarments: [], home: null,
};
const validation = (issues: { path: string; message: string }[]) => new ApiError("Datos no válidos", 422, issues, "VALIDATION");
const ids = (el: Element) => (el.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
const messages = (label: string) => { const id = ids(screen.getByLabelText(label)).find((i) => i.endsWith("-error")); const el = id ? document.getElementById(id) : null; return !el ? [] : el.tagName === "UL" ? [...el.querySelectorAll("li")].map((n) => n.textContent) : [el.textContent]; };
const renderForm = () => render(<ToastProvider><ProfileForm initial={initial} mode="settings" /></ToastProvider>);
const save = () => userEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));

beforeEach(() => { apiMock.mockReset(); push.mockReset(); });

describe("ProfileForm — errores de validación", () => {
  it("varios errores de un mismo campo y de campos distintos, cada uno en el suyo, sin duplicados", async () => {
    apiMock.mockRejectedValueOnce(validation([
      { path: "age", message: "Debe ser 13 o más" }, { path: "age", message: "Debe ser un número entero" }, { path: "age", message: "Debe ser un número entero" },
      { path: "heightCm", message: "Debe ser 250 o menos" },
    ]));
    renderForm();
    await save();
    await waitFor(() => expect(screen.getByLabelText("Edad")).toHaveAttribute("aria-invalid", "true"));
    expect(messages("Edad")).toEqual(["Debe ser 13 o más", "Debe ser un número entero"]);
    expect(messages("Altura (cm)")).toEqual(["Debe ser 250 o menos"]);
    expect(screen.getByLabelText("Nombre")).toHaveAttribute("aria-invalid", "false");
  });

  it("paths anidados conocidos (tallas) y elementos de lista («favoriteColors.2») se atribuyen a su campo; la ayuda sigue visible", async () => {
    apiMock.mockRejectedValueOnce(validation([
      { path: "sizes.top", message: "Máximo 10 caracteres" },
      { path: "favoriteColors.0", message: "Máximo 40 caracteres" }, { path: "favoriteColors.2", message: "Máximo 40 caracteres" },
      { path: "favoriteColors", message: "Máximo 20 elementos" },
    ]));
    renderForm();
    await save();
    await waitFor(() => expect(screen.getByLabelText("Talla superior")).toHaveAttribute("aria-invalid", "true"));
    expect(messages("Talla superior")).toEqual(["Máximo 10 caracteres"]);
    expect(messages("Colores favoritos")).toEqual(["Máximo 40 caracteres", "Máximo 20 elementos"]);
    expect(screen.getByText(/Separados por comas/)).toBeVisible();
    expect(ids(screen.getByLabelText("Colores favoritos"))).toHaveLength(2);
  });

  const notice = () => screen.getByRole("alert");

  it("homeCity, homeLat, homeLon y otros paths que el formulario no representa: sus mensajes concretos salen en un aviso general y no se asignan a ningún campo", async () => {
    apiMock.mockRejectedValueOnce(validation([
      { path: "homeLat", message: "Debe ser -90 o más" }, { path: "homeLon", message: "Debe ser 180 o menos" }, { path: "homeCity", message: "Máximo 120 caracteres" },
      { path: "usualStyles", message: "Máximo 12 elementos" }, { path: "", message: "Valor no válido" }, { path: "sizes.extra", message: "Valor no válido" },
    ]));
    renderForm();
    await save();
    const box = await screen.findByRole("alert");
    for (const m of ["Debe ser -90 o más", "Debe ser 180 o menos", "Máximo 120 caracteres", "Máximo 12 elementos"]) expect(within(box).getByText(m)).toBeVisible();
    expect(within(box).getAllByText("Valor no válido")).toHaveLength(1); // global + unmatched repetidos: una sola vez
    for (const l of ["Nombre", "Edad", "Altura (cm)", "Talla superior", "Talla inferior", "Número de calzado", "Colores favoritos", "Colores que no usas", "Marcas favoritas", "Presupuesto por prenda, desde (€)", "Presupuesto por prenda, hasta (€)"]) {
      expect(screen.getByLabelText(l)).toHaveAttribute("aria-invalid", "false");
      expect(messages(l)).toEqual([]);
    }
  });

  it("un error de campo y otro no representable a la vez: el de campo en su campo, el otro en el aviso general (y no en el campo)", async () => {
    apiMock.mockRejectedValueOnce(validation([{ path: "age", message: "Debe ser 13 o más" }, { path: "homeLat", message: "Debe ser -90 o más" }]));
    renderForm();
    await save();
    await waitFor(() => expect(messages("Edad")).toEqual(["Debe ser 13 o más"]));
    expect(within(notice()).getByText("Debe ser -90 o más")).toBeVisible();
    expect(within(notice()).queryByText("Debe ser 13 o más")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Altura (cm)")).toHaveAttribute("aria-invalid", "false");
  });

  it("sin errores generales no hay aviso; el mensaje general de la API no sustituye a los concretos", async () => {
    apiMock.mockRejectedValueOnce(validation([{ path: "age", message: "Debe ser 13 o más" }]));
    renderForm();
    await save();
    await waitFor(() => expect(messages("Edad")).toEqual(["Debe ser 13 o más"]));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("el aviso general se actualiza al volver a guardar y desaparece con un envío correcto", async () => {
    apiMock.mockRejectedValueOnce(validation([{ path: "homeLat", message: "Debe ser -90 o más" }]));
    apiMock.mockRejectedValueOnce(validation([{ path: "homeLon", message: "Debe ser 180 o menos" }]));
    apiMock.mockResolvedValueOnce({ ok: true });
    renderForm();
    await save();
    expect(await screen.findByText("Debe ser -90 o más")).toBeVisible();
    await save();
    expect(await screen.findByText("Debe ser 180 o menos")).toBeVisible();
    expect(screen.queryByText("Debe ser -90 o más")).not.toBeInTheDocument(); // sustituido, no acumulado
    await save();
    expect(await screen.findByText("Perfil guardado")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("el presupuesto cruzado (path budgetMin) sigue yendo a su campo y no al aviso general", async () => {
    apiMock.mockRejectedValueOnce(validation([{ path: "budgetMin", message: "El presupuesto mínimo no puede superar el máximo" }]));
    renderForm();
    await save();
    await waitFor(() => expect(messages("Presupuesto por prenda, desde (€)")).toEqual(["El presupuesto mínimo no puede superar el máximo"]));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("al volver a guardar, los errores anteriores se sustituyen por los nuevos y desaparecen con un envío correcto", async () => {
    apiMock.mockRejectedValueOnce(validation([{ path: "age", message: "Debe ser 13 o más" }, { path: "heightCm", message: "Debe ser 100 o más" }]));
    apiMock.mockRejectedValueOnce(validation([{ path: "heightCm", message: "Debe ser 250 o menos" }]));
    apiMock.mockResolvedValueOnce({ ok: true });
    renderForm();
    await save();
    await waitFor(() => expect(messages("Edad")).toEqual(["Debe ser 13 o más"]));
    await save();
    await waitFor(() => expect(messages("Altura (cm)")).toEqual(["Debe ser 250 o menos"]));
    expect(messages("Edad")).toEqual([]);
    expect(screen.getByLabelText("Edad")).toHaveAttribute("aria-invalid", "false");
    await save();
    expect(await screen.findByText("Perfil guardado")).toBeInTheDocument(); // el aviso entra con animación (opacidad inicial 0)
    expect(screen.getByLabelText("Altura (cm)")).toHaveAttribute("aria-invalid", "false");
    expect(messages("Altura (cm)")).toEqual([]);
  });
});

describe("ProfileForm — errores que no son de validación", () => {
  it("red y servidor: aviso general, ningún campo marcado y los errores de campo anteriores se limpian", async () => {
    apiMock.mockRejectedValueOnce(validation([{ path: "age", message: "Debe ser 13 o más" }]));
    apiMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    apiMock.mockRejectedValueOnce(new ApiError("Error interno", 500, undefined, "INTERNAL"));
    renderForm();
    await save();
    await waitFor(() => expect(messages("Edad")).toEqual(["Debe ser 13 o más"]));
    await save();
    expect(await screen.findByText(NETWORK_ERROR_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText(/Failed to fetch/)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(); // red y servidor no usan el aviso de validación
    expect(screen.getByLabelText("Edad")).toHaveAttribute("aria-invalid", "false");
    await save();
    expect(await screen.findByText("Error interno")).toBeInTheDocument();
    expect(screen.getByLabelText("Edad")).toHaveAttribute("aria-invalid", "false");
  });
});
