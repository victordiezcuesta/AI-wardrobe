# Validación de accesibilidad con Chrome real (CDP) y Orca

Scripts de la Fase I para repetir la validación manual. Hablan con Chrome por el protocolo de DevTools (solo `127.0.0.1`).
Usan `ws` (ya instalado). **No** se ejecutan contra producción: necesitan una copia aislada de la app con una base de datos local
con datos de prueba (usuario verificado, perfil con onboarding hecho, prendas y dos conjuntos con el mismo nombre).

1. Arrancar la app aislada en `http://localhost:3100` (`next start -p 3100`) con su propio `.env.local` (nunca el `.env` real).
2. `google-chrome --user-data-dir=<dir temporal> --remote-debugging-port=9333 --remote-debugging-address=127.0.0.1 --force-renderer-accessibility http://localhost:3100/login`
3. `node scripts/a11y-browser/audit.mjs` (árbol de accesibilidad, landmarks, Tab, foco), `dialog.mjs` (modales), `tryon.mjs` (probador
   con las llamadas `/api/try-on*` simuladas: dos generaciones consecutivas).
4. Para escuchar con Orca: `orca -u <dir temporal> --debug-file=<log>` y **dar el foco real a la ventana de Chrome** (clic): Orca
   descarta los eventos de aplicaciones que no son la ventana activa («not from active app»). Después ejecutar `tryon.mjs` y buscar
   `SPEECH OUTPUT` en el log. El log de depuración de Orca incluye también el texto de otras ventanas (p. ej. el terminal): bórralo al terminar.

## Orca: O-1 (dos finalizaciones idénticas) con `orca-check.sh`
`bash scripts/a11y-browser/orca-check.sh` arranca un speech-dispatcher privado y silencioso, Orca y Chrome (en ese orden), te pide **un clic
en la ventana de Chrome** (cuenta atrás de 20 s), ejecuta `tryon.mjs` y muestra solo lo que Orca pronunció sobre el probador; después borra
el log y el perfil. Si imprime «(nada…)» y un recuento > 0 de «Live region source is not in active tab», la ventana no estaba realmente activa.
