import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findBlocks, parseCss } from "../helpers/css";
import { scanSrc } from "../helpers/src-scan";

/**
 * H.6.2 y H.6.3 — `src/app/globals.css`, consultado como ÁRBOL de reglas (no con expresiones sobre el texto). LIMITACIÓN: describe lo escrito en el CSS;
 * no demuestra el desplazamiento real con la barra y los avisos fijos ni el comportamiento con `prefers-reduced-motion` en un navegador (revisión manual).
 * La publicación de `--toast-inset` la prueba `toast.test.tsx`.
 */
const cssText = readFileSync("src/app/globals.css", "utf8");
const css = parseCss(cssText);
const rule = (blocks: ReturnType<typeof findBlocks>, sel: string) => blocks.filter((b) => b.prelude === sel);

describe("H.6.2 — elementos enfocados bajo lo fijo", () => {
  const top = rule(css.children, "html");
  const mobile = findBlocks(css, (p) => p.startsWith("@media") && p.includes("max-width"));

  it("en cualquier ancho, `scroll-padding-bottom` reserva la altura de los avisos publicada por ToastProvider (`--toast-inset`)", () => {
    expect(top.some((r) => r.decls["scroll-padding-bottom"] === "var(--toast-inset, 0px)")).toBe(true);
  });

  it("por debajo de lg se reserva además la barra fija (≥ 3,5 rem + zona segura), tomando el MAYOR de ambos espacios", () => {
    expect(mobile).toHaveLength(1);
    const v = rule(mobile[0]!.children, "html")[0]?.decls["scroll-padding-bottom"] ?? "";
    expect(v.startsWith("max(var(--toast-inset, 0px),")).toBe(true);
    expect(v).toContain("env(safe-area-inset-bottom");
    expect(Number(/calc\(([\d.]+)rem/.exec(v)?.[1])).toBeGreaterThanOrEqual(3.5 + 0.5);
  });

  it("el punto de corte es el de la barra (`lg:hidden` = 64 rem) y no usa la sintaxis de rango, que exige navegadores recientes", () => {
    const max = Number(/max-width:\s*([\d.]+)rem/.exec(mobile[0]!.prelude)?.[1]);
    expect(max).toBeLessThan(64);
    expect(max).toBeGreaterThanOrEqual(63.9);
    expect(cssText.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/\(width\s*[<>]=?/);   // sin contar los comentarios
    const nav = readFileSync("src/components/layout/app-nav.tsx", "utf8");
    expect(nav).toMatch(/fixed inset-x-0 bottom-0[^"]*lg:hidden/);
    expect(nav).toContain("pt-2");
    expect(nav).toContain("min-h-12");
  });

  it("la región de avisos se sitúa sobre la barra móvil con la misma medida (4,5 rem + zona segura) y solo en móvil", () => {
    const toast = readFileSync("src/components/ui/toast.tsx", "utf8");
    expect(toast).toContain("bottom-[calc(4.5rem+env(safe-area-inset-bottom,0px))]");
    expect(toast).toContain("lg:bottom-4");
  });
});

describe("H.6.3 — movimiento reducido", () => {
  const reduced = findBlocks(css, (p) => p === "@media (prefers-reduced-motion: reduce)");

  it("hay un único bloque de movimiento reducido", () => { expect(reduced).toHaveLength(1); });

  it("toda animación se ejecuta una sola vez y al instante, y las transiciones son inmediatas (la duración sola no detiene los bucles)", () => {
    const all = rule(reduced[0]!.children, "*, *::before, *::after")[0]!;
    expect(all.decls["animation-iteration-count"]).toBe("1 !important");
    expect(all.decls["animation-duration"]).toBe("0.01ms !important");
    expect(all.decls["transition-duration"]).toBe("0.01ms !important");
    expect(all.decls["scroll-behavior"]).toBe("auto !important");
  });

  it("los spinners quedan quietos (`animation: none`), con una regla más específica que la universal; el indicador de carga lo da el glifo y el texto/estado", () => {
    expect(rule(reduced[0]!.children, ".animate-spin")[0]?.decls.animation).toBe("none !important");
  });

  it("toda animación infinita del proyecto está cubierta por esas reglas: solo existen los spinners y el shimmer del esqueleto", () => {
    const kinds = new Set(scanSrc(/animate-(spin|pulse|ping|bounce)|animate-\[[a-z]+_[^\]]*infinite\]|repeat: Infinity/).flatMap((h) => h.text.match(/animate-(?:spin|pulse|ping|bounce)|animate-\[[a-z]+_[^\]]*infinite\]|repeat: Infinity/g) ?? []));
    expect([...kinds].sort()).toEqual(["animate-[shimmer_1.6s_linear_infinite]", "animate-spin"]);
  });

  it("cada uso de un spinner tiene una indicación de carga que no depende del movimiento (texto, aria-label o botón en estado `aria-busy`)", () => {
    const spinners = scanSrc(/animate-spin/);
    expect(spinners.length).toBeGreaterThanOrEqual(3);
    const button = readFileSync("src/components/ui/button.tsx", "utf8");
    expect(button).toContain("aria-busy={loading || undefined}");
    expect(readFileSync("src/features/wardrobe/components/add-items.tsx", "utf8")).toContain('aria-label="Procesando"');
    expect(readFileSync("src/features/virtual-try-on/components/job-card.tsx", "utf8")).toMatch(/Loader2[^>]*animate-spin[^>]*\/>\{MESSAGES/);
  });
});
