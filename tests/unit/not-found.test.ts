import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authConfig } from "@/lib/auth/config";

/**
 * Fase G (M5) — página 404 propia. Estas pruebas renderizan el componente en servidor (react-dom/server) y comprueban su CONTENIDO y
 * ESTRUCTURA: idioma, código visible, semántica, destino del enlace y compatibilidad con servidor. NO demuestran comportamiento HTTP:
 * ni el estado 404 de una URL desconocida, ni que Next use este archivo como `/_not-found`, ni el aspecto visual. Eso se verifica
 * aparte con una compilación real y, para el aspecto, con un navegador (ver el informe de la fase).
 */
const state = vi.hoisted(() => ({ session: null as { user: { id: string } } | null }));
vi.mock("@/lib/auth/session", () => ({ currentSession: async () => state.session }));

import NotFound, { metadata } from "@/app/not-found";

const html = () => renderToStaticMarkup(createElement(NotFound));
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const count = (h: string, re: RegExp) => [...h.matchAll(re)].length;

beforeEach(() => { state.session = null; });

describe("not-found — contenido y estructura (renderizado en servidor)", () => {
  it("tiene un único <main> y un único <h1>, sin otros encabezados", () => {
    const h = html();
    expect(count(h, /<main\b/g)).toBe(1);
    expect(count(h, /<h1\b/g)).toBe(1);
    expect(count(h, /<h[2-6]\b/g)).toBe(0);
    expect(text(/<h1\b[^>]*>([\s\S]*?)<\/h1>/.exec(h)![1]!)).toBe("No encontramos esa página");
    // el <h1> está dentro del <main>
    expect(/<main\b[\s\S]*<h1\b[\s\S]*<\/h1>[\s\S]*<\/main>/.test(h)).toBe(true);
  });

  it("muestra el código 404 como texto visible (no oculto ni solo para lectores de pantalla)", () => {
    const m = /<p\b([^>]*)>404<\/p>/.exec(html());
    expect(m).not.toBeNull();
    expect(m![1]).not.toMatch(/aria-hidden|\bhidden\b|sr-only/);
  });

  it("todo el texto visible está en español y no queda texto de la página por defecto de Next", () => {
    const t = text(html());
    expect(t).toContain("No encontramos esa página");
    expect(t).toContain("Puede que el enlace esté mal escrito o que la página ya no exista.");
    expect(t).toContain("Volver al inicio");
    expect(t).not.toMatch(/could not be found|not found|this page|return home|go back|home\b/i);
    expect(t).toBe("404 No encontramos esa página Puede que el enlace esté mal escrito o que la página ya no exista. Volver al inicio");
  });

  it("incluye exactamente un enlace, con nombre accesible y destino «/»", () => {
    const h = html();
    const links = [...h.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0]);
    expect(links).toHaveLength(1);
    expect(attr(links[0]!, "href")).toBe("/");
    expect(text(links[0]!)).toBe("Volver al inicio");
    expect(links[0]).not.toMatch(/aria-hidden|tabindex="-1"|target=/);
  });

  it("define el título de la pestaña «Página no encontrada» (el layout raíz añade « · AI Wardrobe»)", () => {
    expect(metadata.title).toBe("Página no encontrada");
  });
});

describe("not-found — compatibilidad con servidor", () => {
  const source = readFileSync(path.join(process.cwd(), "src/app/not-found.tsx"), "utf8");

  it("no es un componente de cliente ni usa hooks, sesión o datos", () => {
    expect(source).not.toMatch(/^\s*["']use client["']/m);
    expect(source).not.toMatch(/\buse(State|Effect|Router|Pathname|SearchParams)\b|next-auth|currentSession|prisma|fetch\(/);
  });

  it("es una función síncrona: se renderiza sin sesión, sin red y sin mocks de datos", () => {
    expect(typeof NotFound).toBe("function");
    expect(NotFound.constructor.name).toBe("Function"); // no AsyncFunction
    expect(() => html()).not.toThrow();
  });
});

describe("not-found — coherencia con el diseño del proyecto (clases; no demuestra el resultado visual)", () => {
  const css = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");

  it("usa los colores y la tipografía del tema del proyecto (@theme en globals.css) y ningún color propio", () => {
    const h = html();
    // Colores del tema declarados en globals.css; se comprueba cuáles aparecen como utilidades de color en el marcado.
    const theme = [...css.matchAll(/--color-([a-z]+):/g)].map((m) => m[1]!);
    expect(theme).toEqual(expect.arrayContaining(["ink", "paper", "taupe"]));
    const used = theme.filter((n) => new RegExp(`\\b(?:bg|text|border)-${n}\\b`).test(h)).sort();
    expect(used).toEqual(["ink", "paper", "taupe"]);
    // Ningún color de la paleta por defecto de Tailwind (p. ej. bg-red-500) ni valores arbitrarios (p. ej. text-[#fff]).
    expect(h).not.toMatch(/\b(?:bg|text|border)-(?:[a-z]+-\d{2,3}|\[#|\[rgb|white\b|black\b)/);
    expect(h).toMatch(/\bfont-display\b/);
    expect(css).toMatch(/--font-display:/);
  });
});

describe("not-found — el destino «/» resuelve el flujo de sesión (lógica real, sin HTTP)", () => {
  /** redirect() de Next lanza un error con digest "NEXT_REDIRECT;<tipo>;<url>;<código>;". */
  async function redirectTarget(): Promise<string | null> {
    const { default: Home } = await import("@/app/page");
    try { await Home(); return null; } catch (e) {
      const digest = (e as { digest?: string }).digest ?? "";
      if (!digest.startsWith("NEXT_REDIRECT")) throw e;
      return digest.split(";")[2] ?? null;
    }
  }

  it("«/» es una ruta pública para el proxy (no exige sesión)", () => {
    const authorized = authConfig.callbacks.authorized as (a: { auth: unknown; request: { nextUrl: { pathname: string } } }) => unknown;
    expect(authorized({ auth: null, request: { nextUrl: { pathname: "/" } } })).toBe(true);
  });

  it("sin sesión «/» redirige a /login y con sesión a /dashboard", async () => {
    state.session = null;
    expect(await redirectTarget()).toBe("/login");
    state.session = { user: { id: "u1" } };
    expect(await redirectTarget()).toBe("/dashboard");
  });
});
