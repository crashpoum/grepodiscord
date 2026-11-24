# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS deps
WORKDIR /app
# node-canvas ships prebuilt binaries for linux x64/arm64 glibc; build tools are a fallback only.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --foreground-scripts \
    && (node -e "require('canvas')" || npm rebuild canvas --foreground-scripts) \
    && node -e "require('canvas'); console.log('canvas ok')"

FROM deps AS compile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
WORKDIR /app
# Runtime libs for node-canvas + fonts with Greek glyphs for charts.
RUN apt-get update && apt-get install -y --no-install-recommends libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libjpeg62-turbo libgif7 librsvg2-2 fonts-dejavu-core fontconfig \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production DB_PATH=/app/data/grepodiscord.sqlite
COPY --from=compile /app/node_modules ./node_modules
COPY --from=compile /app/compiled ./compiled
COPY package.json ./
RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME ["/app/data"]
CMD ["node", "--disable-warning=ExperimentalWarning", "compiled/index.js"]
