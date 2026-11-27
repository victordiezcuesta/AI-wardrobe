import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyze } from "../helpers/contrast";
import { filesOf, scanSrc } from "../helpers/src-scan";

/**
 * H.7 — contraste (WCAG 2.2): 1.4.11 (componentes de interfaz ≥ 3:1) y 1.4.3 (texto ≥ 4,5:1), calculado a partir de los TOKENS reales de
 * `globals.css` y de las superficies donde se usan. LIMITACIÓN: es aritmética sobre los colores declarados; no sustituye la revisión visual
 * (antialiasing, pantallas, modo forzado de colores) ni comprueba capas con transparencia reales del navegador.
 */
const css = readFileSync("src/app/globals.css", "utf8");
const token = (n: string) => { const m = new RegExp(`--color-${n}:\\s*(#[0-9a-fA-F]{6})`).exec(css); if (!m) throw new Error(`falta --color-${n}`); return m[1]!; };
const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lin = (c: number) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
const lum = (h: string) => { const [r, g, b] = rgb(h) as [number, number, number]; return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
const ratio = (a: string, b: string) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number]; return (hi + 0.05) / (lo + 0.05); };
const mix = (fg: string, bg: string, a: number) => "#" + rgb(fg).map((x, i) => Math.round(a * x + (1 - a) * rgb(bg)[i]!).toString(16).padStart(2, "0")).join("");
const [paper, linen, sand, taupe, ink] = ["paper", "linen", "sand", "taupe", "ink"].map(token) as [string, string, string, string, string];
const control = token("control");

describe("H.7 — borde de controles (1.4.11, ≥ 3:1)", () => {
  it("el borde `control` alcanza 3:1 sobre paper y linen, las superficies donde hay campos y pastillas", () => {
    expect(ratio(control, paper)).toBeGreaterThanOrEqual(3);
    expect(ratio(control, linen)).toBeGreaterThanOrEqual(3);
  });

  it("el borde anterior (stone al 70 % sobre paper) NO cumplía: el cambio estaba justificado", () => {
    expect(ratio(mix(token("stone"), paper, 0.7), paper)).toBeLessThan(3);
  });

  it("conserva la identidad: mismo matiz que `stone` (±3°) y más oscuro", () => {
    const hue = (h: string) => { const [r, g, b] = rgb(h).map((x) => x / 255) as [number, number, number]; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; const k = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return (k * 60 + 360) % 360; };
    expect(Math.abs(hue(control) - hue(token("stone")))).toBeLessThanOrEqual(3);
    expect(lum(control)).toBeLessThan(lum(token("stone")));
  });

  it("los estados de campo se mantienen legibles: foco (ink) y error (danger) contrastan con paper", () => {
    expect(ratio(ink, paper)).toBeGreaterThanOrEqual(3);
    expect(ratio(token("danger"), paper)).toBeGreaterThanOrEqual(3);
  });
});

describe("H.7 — texto (1.4.3, ≥ 4,5:1)", () => {
  it("el placeholder (taupe sin opacidad) y el texto secundario cumplen sobre paper y linen", () => {
    expect(ratio(taupe, paper)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(taupe, linen)).toBeGreaterThanOrEqual(4.5);
  });

  it("el placeholder anterior (taupe al 70 %) no cumplía; taupe sobre sand tampoco (4,11)", () => {
    expect(ratio(mix(taupe, paper, 0.7), paper)).toBeLessThan(4.5);
    expect(ratio(taupe, sand)).toBeLessThan(4.5);
  });

  it("el texto del panel de autenticación (ink al 80 % sobre sand) cumple", () => {
    expect(ratio(mix(ink, sand, 0.8), sand)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("H.7 — uso en el código", () => {
  it("ningún control usa ya el borde antiguo `border-stone/70`", () => { expect(scanSrc(/border-stone\/70/)).toEqual([]); });

  it("el borde `border-control` está en el campo compartido y en los controles identificados", () => {
    const files = filesOf(scanSrc(/border-control/));
    for (const f of ["field.tsx", "chip.tsx", "wardrobe-view.tsx", "shopping-view.tsx", "location-picker.tsx", "stylist-form.tsx", "stylist-view.tsx", "tryon-studio.tsx", "add-items.tsx", "photo-manager.tsx"])
      expect(files.some((x) => x.endsWith(f)), f).toBe(true);
  });

  it("los separadores decorativos (`border-t border-stone/50`) y el anillo del distintivo NO se oscurecen; el borde de «Añadir foto» (un control) sí", () => {
    expect(scanSrc(/border-t border-stone\/50/).length).toBeGreaterThanOrEqual(2);
    expect(filesOf(scanSrc(/ring-1 ring-stone/)).some((f) => f.endsWith("shopping-view.tsx"))).toBe(true);   // el distintivo es texto no interactivo: su anillo es adorno
    expect(scanSrc(/border-dashed border-stone(?!\/)/ )).toEqual([]);
    expect(scanSrc(/border-dashed border-control/).length).toBe(1);
  });

  it("ningún placeholder usa opacidad reducida sobre taupe", () => { expect(scanSrc(/placeholder:text-taupe\//)).toEqual([]); });

  it("el texto del panel lateral de autenticación (sobre sand) usa `text-ink/80` y no `text-taupe` (4,11:1)", () => {
    const shell = readFileSync("src/features/authentication/components/auth-shell.tsx", "utf8");
    const side = /<section className="relative hidden bg-sand[\s\S]*?<\/section>/.exec(shell)?.[0] ?? "";
    expect(side).not.toBe("");
    expect(side).toContain("text-ink/80");
    expect(side).not.toContain("text-taupe");
  });

  it("el buscador de prendas usa el color de placeholder accesible (antes, el predeterminado del navegador)", () => {
    expect(readFileSync("src/features/wardrobe/components/wardrobe-view.tsx", "utf8")).toContain("placeholder:text-taupe");
  });
});

/**
 * H7-02 y H7-04 — barrido de TODAS las clases de color de texto y fondo del código. Se analizan los literales de `className` (cadenas) que contienen
 * `text-*` y `bg-*` de los tokens del proyecto, con su opacidad, componiendo sobre paper. LIMITACIÓN: un texto sin fondo en su propio literal hereda el de
 * un ancestro que el análisis estático no conoce; por eso esos textos se miden contra paper, linen y sand (las tres superficies del proyecto).
 */
describe("H7-02/H7-04 — barrido de contraste de texto y de superficies de los controles", () => {
  const names = ["paper", "linen", "sand", "stone", "taupe", "ink", "danger", "ok"] as const;
  const tokens = Object.fromEntries(names.map((n) => [n, token(n)])) as Record<(typeof names)[number], string>;
  const over = (fg: string, bg: string, a: number) => mix(fg, bg, a);
  const textRe = /(?<![\w:\[-])text-(paper|linen|sand|stone|taupe|ink|danger|ok)(?:\/(\d+))?(?![\w-])/g;
  const bgRe = /(?<![\w:\[-])bg-(paper|linen|sand|stone|taupe|ink|danger|ok)(?:\/(\d+))?(?![\w-])/;
  const literals = scanSrc(/text-|border-control/, [".tsx"]).flatMap((h) => [...h.text.matchAll(/"([^"\n]*)"|`([^`\n]*)`/g)].map((m) => ({ ...h, s: (m[1] ?? m[2]) as string })));

  it("hay literales que analizar (el barrido no es vacuo)", () => { expect(literals.filter((l) => /text-(taupe|ink|paper|danger)/.test(l.s)).length).toBeGreaterThan(40); });

  it("todo literal con color de texto Y de fondo propios cumple 4,5:1 (1.4.3)", () => {
    const bad: string[] = [];
    let compared = 0;
    for (const l of literals) {
      const bg = bgRe.exec(l.s);
      if (!bg) continue;
      const surface = over(tokens[bg[1] as keyof typeof tokens], paper, bg[2] ? Number(bg[2]) / 100 : 1);
      for (const t of l.s.matchAll(textRe)) {
        const fg = over(tokens[t[1] as keyof typeof tokens], surface, t[2] ? Number(t[2]) / 100 : 1);
        compared++;
        if (ratio(fg, surface) < 4.5) bad.push(`${l.file}:${l.line} ${t[0]} sobre ${bg[0]} = ${ratio(fg, surface).toFixed(2)}`);
      }
    }
    expect(compared).toBeGreaterThan(10);
    expect(bad).toEqual([]);
  });

  it("todo color de texto usado sin fondo propio cumple 4,5:1 sobre paper y linen (las superficies de contenido); sobre sand solo `text-taupe` no cumple y está restringido", () => {
    const used = new Map<string, number>();
    for (const l of literals) { if (bgRe.test(l.s)) continue; for (const t of l.s.matchAll(textRe)) used.set(t[0], (used.get(t[0]) ?? 0) + 1); }
    expect(used.size).toBeGreaterThanOrEqual(3);
    for (const k of used.keys()) {
      const m = /text-(\w+)(?:\/(\d+))?/.exec(k)!;
      const a = m[2] ? Number(m[2]) / 100 : 1;
      for (const surface of [paper, linen]) expect(ratio(over(tokens[m[1] as keyof typeof tokens], surface, a), surface), `${k} sobre ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(ratio(taupe, sand)).toBeLessThan(4.5);     // …y por eso ningún literal puede combinar `text-taupe` con `bg-sand`:
    expect(literals.filter((l) => /text-taupe(?![\w/])/.test(l.s) && /(^|[\s])(hover:)?bg-sand/.test(l.s) && !/hover:text-/.test(l.s))).toEqual([]);
  });

  it("H7-02 — el borde de control nunca se combina con superficie `sand` (donde queda en 2,86:1): protección para usos futuros", () => {
    expect(ratio(control, sand)).toBeLessThan(3);
    const onSand = (s: string) => /(^|\s)bg-sand/.test(s) || (/hover:bg-sand/.test(s) && !/hover:border-/.test(s));   // en hover el borde debe cambiar (p. ej. hover:border-ink)
    expect(literals.filter((l) => /border-control/.test(l.s) && onSand(l.s)).map((l) => `${l.file}:${l.line}`)).toEqual([]);
  });

  it("los fondos usados como superficie de los controles con `border-control` son solo paper, linen o transparentes (≥ 3:1)", () => {
    const surfaces = new Set<string>();
    for (const l of literals) { if (!/border-control/.test(l.s)) continue; const b = bgRe.exec(l.s); if (b) surfaces.add(b[0]); }
    for (const sfc of surfaces) expect(["bg-paper", "bg-linen", "bg-linen/60"], sfc).toContain(sfc);
  });
});

/**
 * Barrido ampliado (variantes y clases repartidas entre cadenas). Primero se comprueba el PROPIO analizador con fuentes sintéticas que deben fallar o pasar
 * (así sabemos que detecta lo que dice), y después se aplica a todo `src/`.
 */
describe("H7-04 ampliado — analizador de contraste con variantes", () => {
  const colors = Object.fromEntries(["paper", "linen", "sand", "stone", "taupe", "ink", "danger", "ok"].map((n) => [n, token(n)]));
  const bad = (src: string) => analyze(src, "x.tsx", colors).findings;

  it("detecta un hover que incumple (texto taupe que pasa a fondo sand), con su estado", () => {
    const f = bad('<a className="text-taupe hover:bg-sand">x</a>');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ state: "hover:", text: "text-taupe", bg: "bg-sand" });
    expect(f[0]!.ratio).toBeLessThan(4.5);
  });
  it("detecta hover:text-* claro sobre el fondo base, focus: y focus-visible:", () => {
    expect(bad('<a className="bg-paper hover:text-stone">x</a>')).toHaveLength(1);
    expect(bad('<a className="bg-paper focus:text-stone">x</a>')).toHaveLength(1);
    expect(bad('<a className="bg-linen focus-visible:text-stone">x</a>')).toHaveLength(1);
    expect(bad('<a className="bg-ink group-hover:text-taupe">x</a>')).toHaveLength(1);
  });
  it("detecta el placeholder con opacidad reducida y variantes aria-*", () => {
    expect(bad('<input className="placeholder:text-taupe/70" />')).not.toHaveLength(0);
    expect(bad('<b className="aria-pressed:bg-ink aria-pressed:text-taupe">x</b>')).toHaveLength(1);
  });
  it("detecta clases repartidas entre cadenas de la misma línea (texto en una, fondo en otra, también en ternarios)", () => {
    expect(bad('<a className={cn("text-taupe", on ? "bg-sand" : "bg-paper")}>x</a>').filter((f) => f.state === "base+cruce" && f.bg === "bg-sand")).toHaveLength(1);
    expect(bad('<a className={cn("text-paper", on ? "bg-ink" : "bg-stone")}>x</a>').some((f) => f.bg === "bg-stone")).toBe(true);
  });
  it("no da falsos positivos con combinaciones que cumplen (incluidos estados y opacidades)", () => {
    expect(bad('<a className="bg-ink text-paper hover:bg-taupe">x</a>')).toEqual([]);
    expect(bad('<a className={cn("text-taupe", on ? "bg-paper" : "bg-linen")}>x</a>')).toEqual([]);
    expect(bad('<a className="text-taupe hover:text-ink hover:bg-sand">x</a>')).toEqual([]);
    expect(bad('<a className="bg-ink text-paper aria-pressed:bg-paper aria-pressed:text-ink">x</a>')).toEqual([]);
    expect(bad('<i className="disabled:text-stone bg-paper">x</i>')).toEqual([]);                  // deshabilitado: exento
  });

  it("todo `src/` cumple 4,5:1 en todos los estados y combinaciones, y el barrido no es vacuo (cientos de medidas, con hover y placeholder)", () => {
    const all = filesOf(scanSrc(/text-|bg-/, [".tsx"])).map((f) => analyze(readFileSync(f, "utf8"), f, colors));
    const findings = all.flatMap((a) => a.findings);
    const evaluated = all.reduce((n, a) => n + a.evaluated, 0);
    const states = new Set(all.flatMap((a) => [...a.states]));
    expect(findings.map((f) => `${f.file}:${f.line} ${f.state} ${f.text} sobre ${f.bg} = ${f.ratio}`)).toEqual([]);
    expect(evaluated).toBeGreaterThan(150);
    for (const st of ["base", "hover:", "placeholder", "aria-pressed:"]) expect([...states], st).toContain(st);
  });
});
