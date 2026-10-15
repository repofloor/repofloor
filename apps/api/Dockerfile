# apps/api in one image. Built from the repository root, because the service imports
# @repofloor/protocol and @repofloor/reducer as workspace packages.
#
#   docker build -f apps/api/Dockerfile -t repofloor-api .
#
# docker-compose.yml at the root does this for you.

FROM node:22-alpine

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app

# Manifests first: the install layer is then cached until a dependency changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/reducer/package.json packages/reducer/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @repofloor/api...

COPY packages/protocol packages/protocol
COPY packages/reducer packages/reducer
COPY apps/api apps/api

RUN pnpm --filter @repofloor/protocol run build \
 && pnpm --filter @repofloor/reducer run build \
 && pnpm --filter @repofloor/api run build

ENV HOST=0.0.0.0
ENV PORT=8787
EXPOSE 8787

CMD ["node", "apps/api/dist/server.js"]
