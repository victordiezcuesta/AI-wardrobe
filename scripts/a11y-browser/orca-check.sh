#!/usr/bin/env bash
# Comprobación O-1 con Orca REAL. Requisitos: la app aislada en http://localhost:3100 (con su base local de pruebas, NUNCA .env real).
# Orden importante: speech-dispatcher privado y silencioso -> Orca -> Chrome. Lo único manual: HACER CLIC en la ventana de Chrome
# durante la cuenta atrás (la emulación de foco de CDP no activa la ventana en el compositor y Orca ignora las regiones vivas de
# una ventana no activa). Al terminar se muestra solo lo pronunciado sobre el probador y se borran el log de Orca y el perfil.
set -euo pipefail
cd "$(dirname "$0")/../.."
W="$(mktemp -d)"; SOCK="/run/user/$UID/aiw-spd.sock"; rm -f "$SOCK"
cleanup() { pkill -P $$ 2>/dev/null || true; [ -n "${PIDS:-}" ] && kill $PIDS 2>/dev/null || true; rm -f "$SOCK"; rm -rf "$W"; }
trap cleanup EXIT
mkdir -p "$W/spd"; printf 'DefaultModule dummy\nAddModule "dummy" "sd_dummy" "" ""\nCommunicationMethod "unix_socket"\nSocketPath "%s"\n' "$SOCK" > "$W/spd/speechd.conf"
speech-dispatcher -s -c unix_socket -S "$SOCK" -C "$W/spd" -m /usr/lib/speech-dispatcher-modules -t 0 >/dev/null 2>&1 & PIDS="$!"
sleep 2
SPEECHD_ADDRESS="unix_socket:$SOCK" orca -u "$W/orca" --debug-file="$W/orca.log" >/dev/null 2>&1 & PIDS="$PIDS $!"
sleep 6
google-chrome --user-data-dir="$W/chrome" --remote-debugging-port=9333 --remote-debugging-address=127.0.0.1 --force-renderer-accessibility --no-first-run --no-default-browser-check http://localhost:3100/login >/dev/null 2>&1 & PIDS="$PIDS $!"
sleep 10
node scripts/a11y-browser/audit.mjs /dashboard >/dev/null
echo ">>> HAZ CLIC AHORA en la ventana de Chrome (tienes 20 s)"; for i in $(seq 20 -1 1); do printf '%s ' "$i"; sleep 1; done; echo
MARK=$(wc -l < "$W/orca.log")
node scripts/a11y-browser/tryon.mjs >/dev/null
sleep 2
echo "--- Orca pronunció (solo líneas del probador):"
tail -n +"$MARK" "$W/orca.log" | grep "SPEECH OUTPUT" | sed "s/ {'established'.*//; s/^[0-9:.]* - SPEECH OUTPUT: //" | grep -iE "generando|imagen está lista|preparando" || echo "(nada: Orca no pronunció los anuncios)"
echo "--- Orca ignoró regiones vivas:"; tail -n +"$MARK" "$W/orca.log" | grep -c "Live region source is not in active tab" || true
