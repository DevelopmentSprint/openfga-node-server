# Builds NodeFGA from the repository checkout (build context = repository root).
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack prepare pnpm@10.30.3 --activate && pnpm install --frozen-lockfile
COPY tsconfig.json tsdown.config.ts ./
COPY src ./src
COPY migrations ./migrations
RUN pnpm build

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /app /app
USER node
CMD ["node", "dist/server.mjs"]
