# apps/web, and the one origin the whole stack is served from.
#
#   docker build -f apps/web/Dockerfile -t repofloor-web .
#
# Built from the repository root, because the app imports @repofloor/engine, /protocol
# and /reducer as workspace packages. docker-compose.yml at the root does this for you.
#
# Two stages, because a built bundle needs no Node at runtime. The second stage is
# Caddy, serving the bundle *and* acting as the reverse proxy in front of apps/api and
# apps/realtime — see apps/web/Caddyfile for why that proxy is required rather than
# optional, and why it has to route by the Upgrade header.
#
# One service rather than a static server plus a separate proxy: a bundle and the
# routing in front of it are deployed together and change together, and ADR 0001's
# constraint is one maintainer, so a moving part has to earn itself.

FROM node:22-alpine AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app

# Manifests first: the install layer is then cached until a dependency changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/reducer/package.json packages/reducer/
COPY packages/engine/package.json packages/engine/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @repofloor/web...

COPY packages/protocol packages/protocol
COPY packages/reducer packages/reducer
COPY packages/engine packages/engine
COPY apps/web apps/web

# VITE_API_BASE and VITE_REALTIME_URL are deliberately left unset: same origin is the
# deployment this image is built for, and both escapes are for other arrangements.
RUN pnpm --filter @repofloor/protocol run build \
 && pnpm --filter @repofloor/reducer run build \
 && pnpm --filter @repofloor/engine run build \
 && pnpm --filter @repofloor/web run build

FROM caddy:2.10-alpine

COPY --from=build /app/apps/web/dist /srv
COPY apps/web/Caddyfile /etc/caddy/Caddyfile

EXPOSE 8080

# Caddy's own entrypoint runs the Caddyfile; stated here so the image is readable.
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
