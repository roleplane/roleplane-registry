# Registry production image: build index.json from entries/, serve it as
# static content — the same shape any client (browse site, `skill search`,
# the run-console browse panel) fetches. Build from the repo root:
# `docker compose up` / `docker build .`

# ---- Index build ----
FROM node:22-alpine AS build
WORKDIR /registry

COPY package.json package-lock.json ./
RUN --mount=type=cache,id=npm,target=/root/.npm \
    npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY entries ./entries
RUN npm run build

# ---- Runtime ----
FROM nginx:alpine AS runtime

COPY --from=build /registry/index.json /usr/share/nginx/html/index.json

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://localhost/index.json || exit 1
