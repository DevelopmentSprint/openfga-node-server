# Configuration

## Status

Proposed.

## Source of Truth

- PRD: `docs/PRD.md` references `OPENFGA_*` env vars descriptively across §Postgres backend (L108, L112), §SQLite backend (L117-119), §Migration on start (L132-133), §Idempotency keys (L162-165), §OpenTelemetry observability (L183-184), §Operational shape (L189, L198), §Migration path TO upstream OpenFGA (L210, L224). No dedicated Configuration section. Configuration is an implementation-level concern; this feature does not amend the PRD because env vars remain valid overrides.
- External library: c12 (UnJS). Typed, hierarchical config loader with auto-resolution of `<name>.config.{ts,js,mjs,cjs,json,jsonc,json5,yaml,yml,toml}`, per-environment override blocks via `$development` / `$production` / `$test` keys, optional `.env` loading (`dotenv: true`).
- Existing dependency: Zod (`zod ^4.4.2`). Used today in `src/routes/schemas.ts` for HTTP request validation; reused here for runtime configuration validation and TypeScript type inference.
- Bead `openfga-iie` design field for the initial scope outline (note: this spec corrects two inaccuracies in the bead's call-site list — see "Call-Site Migration").

## Business Intent

The server is configured today via 16+ flat `OPENFGA_*` environment variables enumerated in `.env.example`, read by direct `process.env['OPENFGA_*']` access at scattered sites: `src/server.ts`, `src/logger.ts`, `src/middleware/auth.ts`, `src/middleware/idempotency.ts`, `src/cli/load-model.ts`, `src/storage/db.ts`, `src/storage/migrate-on-start.ts`, `src/storage/pg-internals.ts`. The flat shape forces long underscore-snake-cased names (`OPENFGA_DB_POOL_IDLE_TIMEOUT_MS`), supports no nesting or grouping, has no per-environment switching short of external orchestration, and reimplements parsing logic (boolean strings, non-negative integers) at multiple call sites.

Adopt c12 as the canonical loader and Zod as the canonical schema. Configuration moves to a single hierarchical file (`openfga.config.{yaml,yml,toml,...}`) with per-environment override blocks. Existing `OPENFGA_*` env vars remain valid as a flat override layer for platform-managed deployment patterns (platform-injected environment variables, Kubernetes secrets, twelve-factor expectations). All direct `process.env` reads in `src/` are replaced with imports from a single typed `src/config.ts`.

## Goals

- One canonical config source: `openfga.config.{yaml,yml,toml,jsonc,json5,json,ts,js,mjs,cjs}` discovered by c12 in CWD.
- Hierarchical schema with logical groupings: `db`, `listeners`, `tls`, `log`, `auth`, `idempotency`, `loadModel`, plus a top-level `migrateOnStart`.
- Per-environment override blocks via c12's `$development`, `$production`, `$test` keys, selected by `NODE_ENV`.
- Zod schema as the single source of truth for both runtime validation (fail-fast at startup) and TypeScript types (`type Config = z.infer<typeof ConfigSchema>`).
- Existing `OPENFGA_*` env vars remain valid overrides via a documented translation table to nested config paths.
- Drop the explicit `dotenv` runtime dependency; let c12 handle `.env` loading via `dotenv: true`.
- All call sites import `config` from `src/config.ts` instead of reading `process.env` directly.
- Bundling stays clean. The startup path performs at most one `loadConfig` call.
- CI tests continue to pass without modification. Integration test setup that drives configuration via `OPENFGA_*` env vars remains valid via the override layer.

## Non-Goals

- Secret-store integration (Vault, AWS SSM, GCP Secret Manager). Out of scope; revisit when an integration target is concrete.
- TLS cert hot-reload. Cert reading remains startup-only; a separate bead can add reload behavior if the operational case arises.
- Runtime config reload. c12 supports a `watch` mode but introducing it changes the server's reload semantics; that is a separate concern.
- PRD updates. Configuration is implementation-level; PRD prose referring to env vars remains factually correct because env vars remain valid as overrides.
- Recommending JSON or TS as the canonical config format. The user-facing on-ramp is YAML or TOML; JSON variants and `.config.{ts,js}` are accepted but not the documented default.
- Replacing the `Idempotency-Key` HTTP header semantics or the auth middleware's wire contract. This feature changes only how those modules *read* their settings.

## File Discovery and Naming

c12's default search in CWD, given `name: 'openfga'`:

- `openfga.config.ts`
- `openfga.config.js` / `.mjs` / `.cjs`
- `openfga.config.json` / `.jsonc` / `.json5`
- `openfga.config.yaml` / `.yml`
- `openfga.config.toml`

Loader call:

```ts
await loadConfig({
  name: 'openfga',
  dotenv: true,
  rcFile: false,        // disable .openfgarc / ~/.openfgarc
  globalRc: false,      // disable global RC discovery
  packageJson: false,   // disable package.json `openfga` config field
})
```

c12's default loader otherwise reads RC files in CWD, global RC files in `$HOME`, and a `package.json` `openfga` field — none of those are part of this feature's contract, and admitting them silently would expand the merge surface beyond the "single canonical config file" promise in the bead acceptance criteria. The explicit `false` switches lock the source set to: defaults + file + per-env block + `.env` + env-overlay + test overrides.

No file is required. All defaults live in the Zod schema; the minimum viable config for development is `OPENFGA_DB_URL` set in `.env` (or in the file).

The repo ships `openfga.config.example.yaml` alongside the existing `.env.example`. YAML is the documented primary surface because it is the most human-edit-friendly of c12's supported formats; TOML is supported by the loader but not the recommended on-ramp.

## Schema Layout

```yaml
# openfga.config.yaml — example
db:
  url: postgres://localhost/openfga
  namespace: openfga
  applicationName: openfga-node-server
  pool:
    max: 10
    min: 0
    idleTimeoutMs: 30000
    connectionTimeoutMs: 0
    statementTimeoutMs: 0
    queryTimeoutMs: 0
listeners:
  http:
    enabled: true
    port: 8080
  https:
    port: 8443
tls:
  certFile: ./certs/server.pem
  keyFile: ./certs/server.key
log:
  level: info
auth:
  mode: none
  presharedKeys: []
idempotency:
  mode: off
  ttlMs: 86400000
loadModel:
  apiUrl: http://localhost:8080
  storeName: default
migrateOnStart: false

$development:
  log:
    level: debug
$production:
  log:
    level: info
  db:
    pool:
      connectionTimeoutMs: 5000
$test:
  db:
    url: ":memory:"
```

Constraints encoded in the Zod schema:

- `db.url` is **optional at the schema level** (`z.string().min(1).optional()`) so the CLI entry points (`src/cli/load-model.ts`) can load `config` without a database URL set. Storage modules call a small `requireDbUrl(config.db.url)` helper that throws the same fail-fast error today's `src/server.ts:44-47` produces when the URL is missing at server bootstrap. This preserves the existing two-tier behavior: load-model CLI runs without DB; server bootstrap and migrate CLI fail fast if DB is unset.
- `db.namespace` matches `^[a-z][a-z0-9_]{0,62}$` (preserves the constraint at `src/storage/db.ts:101` and the migration-recipe substitution semantics in PRD §Migration path).
- `tls.certFile` and `tls.keyFile` are both optional and must either both be set or both be unset. When both are set, the HTTPS listener is enabled. When `listeners.http.enabled = false`, both must be set or the schema rejects (matches the fatal misconfiguration check at `src/server.ts:73-77`).
- `auth.presharedKeys` must contain at least one non-empty entry when `auth.mode = preshared` (matches `src/middleware/auth.ts:60-63`).
- `listeners.http.port` and `listeners.https.port` must differ when both listeners are active (matches `src/server.ts:80-86`).
- `listeners.http.port` and `listeners.https.port` must each be an integer from 1 through 65535; port 0 is rejected.
- `db.pool.min` must be less than or equal to `db.pool.max`.
- `log.level` is one of `trace|debug|info|warn|error|fatal|silent`.

Cross-field constraints are enforced via Zod `superRefine` on the root schema so they fire alongside individual field validation in a single error tree.

## Env-Var Override Mapping

Each existing `OPENFGA_*` env var maps to a nested config path. After c12 loads the file and applies the per-env override block, an env-overlay step applies any set env vars on top, preserving today's deployment patterns.

| Env var | Config path | Type / parser |
|---|---|---|
| `OPENFGA_DB_URL` | `db.url` | string |
| `OPENFGA_DB_NAMESPACE` | `db.namespace` | string |
| `OPENFGA_DB_APPLICATION_NAME` | `db.applicationName` | string |
| `OPENFGA_DB_POOL_MAX` | `db.pool.max` | non-negative int |
| `OPENFGA_DB_POOL_MIN` | `db.pool.min` | non-negative int |
| `OPENFGA_DB_POOL_IDLE_TIMEOUT_MS` | `db.pool.idleTimeoutMs` | non-negative int |
| `OPENFGA_DB_POOL_CONNECTION_TIMEOUT_MS` | `db.pool.connectionTimeoutMs` | non-negative int |
| `OPENFGA_DB_STATEMENT_TIMEOUT_MS` | `db.pool.statementTimeoutMs` | non-negative int |
| `OPENFGA_DB_QUERY_TIMEOUT_MS` | `db.pool.queryTimeoutMs` | non-negative int |
| `OPENFGA_HTTP_ENABLED` | `listeners.http.enabled` | strict-bool (`true`\|`false`, case- and whitespace-tolerant) |
| `OPENFGA_HTTP_PORT` | `listeners.http.port` | int 1..65535 |
| `OPENFGA_HTTPS_PORT` | `listeners.https.port` | int 1..65535 |
| `OPENFGA_TLS_CERT_FILE` | `tls.certFile` | string |
| `OPENFGA_TLS_KEY_FILE` | `tls.keyFile` | string |
| `OPENFGA_MIGRATE_ON_START` | `migrateOnStart` | strict-bool |
| `OPENFGA_AUTH_MODE` | `auth.mode` | enum `none\|preshared\|oidc` |
| `OPENFGA_AUTH_PRESHARED_KEYS` | `auth.presharedKeys` | comma-string → string[] (drops empty entries) |
| `OPENFGA_IDEMPOTENCY_MODE` | `idempotency.mode` | enum `off\|optional\|required` |
| `OPENFGA_IDEMPOTENCY_TTL_MS` | `idempotency.ttlMs` | **positive** int (matches current parser at `src/middleware/idempotency.ts:82-87`; `0` and negatives are fatal) |
| `OPENFGA_AUTH_OIDC_JWKS_CACHE_MAX_AGE_MS` | `auth.oidc.jwksCacheMaxAgeMs` | non-negative int (default 600000); see `docs/features/oidc-auth.md` |
| `OPENFGA_AUTH_OIDC_JWKS_COOLDOWN_MS` | `auth.oidc.jwksCooldownMs` | non-negative int (default 30000); see `docs/features/oidc-auth.md` |
| `OPENFGA_OTEL_EXPORTER_HEADERS` | `otel.exporter.headers` | OTel key=value list (below) |
| `OPENFGA_OTEL_RESOURCE_ATTRIBUTES` | `otel.resource.attributes` | OTel key=value list (below) |
| `OPENFGA_LOG_LEVEL` | `log.level` | enum |
| `OPENFGA_API_URL` | `loadModel.apiUrl` | string |
| `OPENFGA_STORE_NAME` | `loadModel.storeName` | string |
| `OPENFGA_STORE_ID` | `loadModel.storeId` | string |

### Map-valued OpenTelemetry settings

`OPENFGA_OTEL_EXPORTER_HEADERS` and `OPENFGA_OTEL_RESOURCE_ATTRIBUTES` use the OpenTelemetry standard format of `OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_RESOURCE_ATTRIBUTES`: comma-separated `key=value` pairs, for example `authorization=Bearer%20abc,x-team=core`. Keys and values are trimmed, values are percent-decoded, empty entries are ignored, and only the first `=` separates key from value. A malformed entry (no key, or an invalid percent-encoding) fails startup with an error that names the variable and the entry position but never echoes the entry, because headers can carry credentials.

`NODE_EXTRA_CA_CERTS` is read by Node itself, not the application; it remains documented in `.env.example` and is not in the config schema.

## Empty-String Semantics

Today's `.env.example` ships several optional fields with an empty value (`OPENFGA_TLS_CERT_FILE=`, `OPENFGA_TLS_KEY_FILE=`, `OPENFGA_AUTH_PRESHARED_KEYS=`, `OPENFGA_STORE_ID=`). Current call sites treat empty string as "not set" via JS falsy-checks and `?.trim()` patterns (e.g. `src/server.ts:62`, `src/cli/load-model.ts:34`). A naive env-overlay that maps `OPENFGA_TLS_CERT_FILE=""` directly to `tls.certFile: ""` would change behavior — Zod's `z.string().optional()` accepts the empty string as a *set* value, not as missing.

Rules the env-overlay enforces:

- **Optional string fields** (`tls.certFile`, `tls.keyFile`, `loadModel.storeId`): trim the env value; if the result is empty, treat as `undefined` (do not write the path into the merged object).
- **Required string fields** (`db.url`): empty is fatal at storage-init time, matching today's `src/server.ts:44-47` behavior.
- **Comma-separated arrays** (`auth.presharedKeys`): split on `,`, trim each entry, drop empty entries. An overall empty string yields an empty array.
- **Boolean fields** (`OPENFGA_HTTP_ENABLED`, `OPENFGA_MIGRATE_ON_START`): empty is fatal (matches today's strict parsers — only `true` and `false` accepted, case- and whitespace-tolerant).
- **Integer fields read through today's `intFromEnv` helper** (all `OPENFGA_DB_POOL_*`, `OPENFGA_DB_STATEMENT_TIMEOUT_MS`, `OPENFGA_DB_QUERY_TIMEOUT_MS`): empty string is treated as **unset** — falls back to the schema default. Matches `src/storage/pg-internals.ts:32-33` where `v === undefined || v === '' → fallback`. Present-but-non-integer values remain fatal.
- **`OPENFGA_IDEMPOTENCY_TTL_MS`**: empty string is **unset** — falls back to schema default. Matches `src/middleware/idempotency.ts:83-84`. Non-empty values that are not positive integers remain fatal.
- **`OPENFGA_HTTP_PORT` / `OPENFGA_HTTPS_PORT`**: today's parser at `src/server.ts:59-60` is `Number(process.env['OPENFGA_HTTP_PORT'] ?? 8080)`, which means `?? 8080` only triggers when the var is *unset*; an empty string coerces via `Number('')` to `0`. This feature **intentionally tightens** that path: empty string is treated as unset and falls back to the schema default. This is the one place the spec deliberately diverges from observable current behavior because the current behavior (port becomes `0`) is itself a latent bug.

## Merge Precedence

Lowest to highest:

1. Zod schema defaults.
2. `openfga.config.{yaml,toml,...}` base block.
3. `$development` / `$production` / `$test` block matching `NODE_ENV` (selected by c12 via `envName`).
4. `OPENFGA_*` env vars, including those loaded from `.env` by c12's `dotenv: true`.
5. Test-only programmatic overrides applied *after* env-overlay via the in-repo helper documented in §Test Strategy. **Not** c12's `overrides` option — that applies inside `loadConfig` and would be beaten by env-overlay despite the stated ordering.

Arrays are replaced, not concatenated: when a higher-precedence layer sets an array (for example `auth.presharedKeys` or `auth.oidc.subjects`), it replaces the lower layer's array wholesale. Objects merge recursively.

Explicitly disabled c12 layers (locked off via the loader call in §File Discovery): RC files (`.openfgarc`, `~/.openfgarc`), `package.json` `openfga` field. If any of those exist on a contributor's machine they have no effect on this server's runtime configuration.

## Validation Strategy

- Zod schema in `src/config-schema.ts`. `export type Config = z.infer<typeof ConfigSchema>` is the single type source used by all consumers.
- All defaults declared on the Zod schema, not in c12 options. This preserves test isolation: a test that constructs raw config doesn't depend on c12's resolution behavior.
- Boolean and integer parsers reuse the existing strict patterns. The strict-bool parser at `src/storage/migrate-on-start.ts:parseMigrateOnStart` becomes a Zod `transform` reused across all bool fields. The non-negative-int parser at `src/storage/pg-internals.ts:intFromEnv` becomes Zod's `z.coerce.number().int().min(0)` with a custom error message matching the existing format `must be a non-negative integer; got "<value>"`.
- On parse failure: log a structured Zod error tree to stderr via `console.error` (the logger may not be initialized yet), then `process.exit(1)`. Matches existing fail-fast behavior at `src/server.ts:44-47, 89-96`.
- No partial-config tolerance. A config that fails Zod validation refuses to start.

## Loader Implementation Sketch

```ts
// src/config-schema.ts
import { z } from 'zod'

const PoolSchema = z.object({
  max: z.coerce.number().int().min(0).default(10),
  min: z.coerce.number().int().min(0).default(0),
  idleTimeoutMs: z.coerce.number().int().min(0).default(30_000),
  connectionTimeoutMs: z.coerce.number().int().min(0).default(0),
  statementTimeoutMs: z.coerce.number().int().min(0).default(0),
  queryTimeoutMs: z.coerce.number().int().min(0).default(0),
}).default({})

// …other sub-schemas…

export const ConfigSchema = z.object({
  db: z.object({
    // Optional at schema level: load-model CLI runs without it.
    // Storage modules call requireDbUrl() at pool-open time.
    url: z.string().min(1).optional(),
    namespace: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/).default('openfga'),
    applicationName: z.string().default('openfga-node-server'),
    pool: PoolSchema,
  }),
  // …
}).superRefine((cfg, ctx) => {
  // cross-field constraints (HTTP/HTTPS port collision, TLS pair-wise, etc.)
})

export type Config = z.infer<typeof ConfigSchema>

// src/config.ts (side-effectful — only this module calls loadConfig)
import { loadConfig } from 'c12'
import { ConfigSchema, type Config } from './config-schema'
import { applyEnvOverrides } from './config-env-overrides'

const { config: raw } = await loadConfig<unknown>({
  name: 'openfga',
  dotenv: true,
  rcFile: false,
  globalRc: false,
  packageJson: false,
})

const merged = applyEnvOverrides(raw ?? {}, process.env)

const parsed = ConfigSchema.safeParse(merged)
if (!parsed.success) {
  console.error('[openfga] invalid configuration:', parsed.error.format())
  process.exit(1)
}

export const config: Config = parsed.data

// src/storage/db.ts — fail-fast helper preserving today's error wording
export function requireDbUrl(url: string | undefined): string {
  if (!url) {
    throw new Error(
      '[openfga] OPENFGA_DB_URL is not set. Configure it (env var or ' +
      'openfga.config.yaml `db.url`) to point at the database backing ' +
      'the openfga state (see .env.example).',
    )
  }
  return url
}
```

## Call-Site Migration

Authoritative inventory (verified by `grep -rn "process\.env" src/`, not the bead's approximate list):

- `src/server.ts` — DB URL guard, listener config, TLS config, migrate-on-start flag. Also imports `dotenv/config` at L34.
- `src/cli/migrate.ts` — imports `dotenv/config` at L31. Does not directly read `process.env` beyond what dotenv-then-Kysely consumes, but the dotenv import must be removed in lockstep with the dependency drop.
- `src/logger.ts` — log level.
- `src/middleware/auth.ts` — auth mode, preshared keys.
- `src/middleware/idempotency.ts` — mode, TTL (preserving the existing override-via-args pattern used by integration tests; see §Test Strategy for the lazy-eval requirement).
- `src/cli/load-model.ts` — API URL, store id, store name. **Does not need `db.url`**; loads the shared `config` for `loadModel.*` only.
- `src/storage/db.ts` — DB URL, namespace, application name, pool params. Calls `requireDbUrl(config.db.url)` at the entry point that opens the pool.
- `src/storage/migrate-on-start.ts` — migrate-on-start flag.
- `src/storage/pg-internals.ts` — `intFromEnv` helper. Once `db.ts` reads `config.db.pool.*`, this helper has no callers and is deleted along with the file's other env-related logic. The pg type-parser side effects in this module move to `db.ts` (per the file's own comment at L12-13 anticipating this consolidation).

Bead inaccuracies corrected by this spec:

- Bead referenced `src/index.ts`. The bootstrap file is `src/server.ts`.
- Bead referenced `src/storage/pool.ts`. That file does not exist; pool reads live in `src/storage/db.ts`.
- Bead referenced `src/storage/engine-context.ts`. Grep confirms it does not currently read `process.env`.
- Bead omitted `src/middleware/auth.ts` (auth mode + preshared keys).
- Bead omitted `src/storage/pg-internals.ts` (the `intFromEnv` helper that all pool params route through).
- Bead omitted `src/cli/migrate.ts` (which directly imports `dotenv/config` and so blocks the dotenv-removal acceptance criterion).

## Top-Level Await and Bundle Safety

`loadConfig` returns a Promise. Two implementation options:

1. Top-level await in `src/config.ts`. Node 22 supports it; `tsdown` builds with `target: node22` and ESM, which preserves top-level await.
2. Async init function (`initConfig()`) called explicitly from `src/server.ts` before any other module imports `config`.

Default: top-level await. Matches the bead's design field (`'await loadConfig<OpenFGAConfig>(...)'`). Verified bundling outcome in the implementation bead.

Risk to flag in the implementation bead's test plan: any test harness that imports `src/config.ts` for type-only purposes still triggers the loader at module evaluation, and a `process.exit(1)` on parse failure during test discovery would terminate the test process. Mitigations: (a) keep `src/config-schema.ts` (types only) and `src/config.ts` (loader) as separate modules, or (b) gate the exit behind an `import.meta` guard.

## Test Strategy

Module structure for test isolation:

- `src/config-schema.ts` — Zod schema + `Config` type. **No side effects.** Safe to import from any test for type-only or schema-only use.
- `src/config-env-overrides.ts` — pure function `applyEnvOverrides(raw, env): unknown`. No side effects.
- `src/config.ts` — does the `loadConfig` call, env-overlay, parse, and `process.exit(1)` on failure. Side-effectful at module evaluation.

The middleware override-via-args pattern (`idempotencyMiddleware({ mode, ttlMs })` at `src/middleware/idempotency.ts:56`) must remain intact. The factory call itself is what tests invoke; "bypassing" the factory is not the goal. What matters is *what the factory looks up inside its body*.

Required behavior:

1. The middleware factory checks `options.mode` and `options.ttlMs` first. If both are provided explicitly by the caller, the factory returns the middleware without performing any global config lookup.
2. Only when an option is missing does the factory call a lazy `getConfig()` helper to read the corresponding value from the loaded config. `getConfig()` is the indirection that makes the global config lazily-evaluated rather than module-evaluation-time.
3. The middleware module imports types from `src/config-schema.ts` (no side effects) but does **not** statically import the side-effectful `src/config.ts`. The lazy `getConfig()` resolves to `import('./config')` (or equivalent) the first time it is called.

What is not acceptable: a pattern where importing `src/middleware/idempotency.ts` for tests causes `src/config.ts` to evaluate, triggering `loadConfig` + a possible `process.exit(1)` on missing fixtures. The Test Strategy acceptance criteria verifies this with a unit test that imports the middleware module, asserts no side effects fire, then constructs the middleware with explicit args.

Tests:

- Unit tests for `src/config-schema.ts`: each field's default, type coercion, validation error message, cross-field constraints.
- Unit tests for `src/config-env-overrides.ts`: each `OPENFGA_*` env var produces the expected nested path; missing env vars do not clobber file values; empty-string handling per §Empty-String Semantics.
- Unit tests for per-env block selection: `NODE_ENV=development` applies `$development`; `NODE_ENV` unset uses base block only.
- Unit test for `requireDbUrl(config.db.url)` storage helper: throws the same fail-fast error today's `src/server.ts:44-47` produces when the URL is undefined.
- Fixture test: load `tests/fixtures/openfga.config.yaml` with intentional per-env block, assert merged result matches expected typed object.
- Integration tests already drive their config via `OPENFGA_*` env vars (per `.env.example` headers). Confirm those continue to pass with no test code changes — this is the canonical backward-compatibility check.

## .env.example, README, and Example Config

- `.env.example` continues to exist with a header comment pointing at `openfga.config.example.yaml` as the recommended primary surface for non-platform deployments. Env-var-only deployments remain a first-class supported path.
- New `openfga.config.example.yaml` ships at the repo root, mirroring the field set in `.env.example` and demonstrating per-env override blocks.
- `README.md` Configuration section documents both surfaces, the merge precedence, and the env-var-to-config-path mapping table (link to this spec for the canonical table).

## Dependency Changes

- Add: `c12`. Pin to a current minor.
- Add: any peer dependencies c12 requires that are not already present (likely `confbox` for YAML/TOML/JSON5 — c12 declares these; they install transitively).
- Remove: `dotenv` from `dependencies`. c12 handles `.env` loading via `dotenv: true`.
- No change: `zod` is already present at `^4.4.2`.

**Ordering constraint for `dotenv` removal**: `src/server.ts:34` and `src/cli/migrate.ts:31` both currently `import 'dotenv/config'`. Both imports must be removed *before* `dotenv` is dropped from `package.json` (otherwise `pnpm migrate` and the server fail to start with a module-not-found). The implementation bead sequences this as: migrate call-sites first, then remove the dependency in the same commit that lands the c12 loader.

## Acceptance Criteria

- `await loadConfig({ name: 'openfga', dotenv: true })` discovers `openfga.config.{yaml,yml,toml,jsonc,json5,json,ts,js,mjs,cjs}` in CWD. Tests assert at least YAML, TOML, and `.env` integration.
- `src/config-schema.ts` declares the full Zod schema with every field, type, default, and cross-field constraint. `export type Config = z.infer<typeof ConfigSchema>` is the single type source for all consumers in `src/`.
- `src/config.ts` exports `config: Config`. Validation failure exits non-zero with a structured Zod error tree on stderr.
- Every `OPENFGA_*` env var in the override-mapping table produces the documented nested config value when set. Tests assert each row.
- `process.env['OPENFGA_*']` reads no longer appear in `src/` (verified by `grep -rn "process\.env\['OPENFGA_" src/` returning empty). The `NODE_EXTRA_CA_CERTS` reference in comments is acceptable since Node reads it directly.
- No `import 'dotenv/config'` statements remain in `src/` (verified by `grep -rn "'dotenv/config'" src/` returning empty).
- `dotenv` is removed from `package.json` runtime dependencies in the same commit that lands the c12 loader (per §Dependency Changes ordering constraint).
- Loading `src/config-schema.ts` and `src/config-env-overrides.ts` has no side effects. Only `src/config.ts` performs `loadConfig`. Tests that need to bypass file/env discovery import the helpers, not `src/config.ts`.
- The `requireDbUrl(...)` storage helper produces the same fail-fast error message today's `src/server.ts:44-47` does when `OPENFGA_DB_URL` is unset.
- `src/cli/load-model.ts` runs to completion without `db.url` set (verified by a unit test that imports `config` then runs the CLI's `main()` with mocked HTTP and no `OPENFGA_DB_URL` in env).
- All existing unit and integration tests pass without modification.
- Build (`pnpm build`) succeeds with `tsdown` and the bundle performs at most one `loadConfig` call at startup.
- `.env.example` is preserved with a pointer to the new file. `openfga.config.example.yaml` is added at the repo root. `README.md` references both and documents merge precedence.
- The `pg_dump --schema=openfga` migration recipe in PRD §Migration path TO upstream OpenFGA is unaffected.

## Open Questions

- **Top-level await vs explicit `initConfig()`**: chosen as top-level await above. Revisit if the implementation bead surfaces a bundling or test-harness incompatibility.
- **`intFromEnv` helper in `src/storage/pg-internals.ts`**: delete after migration, or keep as a transitional helper? Lean delete; no callers expected to remain.
- **`.env.example` future**: keep both surfaces long-term, or deprecate `.env.example` once the file-based path is mature? Lean keep both; env-var-only deployments are a real platform pattern. Decide later in a separate bead if anything changes.
- **Where to invoke `requireDbUrl()`**: at the first call to `getEngineContext()` (which is what each route uses to acquire the pool), or higher up at server bootstrap? Lean inside the engine-context lazy getter so the load-model CLI doesn't trip it.
