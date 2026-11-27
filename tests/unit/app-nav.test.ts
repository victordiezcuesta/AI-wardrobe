import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NAV_ITEMS } from "@/components/layout/nav-items";

/**
 * Fase A (M1) — navegación inferior móvil. Renderizado en servidor (react-dom/server): el entorno de pruebas es Node (aún sin
 * jsdom ni Testing Library), así que aquí se comprueban la estructura, los destinos y `aria-current`. El ANCHO REAL en 320, 375 y
 * 768 px no se puede medir sin un navegador: se verifica aparte con Chrome (ver el informe de la fase).
 */
const state = vi.hoisted(() => ({ path: "/dashboard" }));
vi.mock("next/navigation", () => ({ usePathname: () => state.path }));

import { AppNav } from "@/components/layout/app-nav";

const render = () => renderToStaticMarkup(createElement(AppNav, { signOutSlot: createElement("button", null, "Salir") }));
/** HTML de cada <nav> (el de escritorio vive dentro de <aside>; el móvil es un <nav> fijo propio). */
const navs = (html: string) => [...html.matchAll(/<nav\b[^>]*>[\s\S]*?<\/nav>/g)].map((m) => m[0]);
const links = (nav: string) => [...nav.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0]);
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
const label = (a: string) => a.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, "").trim();

beforeEach(() => { state.path = "/dashboard"; });

describe("AppNav — navegación inferior móvil", () => {
  it("hay dos navegaciones «Principal» (escritorio y móvil) con los seis destinos, en el mismo orden", () => {
    const [desktop, mobile] = navs(render());
    expect(desktop).toBeDefined();
    expect(mobile).toBeDefined();
    for (const nav of [desktop!, mobile!]) {
      expect(attr(nav, "aria-label")).toBe("Principal");
      const as = links(nav);
      expect(as.map((a) => attr(a, "href"))).toEqual(NAV_ITEMS.map((i) => i.href));
      expect(as.map(label)).toEqual(NAV_ITEMS.map((i) => i.label));
    }
    expect(NAV_ITEMS).toHaveLength(6);
  });

  it("la barra móvil es una rejilla de seis columnas iguales, fija abajo y oculta en escritorio", () => {
    const mobile = navs(render())[1]!;
    const cls = attr(mobile, "class")!;
    expect(cls).toMatch(/\bgrid\b/);
    expect(cls).toMatch(/\bgrid-cols-6\b/);
    expect(cls).toMatch(/\bfixed\b/);
    expect(cls).toMatch(/\bbottom-0\b/);
    expect(cls).toMatch(/\blg:hidden\b/);
    // El diseño anterior (flex + min-w-16 por elemento) sumaba 384 px y desbordaba a 375 px: no debe volver.
    expect(cls).not.toMatch(/\bflex\b/);
    expect(mobile).not.toMatch(/min-w-16/);
  });

  it("cada destino móvil lleva las clases de celda encogible (min-w-0, min-h-12) y la etiqueta en un contenedor con truncamiento controlado", () => {
    const mobile = navs(render())[1]!;
    for (const a of links(mobile)) {
      const cls = attr(a, "class")!;
      expect(cls).toMatch(/\bmin-w-0\b/);
      expect(cls).toMatch(/\bmin-h-12\b/); // 3rem = 48 px ≥ 44 px
      expect(cls).toMatch(/\bflex-col\b/);
      expect(a).toMatch(/<svg[^>]*aria-hidden="true"/);
      // Etiqueta en su propio nodo, con elipsis (`truncate`) como último recurso. Esto solo comprueba que el contenedor existe: que la
      // etiqueta NO se recorte a 320, 375 y 768 px, y los 44 px de área táctil, lo demuestra la medición en navegador, no esta prueba.
      expect(a).toMatch(/<span class="max-w-full truncate">[^<]+<\/span>/);
    }
  });

  it("marca con aria-current=\"page\" solo el destino activo, en ambas navegaciones", () => {
    state.path = "/wardrobe";
    for (const nav of navs(render())) {
      const current = links(nav).filter((a) => attr(a, "aria-current") === "page");
      expect(current.map((a) => attr(a, "href"))).toEqual(["/wardrobe"]);
      expect(links(nav).filter((a) => attr(a, "aria-current") === undefined)).toHaveLength(5);
    }
  });

  it("una subruta mantiene activo su destino y una ruta ajena no activa ninguno", () => {
    state.path = "/profile/seguridad";
    for (const nav of navs(render())) expect(links(nav).filter((a) => attr(a, "aria-current")).map((a) => attr(a, "href"))).toEqual(["/profile"]);
    state.path = "/otra-cosa";
    for (const nav of navs(render())) expect(links(nav).filter((a) => attr(a, "aria-current"))).toHaveLength(0);
  });

  it("el estado activo y el inactivo se distinguen también en la barra móvil (text-ink / text-taupe)", () => {
    state.path = "/stylist";
    const mobile = navs(render())[1]!;
    for (const a of links(mobile)) {
      const active = attr(a, "aria-current") === "page";
      expect(attr(a, "class")).toMatch(active ? /\btext-ink\b/ : /\btext-taupe\b/);
    }
  });
});

// Alcance acotado: solo se comprueban la visibilidad responsive del <aside>, la estructura básica de sus enlaces y que la ranura de
// cierre de sesión se renderiza. Que el resto de la navegación de escritorio (espaciados, estado activo, estilos…) permanece idéntica
// se verifica mediante el diff de la fase (el cambio no toca las líneas del <aside>), no mediante esta prueba.
describe("AppNav — barra lateral de escritorio (comprobaciones acotadas)", () => {
  it("el aside está oculto por defecto y visible solo desde lg, sus enlaces mantienen la estructura básica en píldora sin clases de la barra móvil y la ranura de cierre de sesión se renderiza", () => {
    const html = render();
    expect(html).toMatch(/<aside[^>]*class="[^"]*\bhidden\b[^"]*\blg:flex\b[^"]*"/);
    const desktop = navs(html)[0]!;
    for (const a of links(desktop)) {
      expect(attr(a, "class")).toMatch(/flex items-center gap-3 rounded-full px-4 py-2\.5/);
      expect(a).not.toMatch(/truncate|min-h-12|grid/);
    }
    expect(html).toContain("Salir"); // la ranura de cierre de sesión se conserva
  });
});
