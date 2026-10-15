# Installation

NodeFGA is a Node 22 application managed with pnpm.

## Prerequisites

- **Node.js 22** (LTS line). The build target is `node22`; older runtimes are not supported.
- **pnpm 10**. The repo uses pnpm workspaces and pnpm-only `dependencies` resolution.
- **A database** — Postgres 14+ for production, or no setup for SQLite (the `better-sqlite3` dep covers it).

## Install

```sh
git clone https://github.com/DevelopmentSprint/openfga-node-server.git
cd openfga-node-server
pnpm install
```

`pnpm install` builds the `better-sqlite3` native module. CI installs `node-gyp` globally before this step to handle the source-build fallback when prebuilds aren't available; on a local machine the prebuild path usually works directly.

## Schema migrations

The Kysely-typed migrator lives at `src/cli/migrate.ts` and runs via `pnpm migrate`:

```sh
# Apply all pending migrations.
pnpm migrate up

# Roll back the most recent migration.
pnpm migrate down
```

Migrations are namespace-aware. The default namespace is `openfga` and every table this server owns lives under it (Postgres schema, or SQLite table prefix). Override with `OPENFGA_DB_NAMESPACE`.

## Self-bootstrap on start

Single-instance deployments (containers, embedded SQLite) can opt into running migrations at boot:

```yaml
migrateOnStart: true
```

Boot waits for `migrator.migrateToLatest()` against `db.url` before binding sockets. Failure is fatal — the server refuses to start against a half-migrated database.

Multi-instance and serverless deployments should leave `migrateOnStart: false` and run `pnpm migrate up` as an explicit deploy step. The migrator advisory lock correctly serializes concurrent runs, but every concurrent boot still queues on the lock, ballooning startup latency on the request-serving path.

## Local HTTPS

Generate locally-trusted certs via mkcert in one command:

```sh
pnpm cert:create
```

The script installs a local root CA via mkcert, issues a cert for `localhost`, `127.0.0.1`, and `::1` into `.certs/`, and prints the exact env-var values to paste into your config (`tls.certFile`, `tls.keyFile`, `NODE_EXTRA_CA_CERTS`).

## Boot

```sh
pnpm dev          # dev server with tsx watch
pnpm start        # production build (requires `pnpm build` first)
pnpm build        # emits dist/server.mjs via tsdown
```

The HTTP listener defaults to `:8080`. The HTTPS listener (when TLS files are set) defaults to `:8443`.
