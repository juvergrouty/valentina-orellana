# Imagen del bot de Meet. Base oficial de Playwright (Node + Chromium + dependencias del
# sistema), versión fija igual a la de package.json. Chromium corre "con ventana" dentro de
# Xvfb (pantalla virtual): Meet rechaza el modo headless y los clics sintéticos, por eso
# además va xdotool (entrada XTEST real). PulseAudio da un dispositivo de salida nulo para
# que Chromium decodifique el audio remoto. Nada se escribe en disco persistente.
# x11vnc + novnc + websockify: SOLO para MODO=iniciar_sesion (Vale inicia sesión una vez en la
# cuenta del robot viéndolo por noVNC con `fly proxy`; docs/transcriptor/85-robot-meet.md §6.3).
# En el modo normal del bot no se ejecutan.
#
# Cadena de suministro (revisión de seguridad 16 oct, B6):
#  - La imagen base va fijada por DIGEST (índice multi-arquitectura de v1.64.1-noble, leído del
#    registro de Microsoft el 16 oct 2026). Para actualizar: cambiar el tag Y el digest juntos
#    (curl -sI -H 'Accept: application/vnd.oci.image.index.v1+json' \
#       https://mcr.microsoft.com/v2/playwright/manifests/<tag> | grep -i docker-content-digest).
#  - Dependencias con `npm ci` desde package-lock.json (versionado en el repo): misma versión e
#    integridad (sha512) en cada build.

# ── 1. Compilar TypeScript ───────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:7852dc5a7d72f5fe458a597d690f6c42fbc8e9e26ddfa95f8e6ef552558d9bbf AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json && npm prune --omit=dev

# ── 2. Imagen final ──────────────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:7852dc5a7d72f5fe458a597d690f6c42fbc8e9e26ddfa95f8e6ef552558d9bbf
RUN apt-get update \
 && apt-get install -y --no-install-recommends xvfb xdotool pulseaudio x11vnc novnc websockify \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    DISPLAY=:99 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE NOTICE entrypoint.sh ./
RUN chmod 0755 entrypoint.sh
# Usuario sin privilegios que trae la imagen de Playwright. Con él Chromium usa su sandbox de
# espacios de nombres (sin --no-sandbox; ver src/meet/argumentos.ts y README, "Sandbox").
USER pwuser
ENTRYPOINT ["/app/entrypoint.sh"]
