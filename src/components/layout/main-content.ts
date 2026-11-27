/**
 * Identificador del contenido principal de cada página (H.2). Destino del enlace «Saltar al contenido». Cada página tiene UN solo `<main>`
 * con este id y `tabIndex={-1}` (enfocable por programa, no por Tab). Está en un módulo sin «use client» a propósito: un Server Component no
 * puede leer valores exportados desde un módulo de cliente.
 */
export const MAIN_CONTENT_ID = "contenido";
