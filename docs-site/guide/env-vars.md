# Environment Variables

Every `OPENFGA_*` env var maps onto a path in the nested config tree.
Env vars override values from `openfga.config.yaml`; both are
overridden by test-only programmatic injection.

Empty strings are treated as *unset* — the schema default applies.
This makes `.env` files with optional fields (`OPENFGA_TLS_CERT_FILE=`)
work without surprising the schema with empty strings.

## Database

| Env var | Config path | Notes |
|---|---|---|
| `OPENFGA_DB_URL` | `db.url` | Postgres DSN or SQLite path. Scheme picks the dialect. |
| `OPENFGA_DB_NAMESPACE` | `db.namespace` | Postgres schema / SQLite table prefix. `^[a-z][a-z0-9_]{0,62}$` |
| `OPENFGA_DB_APPLICATION_NAME` | `db.applicationName` | Reported in `pg_stat_activity`. |
| `OPENFGA_DB_POOL_MAX` | `db.pool.max` | Default 10. |
| `OPENFGA_DB_POOL_MIN` | `db.pool.min` | Default 0. |
| `OPENFGA_DB_POOL_IDLE_TIMEOUT_MS` | `db.pool.idleTimeoutMs` | Default 30000. |
| `OPENFGA_DB_POOL_CONNECTION_TIMEOUT_MS` | `db.pool.connectionTimeoutMs` | 0 = wait forever. Production: 5000. |
| `OPENFGA_DB_STATEMENT_TIMEOUT_MS` | `db.pool.statementTimeoutMs` | Server-side. Production: 30000. |
| `OPENFGA_DB_QUERY_TIMEOUT_MS` | `db.pool.queryTimeoutMs` | Client-side (pg). |

## Listeners

| Env var | Config path | Notes |
|---|---|---|
| `OPENFGA_HTTP_ENABLED` | `listeners.http.enabled` | Set `false` to disable HTTP entirely. Requires TLS files. |
| `OPENFGA_HTTP_PORT` | `listeners.http.port` | Default 8080. |
| `OPENFGA_HTTPS_PORT` | `listeners.https.port` | Default 8443. Only used when TLS is configured. |
| `OPENFGA_TLS_CERT_FILE` | `tls.certFile` | Path to PEM. Both `certFile` and `keyFile` must be set together. |
| `OPENFGA_TLS_KEY_FILE` | `tls.keyFile` | Path to PEM private key. |

## Logging

| Env var | Config path | Notes |
|---|---|---|
| `OPENFGA_LOG_LEVEL` | `log.level` | `trace` / `debug` / `info` / `warn` / `error` / `fatal` / `silent` |

## Authentication

| Env var | Config path | Notes |
|---|---|---|
| `OPENFGA_AUTH_MODE` | `auth.mode` | `none` / `preshared` / `oidc` |
| `OPENFGA_AUTH_PRESHARED_KEYS` | `auth.presharedKeys` | Comma-separated. |
| `OPENFGA_AUTH_OIDC_ISSUER` | `auth.oidc.issuer` | OIDC issuer URL. |
| `OPENFGA_AUTH_OIDC_AUDIENCE` | `auth.oidc.audience` | Required `aud` claim value. |
| `OPENFGA_AUTH_OIDC_ISSUER_ALIASES` | `auth.oidc.issuerAliases` | Comma-separated. |
| `OPENFGA_AUTH_OIDC_SUBJECTS` | `auth.oidc.subjects` | Comma-separated allowlist. |
| `OPENFGA_AUTH_OIDC_CLIENTS` | `auth.oidc.clients` | Comma-separated allowlist. |
| `OPENFGA_AUTH_OIDC_ALGORITHMS` | `auth.oidc.algorithms` | Comma-separated. HS* rejected. |
| `OPENFGA_AUTH_OIDC_CLOCK_SKEW_SEC` | `auth.oidc.clockSkewSec` | Default 60. |
| `OPENFGA_AUTH_OIDC_JWKS_URI` | `auth.oidc.jwksUri` | Override discovery. |

## Idempotency

| Env var | Config path | Notes |
|---|---|---|
| `OPENFGA_IDEMPOTENCY_MODE` | `idempotency.mode` | `off` / `optional` / `required` |
| `OPENFGA_IDEMPOTENCY_TTL_MS` | `idempotency.ttlMs` | Replay window, ms. Default 86400000. |

## Write fences (extension)

| Env var | Config path | Notes |
|---|---|---|
| `OPENFGA_WRITE_FENCES_ENABLED` | `writeFences.enabled` | Boolean, default `false`. Enables the non-upstream durable write-fence extension (`PUT /x-ext/stores/{store_id}/write-fences/{key}` and fence headers on Write). Off keeps the API identical to upstream OpenFGA. |

## OpenTelemetry

| Env var | Config path | Notes |
|---|---|---|
| `OPENFGA_OTEL_ENABLED` | `otel.enabled` | Master switch. |
| `OPENFGA_OTEL_SERVICE_NAME` | `otel.service.name` | Defaults to `openfga-node-server`. |
| `OPENFGA_OTEL_SERVICE_VERSION` | `otel.service.version` | Defaults to package.json version. |
| `OPENFGA_OTEL_EXPORTER_TYPE` | `otel.exporter.type` | `otlp-http` / `otlp-grpc` / `console` / `none` |
| `OPENFGA_OTEL_EXPORTER_ENDPOINT` | `otel.exporter.endpoint` | `OTEL_EXPORTER_OTLP_ENDPOINT` also honored. |
| `OPENFGA_OTEL_EXPORTER_TIMEOUT_MS` | `otel.exporter.timeoutMs` | Default 10000. |
| `OPENFGA_OTEL_SAMPLER_TYPE` | `otel.sampler.type` | See sampler enum. |
| `OPENFGA_OTEL_SAMPLER_RATIO` | `otel.sampler.ratio` | 0.0–1.0 for ratio samplers. |
| `OPENFGA_OTEL_PROPAGATORS` | `otel.propagators` | Comma-separated. |
| `OPENFGA_OTEL_CAPTURE_REQUEST_HEADERS` | `otel.capture.requestHeaders` | Comma-separated. Sensitive headers rejected at schema-load. |
| `OPENFGA_OTEL_CAPTURE_RESPONSE_HEADERS` | `otel.capture.responseHeaders` | Comma-separated. |
| `OPENFGA_OTEL_SPANS_HTTP` | `otel.spans.http` | Boolean. |
| `OPENFGA_OTEL_SPANS_EVALUATOR` | `otel.spans.evaluator` | Boolean. |
| `OPENFGA_OTEL_SPANS_STORAGE` | `otel.spans.storage` | Boolean. |
| `OPENFGA_OTEL_SPANS_AUTH` | `otel.spans.auth` | Boolean. |
| `OPENFGA_OTEL_SPANS_IDEMPOTENCY` | `otel.spans.idempotency` | Boolean. |

The standard upstream `OTEL_*` env vars (`OTEL_EXPORTER_OTLP_ENDPOINT`,
`OTEL_RESOURCE_ATTRIBUTES`, `OTEL_TRACES_SAMPLER`, etc.) are honored by
the OpenTelemetry SDK natively. When both `OPENFGA_OTEL_*` and `OTEL_*`
target the same setting, the `OPENFGA_*` form wins.

## Load-model CLI

These are used only by `pnpm load-model`, not by the server runtime.

| Env var | Config path | Notes |
|---|---|---|
| `OPENFGA_API_URL` | `loadModel.apiUrl` | Defaults to `http://localhost:8080`. |
| `OPENFGA_STORE_NAME` | `loadModel.storeName` | Used when creating a new store. |
| `OPENFGA_STORE_ID` | `loadModel.storeId` | Pin to an existing store id. |

## Batch check

| Env var | Config path | Notes |
|---|---|---|
| `OPENFGA_MAX_CHECKS_PER_BATCH_CHECK` | `maxChecksPerBatchCheck` | Maximum `checks` per `batch-check` request. Positive integer within uint32. Default 50. |

A request over the limit, or one that repeats a `correlation_id`, is
rejected with `400 validation_error`. Each `correlation_id` must be
unique within the request and 1 to 36 characters of ASCII letters,
digits, underscore or hyphen.

## Bootstrap

| Env var | Config path | Notes |
|---|---|---|
| `OPENFGA_MIGRATE_ON_START` | `migrateOnStart` | `true` runs `migrator.migrateToLatest()` at boot. |

## What is NOT here

- `NODE_ENV` — read by c12 to select the `$development` / `$production` /
  `$test` block. Not a config field.
- `OTEL_*` (upstream) — applied by the OTel SDK directly; see
  [Observability](/guide/observability).
- `DEBUG` / `DATABASE_URL` — *not* recognized. Use `OPENFGA_LOG_LEVEL` and
  `OPENFGA_DB_URL`.
