# Configuration

NodeFGA reads its configuration through
[c12](https://github.com/unjs/c12) (the UnJS hierarchical config
loader) with [Zod](https://zod.dev) for runtime validation and
TypeScript type inference. The shipping surface is a single canonical
file plus an env-var override layer.

## The canonical file

`openfga.config.yaml` (or `.yml`, `.toml`, `.jsonc`, `.json5`,
`.json`, `.ts`, `.js`) at the project root is the canonical config
source. c12 discovers it automatically at startup; no path flag
required.

A minimal viable config:

```yaml
db:
  url: postgresql://postgres:postgres@localhost:5432/openfga
```

Every other field has a default. See
`openfga.config.example.yaml` in the repo for the full annotated
shape.

## Configuration shape

The schema groups concerns into logical sections:

```yaml
db:                # database connection + namespace + pool tuning
  url: …
  namespace: openfga
  applicationName: openfga-node-server
  pool:
    max: 10
    min: 0
    idleTimeoutMs: 30000
    connectionTimeoutMs: 0
    statementTimeoutMs: 0
    queryTimeoutMs: 0

listeners:         # HTTP / HTTPS sockets
  http:
    enabled: true
    port: 8080
  https:
    port: 8443

tls:               # certificate paths; both fields together enables HTTPS
  certFile: ''
  keyFile: ''

log:
  level: info      # trace | debug | info | warn | error | fatal | silent

auth:              # caller authentication mode for /stores/*
  mode: none       # none | preshared | oidc
  presharedKeys: []
  oidc:
    issuer: ''
    audience: ''
    # …

idempotency:
  mode: off        # off | optional | required
  ttlMs: 86400000

loadModel:         # the `pnpm load-model` CLI; not used by the server runtime
  apiUrl: http://localhost:8080
  storeName: default

otel:              # OpenTelemetry tracing — off by default
  enabled: false
  # …

migrateOnStart: false
maxChecksPerBatchCheck: 50   # max checks per batch-check request
```

## Per-environment overrides

c12 supports `$development`, `$production`, and `$test` blocks at the
top level. The block matching `NODE_ENV` at startup is merged on top
of the base block:

```yaml
db:
  url: postgresql://postgres@localhost/openfga
log:
  level: info

$development:
  log:
    level: debug

$production:
  log:
    level: info
  db:
    pool:
      connectionTimeoutMs: 5000
      statementTimeoutMs: 30000

$test:
  db:
    url: ':memory:'
```

This is how you keep a single config file across environments without
sprinkling `if NODE_ENV` checks through your deployment scripts.

## Env-var override layer

Every `OPENFGA_*` env var maps onto a nested config path. Env vars
override file values, which override schema defaults. The full
mapping is in
[Environment Variables](/guide/env-vars), but the short version:

```
OPENFGA_DB_URL                     → db.url
OPENFGA_DB_NAMESPACE               → db.namespace
OPENFGA_DB_POOL_MAX                → db.pool.max
OPENFGA_HTTP_PORT                  → listeners.http.port
OPENFGA_HTTPS_PORT                 → listeners.https.port
OPENFGA_TLS_CERT_FILE              → tls.certFile
OPENFGA_LOG_LEVEL                  → log.level
OPENFGA_AUTH_MODE                  → auth.mode
OPENFGA_AUTH_PRESHARED_KEYS        → auth.presharedKeys (comma-separated)
OPENFGA_AUTH_OIDC_ISSUER           → auth.oidc.issuer
OPENFGA_AUTH_OIDC_AUDIENCE         → auth.oidc.audience
OPENFGA_IDEMPOTENCY_MODE           → idempotency.mode
OPENFGA_IDEMPOTENCY_TTL_MS         → idempotency.ttlMs
OPENFGA_OTEL_ENABLED               → otel.enabled
OPENFGA_OTEL_EXPORTER_TYPE         → otel.exporter.type
OPENFGA_OTEL_SPANS_HTTP            → otel.spans.http
# …and every other field
OPENFGA_MIGRATE_ON_START           → migrateOnStart
```

## Precedence order

Lowest to highest:

1. Zod schema defaults
2. `openfga.config.{yaml,yml,toml,…}` base block
3. `$development` / `$production` / `$test` block matching `NODE_ENV`
4. `OPENFGA_*` env vars (including those loaded from `.env` via c12's
   built-in dotenv support)
5. Test-only programmatic overrides (`reloadConfigForTests`)

## Validation

Every value passes through a Zod schema at startup. Boot fails fast
on:

- Malformed values (`OPENFGA_DB_POOL_MAX=abc` → fatal)
- Cross-field violations (TLS cert without key, HTTP/HTTPS on the same
  port when both listeners active, `auth.mode=oidc` without
  `auth.oidc.issuer`, etc.)
- Sensitive headers in `otel.capture.{request,response}Headers` (the
  schema rejects `authorization`, `cookie`, `x-api-key`, etc.)

A failed parse logs a structured Zod error tree and exits non-zero.
The server never starts in a half-valid configuration.

## Empty-string semantics

`.env` files commonly ship optional keys with empty values
(`OPENFGA_TLS_CERT_FILE=`). The env-overlay treats empty strings as
*unset* for optional fields — the schema default applies. Boolean
and integer fields with empty values also fall back to defaults.

The one place this rule deliberately diverges from prior behavior:
`OPENFGA_HTTP_PORT=` and `OPENFGA_HTTPS_PORT=` fall back to
defaults (8080 / 8443) rather than coercing `Number('') → 0` as the
pre-c12 parser did.

## Test isolation

The `config` export is implemented as a Proxy over a mutable internal
singleton so tests that mutate `process.env` can call
`reloadConfigForTests()` to re-run the load pipeline against fresh
inputs. The Proxy is invisible to runtime code — `config.db.url`
behaves exactly like a plain object property.

In production, `reloadConfigForTests` is never called. The Proxy adds
negligible overhead on access.

## See also

- [Environment Variables](/guide/env-vars) — full mapping table
- [Per-Environment Overrides](/guide/per-env-overrides) — patterns
  and pitfalls
- The annotated `openfga.config.example.yaml` in the repository root
  is the single source of truth for the canonical shape
