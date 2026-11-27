import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui";
import { MAIN_CONTENT_ID } from "@/components/layout/main-content";
import { SkipLink } from "@/components/layout/skip-link";
import { NAV_ITEMS } from "@/components/layout/nav-items";

/**
 * Fase H.2 — enlace «Saltar al contenido» y orden de foco. Se prueba el COMPORTAMIENTO del foco con user-event sobre jsdom (Tab, Enter) y
 * con el layout REAL del panel, no solo atributos. LIMITACIÓN: jsdom no aplica Tailwind ni media queries. El comportamiento responsive se
 * EMULA inyectando las reglas que importan (`.hidden` = móvil, `.lg:hidden` = escritorio); que el skip link sea realmente visible al
 * enfocarlo, que no lo tape nada y que la barra inferior se vea donde debe solo se puede comprobar en un navegador real.
 */
const mocks = vi.hoisted(() => ({ onboardingDone: true }));
vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard", redirect: () => { throw new Error("redirect"); }, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ currentSession: async () => ({ user: { id: "u1" } }) }));
vi.mock("@/repositories/user.repository", () => ({ userRepository: { findById: async () => ({ id: "u1", name: "Ana", profile: { onboardingDone: mocks.onboardingDone } }) } }));

const MOBILE_CSS = ".hidden{display:none}";             // < lg: el <aside> (hidden lg:flex) no se muestra
const DESKTOP_CSS = ".lg\\:hidden{display:none}";      // ≥ lg: la barra inferior (lg:hidden) no se muestra
const NAV_LABELS = NAV_ITEMS.map((i) => i.label);
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

beforeEach(() => { mocks.onboardingDone = true; });
afterEach(() => { document.head.querySelectorAll("style[data-test]").forEach((s) => s.remove()); });

async function mountDashboard(css: string) {
  const style = document.createElement("style"); style.dataset.test = "1"; style.textContent = css; document.head.appendChild(style);
  const { default: DashboardLayout } = await import("@/app/(dashboard)/layout");
  const layout = await DashboardLayout({ children: createElement("button", { type: "button" }, "Acción de la página") });
  const view = render(createElement(ToastProvider, null, createElement(SkipLink), layout));
  return { ...view, user: userEvent.setup() };
}
const nameOf = (el: Element | null) => (!el || el === document.body ? "(body)" : (el.getAttribute("aria-label") || el.textContent || el.tagName).replace(/\s+/g, " ").trim());
/** Recorre n paradas de Tab desde el inicio del documento y devuelve el nombre de cada una. */
async function tabs(user: ReturnType<typeof userEvent.setup>, n: number) {
  const seq: string[] = [];
  for (let i = 0; i < n; i++) { await user.tab(); seq.push(nameOf(document.activeElement)); }
  return seq;
}

describe("estructura: el skip link es lo primero y cada página tiene un único destino", () => {
  it("el layout raíz pinta el skip link antes que cualquier otro elemento interactivo y antes del contenido", async () => {
    const { default: RootLayout } = await import("@/app/layout");
    const html = renderToStaticMarkup(RootLayout({ children: createElement("main", { id: MAIN_CONTENT_ID, tabIndex: -1 }, createElement("button", null, "Contenido")) }));
    expect(html).toMatch(/<html[^>]*lang="es"/);
    const firstInteractive = /<(a|button|input|select|textarea)\b[^>]*>/.exec(html)!;
    expect(firstInteractive[1]).toBe("a");
    expect(firstInteractive[0]).toContain(`href="#${MAIN_CONTENT_ID}"`);
    expect(firstInteractive[0]).toContain('class="skip-link"');
    expect(html).toMatch(/<a [^>]*>Saltar al contenido<\/a>/);
    expect(html.indexOf("Saltar al contenido")).toBeLessThan(html.indexOf("<main"));
    expect(count(html, /href="#contenido"/g)).toBe(1);
  });

  it("el destino es #contenido", () => { expect(MAIN_CONTENT_ID).toBe("contenido"); });

  it("not-found y AuthShell: un único <main id=\"contenido\" tabindex=\"-1\"> cada uno", async () => {
    const { default: NotFound } = await import("@/app/not-found");
    const { AuthShell } = await import("@/features/authentication/components/auth-shell");
    for (const html of [renderToStaticMarkup(createElement(NotFound)), renderToStaticMarkup(<AuthShell title="Entrar">x</AuthShell>)]) {
      expect(count(html, /<main\b/g)).toBe(1);
      expect(count(html, /id="contenido"/g)).toBe(1);
      expect(/<main\b[^>]*>/.exec(html)![0]).toMatch(/id="contenido"[^>]*tabindex="-1"|tabindex="-1"[^>]*id="contenido"/);
    }
  });

  it("onboarding: su <main> lleva el id y tabIndex={-1}", async () => {
    mocks.onboardingDone = false;
    const { default: OnboardingPage } = await import("@/app/onboarding/page");
    const el = (await OnboardingPage()) as { type: string; props: { id?: string; tabIndex?: number } };
    expect(el.type).toBe("main");
    expect(el.props.id).toBe(MAIN_CONTENT_ID);
    expect(el.props.tabIndex).toBe(-1);
  });

  it("panel: un único <main#contenido tabindex=-1> con la barra lateral antes y la navegación móvil después", async () => {
    const { container } = await mountDashboard(MOBILE_CSS);
    const mains = container.querySelectorAll("main");
    expect(mains).toHaveLength(1);
    expect(container.querySelectorAll(`[id="${MAIN_CONTENT_ID}"]`)).toHaveLength(1);
    expect(mains[0]).toHaveAttribute("id", MAIN_CONTENT_ID);
    expect(mains[0]).toHaveAttribute("tabindex", "-1");
    // Orden del DOM, independiente de cualquier CSS: aside → main → barra móvil.
    const order = [...container.querySelectorAll("aside, main, nav[aria-label='Principal']")].map((e) => e.tagName.toLowerCase() + (e.closest("aside") && e.tagName === "NAV" ? "(en aside)" : ""));
    expect(order).toEqual(["aside", "nav(en aside)", "main", "nav"]);
  });

  it("no hay ningún <main> en src que no use MAIN_CONTENT_ID (ni un quinto <main> sin tratar)", () => {
    const root = path.join(process.cwd(), "src");
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const withMain = walk(root).filter((f) => f.endsWith(".tsx") && /<main\b/.test(readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "")));
    expect(withMain.map((f) => path.relative(root, f)).sort()).toEqual([
      "app/(dashboard)/layout.tsx", "app/not-found.tsx", "app/onboarding/page.tsx", "features/authentication/components/auth-shell.tsx",
    ]);
    for (const f of withMain) expect(readFileSync(f, "utf8"), f).toMatch(/<main id=\{MAIN_CONTENT_ID\} tabIndex=\{-1\}/);
  });
});

describe("foco real: Tab, Enter y orden", () => {
  it("al pulsar Tab desde el inicio del documento, el foco llega al skip link (primero), con su nombre y destino", async () => {
    const { user } = await mountDashboard(MOBILE_CSS);
    expect(document.activeElement).toBe(document.body);
    await user.tab();
    const link = screen.getByRole("link", { name: "Saltar al contenido" });
    expect(link).toHaveFocus();
    expect(link).toHaveAttribute("href", "#contenido");
  });

  it("al activarlo con Enter, el foco pasa al <main> (y no se queda en el enlace)", async () => {
    const { user, container } = await mountDashboard(MOBILE_CSS);
    await user.tab();
    await user.keyboard("{Enter}");
    const main = container.querySelector("main")!;
    expect(main).toHaveFocus();
    expect(screen.getByRole("link", { name: "Saltar al contenido" })).not.toHaveFocus();
    expect(window.location.hash).toBe("");                 // la activación no ensucia la URL
  });

  it("al activarlo con un clic de ratón también enfoca el contenido", async () => {
    const { user, container } = await mountDashboard(DESKTOP_CSS);
    await user.click(screen.getByRole("link", { name: "Saltar al contenido" }));
    expect(container.querySelector("main")).toHaveFocus();
  });

  it("MÓVIL: Tab recorre skip link → contenido → navegación inferior, igual que se ve (la barra está abajo)", async () => {
    const { user } = await mountDashboard(MOBILE_CSS);
    expect(await tabs(user, 2 + NAV_LABELS.length)).toEqual(["Saltar al contenido", "Acción de la página", ...NAV_LABELS]);
  });

  it("ESCRITORIO: skip link → logo → los seis destinos → cerrar sesión → contenido", async () => {
    const { user } = await mountDashboard(DESKTOP_CSS);
    expect(await tabs(user, 1 + 1 + NAV_LABELS.length + 1 + 1)).toEqual(["Saltar al contenido", "AI Wardrobe", ...NAV_LABELS, "Cerrar sesión", "Acción de la página"]);
  });

  it("MÓVIL: tras saltar al contenido, Tab continúa por el contenido y después por la navegación, en orden lógico", async () => {
    const { user } = await mountDashboard(MOBILE_CSS);
    await user.tab(); await user.keyboard("{Enter}");       // salta al <main>
    const after: string[] = [];
    for (let i = 0; i < 1 + NAV_LABELS.length; i++) { await user.tab(); after.push(nameOf(document.activeElement)); }
    expect(after).toEqual(["Acción de la página", ...NAV_LABELS]);
  });

  it("ESCRITORIO: tras saltar al contenido, Tab sigue con el primer control del contenido (se saltan logo, menú y cierre de sesión)", async () => {
    const { user } = await mountDashboard(DESKTOP_CSS);
    await user.tab(); await user.keyboard("{Enter}");
    await user.tab();
    expect(nameOf(document.activeElement)).toBe("Acción de la página");
  });

  it("Shift+Tab desde el contenido enfocado vuelve hacia atrás de forma coherente (móvil: al skip link)", async () => {
    const { user } = await mountDashboard(MOBILE_CSS);
    await user.tab(); await user.keyboard("{Enter}");
    await user.tab({ shift: true });
    expect(screen.getByRole("link", { name: "Saltar al contenido" })).toHaveFocus();
  });

  it("sin destino (una página sin <main#contenido>) el enlace no lanza, no bloquea la navegación nativa y no cambia el foco", () => {
    render(createElement(SkipLink));
    const link = screen.getByRole("link", { name: "Saltar al contenido" });
    link.focus();
    const notPrevented = fireEvent.click(link);
    expect(notPrevented).toBe(true);                       // no se llamó a preventDefault: el ancla actúa con normalidad
    expect(link).toHaveFocus();
  });

  it("la navegación existente sigue funcionando: ambas barras con los seis destinos y aria-current en el activo", async () => {
    const { container } = await mountDashboard(MOBILE_CSS);
    const navs = [...container.querySelectorAll("nav[aria-label='Principal']")];
    expect(navs).toHaveLength(2);
    for (const nav of navs) {
      const links = [...nav.querySelectorAll("a")];
      expect(links.map((a) => a.getAttribute("href"))).toEqual(NAV_ITEMS.map((i) => i.href));
      expect(links.filter((a) => a.getAttribute("aria-current") === "page").map((a) => a.getAttribute("href"))).toEqual(["/dashboard"]);
    }
    expect(screen.getByRole("button", { name: "Cerrar sesión", hidden: true })).toBeInTheDocument();   // dentro del <aside>, oculto en móvil
  });
});

describe("estilos: el skip link está fuera de pantalla sin salir del árbol de accesibilidad y no lo tapa nada fijo", () => {
  const css = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");
  const rule = (sel: string) => new RegExp(`${sel.replace(/[.:]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";

  it("la regla base lo coloca fijo, fuera de pantalla con transform y sin display:none, visibility:hidden ni hidden", () => {
    const base = rule(".skip-link");
    expect(base).toMatch(/position:\s*fixed/);
    expect(base).toMatch(/transform:\s*translateY\(-\d+%\)/);
    expect(base).not.toMatch(/display:\s*none|visibility:\s*hidden|\bhidden\b|clip|opacity:\s*0/);
    expect(rule(".skip-link:focus")).toMatch(/transform:\s*translateY\(0\)/);
  });

  it("su z-index supera al de cualquier elemento fijo de la aplicación (barra, menús, modales y avisos)", () => {
    const own = Number(/z-index:\s*(\d+)/.exec(rule(".skip-link"))?.[1]);
    const root = path.join(process.cwd(), "src");
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const used = walk(root).filter((f) => f.endsWith(".tsx")).flatMap((f) => [...readFileSync(f, "utf8").matchAll(/\bz-(?:\[(\d+)\]|(\d+))\b/g)].map((m) => Number(m[1] ?? m[2])));
    expect(used.length).toBeGreaterThan(0);
    expect(own).toBeGreaterThan(Math.max(...used));
  });

  it("texto claro (paper) sobre fondo oscuro (ink) con contraste ≥ 4,5:1 según los tokens reales", () => {
    const tok = (n: string) => new RegExp(`--color-${n}:\\s*(#[0-9a-fA-F]{6})`).exec(css)![1]!;
    const lum = (hex: string) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!; };
    const base = rule(".skip-link");
    expect(base).toMatch(/background:\s*var\(--color-ink\)/);
    expect(base).toMatch(/color:\s*var\(--color-paper\)/);
    const [a, b] = [lum(tok("paper")), lum(tok("ink"))];
    expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThanOrEqual(4.5);
  });
});
