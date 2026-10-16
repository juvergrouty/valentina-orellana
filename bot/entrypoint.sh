#!/bin/bash
# Arranque de la máquina efímera: pantalla virtual + audio nulo + bot.
# Cuando el bot termina, este script termina, la máquina se detiene y Fly la destruye
# (config.auto_destroy = true; restart.policy = "no").
set -euo pipefail

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
