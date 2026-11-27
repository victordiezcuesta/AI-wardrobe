"use client";
import type { MouseEvent } from "react";
import { MAIN_CONTENT_ID } from "./main-content";

/**
 * Enlace «Saltar al contenido» (H.2): primer elemento interactivo del documento. Fuera de pantalla hasta que recibe el foco del teclado
 * (estilos en `.skip-link`, globals.css); no usa `display:none` ni `hidden`, así que sigue en el árbol de accesibilidad y en el orden de Tab.
 * Sin JavaScript funciona como enlace de ancla normal. Con JavaScript enfoca el `<main>` de forma explícita: la navegación a un fragmento
 * no mueve el foco de forma fiable en todos los navegadores. Si la página no tiene `<main#contenido>` se deja el comportamiento nativo.
 */
export function SkipLink() {
  function onClick(e: MouseEvent<HTMLAnchorElement>) {
    const target = document.getElementById(MAIN_CONTENT_ID);
    if (!target) return;
    e.preventDefault();
    target.focus();
  }
  return <a href={`#${MAIN_CONTENT_ID}`} onClick={onClick} className="skip-link">Saltar al contenido</a>;
}
