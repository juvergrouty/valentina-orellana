# Imagen del bot de Meet. Base oficial de Playwright (Node + Chromium + dependencias del
# sistema), versión fija igual a la de package.json. Chromium corre "con ventana" dentro de
# Xvfb (pantalla virtual): Meet rechaza el modo headless y los clics sintéticos, por eso
# además va xdotool (entrada XTEST real). PulseAudio da un dispositivo de salida nulo para
# que Chromium decodifique el audio remoto. Nada se escribe en disco persistente.

# ── 1. Compilar TypeScript ───────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.64.1-noble AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json && npm prune --omit=dev

# ── 2. Imagen final ──────────────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.64.1-noble
RUN apt-get update \
 && apt-get install -y --no-install-recommends xvfb xdotool pulseaudio \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    DISPLAY=:99 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE NOTICE entrypoint.sh ./
RUN chmod 0755 entrypoint.sh
# Usuario sin privilegios que trae la imagen de Playwright.
USER pwuser
ENTRYPOINT ["/app/entrypoint.sh"]
