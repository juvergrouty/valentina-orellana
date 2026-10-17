#!/bin/bash
# Arranque de la máquina efímera: pantalla virtual + audio nulo + bot.
# Cuando el bot termina, este script termina, la máquina se detiene y Fly la destruye
# (config.auto_destroy = true; restart.policy = "no").
#
# MODO=iniciar_sesion (docs/transcriptor/85-robot-meet.md §6.3): pantalla virtual + VNC + noVNC
# para que Vale inicie sesión UNA vez en la cuenta del robot, y luego src/iniciar-sesion.ts.
# La app no tiene puertos públicos: a noVNC se llega solo por `fly proxy 6080:6080` (red privada
# 6PN de Fly, IPv6). Sin MODO (el caso del bot), todo lo que sigue al bloque es igual que antes.
set -euo pipefail

if [ "${MODO:-}" = "iniciar_sesion" ]; then
  # Ningún proceso de apoyo hereda el secreto de aprovisionamiento (solo lo lee el módulo de node,
  # que además lo borra de su entorno antes de abrir Chromium).
  sin_secreto() { env -u BOT_APROVISIONAR "$@"; }
  sin_secreto Xvfb :99 -screen 0 1280x720x24 -nolisten tcp >/dev/null 2>&1 &
  for _ in $(seq 1 50); do
    if sin_secreto xdotool getdisplaygeometry >/dev/null 2>&1; then break; fi
    sleep 0.1
  done
  # Contraseña VNC aleatoria de un solo uso (VNC usa como máximo 8 caracteres). Se guarda en un
  # archivo (no en la línea de comandos) y se imprime una sola vez en el log.
  umask 077
  VNC_DIR="$(mktemp -d)"
  VNC_PASS="$(sin_secreto node -e "process.stdout.write(require('node:crypto').randomBytes(6).toString('base64url'))")"
  sin_secreto x11vnc -storepasswd "$VNC_PASS" "$VNC_DIR/pass" >/dev/null 2>&1 \
    || { echo "[iniciar_sesion] ERROR: no se pudo crear la contraseña VNC"; exit 1; }
  # Solo escucha en 127.0.0.1:5900; websockify lo expone en [::]:6080 (6PN) con la página de noVNC.
  sin_secreto x11vnc -display :99 -rfbauth "$VNC_DIR/pass" -localhost -rfbport 5900 -forever -shared -quiet -bg -o /dev/null >/dev/null 2>&1 \
    || { echo "[iniciar_sesion] ERROR: x11vnc no arrancó"; exit 1; }
  # 127.0.0.1 explícito: x11vnc -localhost escucha solo en IPv4.
  sin_secreto websockify --web /usr/share/novnc "[::]:6080" 127.0.0.1:5900 >/dev/null 2>&1 &
  WS_PID=$!
  sleep 2
  if ! kill -0 "$WS_PID" 2>/dev/null; then echo "[iniciar_sesion] ERROR: websockify/noVNC no arrancó en [::]:6080"; exit 1; fi
  echo "[iniciar_sesion] noVNC listo en el puerto 6080 (solo por fly proxy). Contraseña VNC de esta máquina: $VNC_PASS"
  unset VNC_PASS
  exec node /app/dist/iniciar-sesion.js
fi

Xvfb :99 -screen 0 1280x720x24 -nolisten tcp >/dev/null 2>&1 &

for _ in $(seq 1 50); do
  if xdotool getdisplaygeometry >/dev/null 2>&1; then break; fi
  sleep 0.1
done

# Salida de audio nula (Chromium necesita un dispositivo para reproducir el audio remoto).
pulseaudio -D --exit-idle-time=-1 --log-target=stderr >/dev/null 2>&1 || true
pactl load-module module-null-sink sink_name=nulo >/dev/null 2>&1 || true
pactl set-default-sink nulo >/dev/null 2>&1 || true

exec node /app/dist/index.js
