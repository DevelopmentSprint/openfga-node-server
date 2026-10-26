# openfga-node-server — Guiding PRD

## Why this project exists

The OpenFGA ecosystem has the upstream Go reference server, the cloud
hosted offering (Auth0 FGA / openfga.cloud), and not much else for
Node. Many serverless deployment targets (Vercel, Cloud Run as a
single image, smaller PaaS platforms) cannot run the Go binary
natively as a sidecar, and the managed offerings aren't always the
right shape (cost, data residency, latency, vendor preference).

This project fills that gap: an OpenFGA-wire-compatible authorization
server in Node, runnable anywhere Node runs.

## Non-goals

- Replacing the OpenFGA reference server in performance-critical
  deployments. The reference Go server has years of optimization on
  the rewrite-algebra hot path; we have straight DFS. If your check
  QPS or model depth pushes those limits, run the Go binary.
- Experimental dynamic conditions (request-supplied CEL expressions).
  Standard model-defined conditional tuples are approved scope below.

## Design principles

1. **Wire-compatible byte-for-byte.** The HTTP request and response
   shapes match the OpenFGA REST API. `@openfga/sdk` clients work
   unchanged.
2. **Portable storage with explicit upstream conversion.** NodeFGA uses
   its own Postgres/SQLite schema. Migration to OpenFGA requires a tested
   conversion or API export/import process; direct dump/restore is not
   supported. Wire compatibility does not imply physical schema parity.
3. **Boundary-thin core.** The evaluator depends on a `TupleStore`
   interface, not on Postgres directly. Unit tests drive the
   evaluator with an in-memory store; the production wiring uses pg.
   This is what made the original extraction from a Nitro module
   into this standalone project mechanical.
4. **No startup magic.** The server does not auto-load a model on
   boot. Models are written via the regular write-model endpoint,
   same as the OpenFGA reference server. A small `load-model` CLI is
   provided for first-time setup.

## Scope (current)

### Endpoints

Target: full OpenFGA REST API wire compliance for the supported
authorization model and storage semantics. Implemented endpoints must
match OpenFGA request and response shapes so `@openfga/sdk` clients work
unchanged.

Currently implemented:

- `GET /stores` (cursor-paginated)
- `POST /stores`
- `{POST,GET} /stores/:storeId/authorization-models`
- `GET /stores/:storeId/authorization-models/:id`
- `POST /stores/:storeId/check` (with `contextual_tuples`)
- `POST /stores/:storeId/write` (transactional, records changelog)
- `POST /stores/:storeId/read` (cursor-paginated)
- `POST /stores/:storeId/list-objects` (with `contextual_tuples`)
- `POST /stores/:storeId/expand` (with `contextual_tuples`)
- `POST /stores/:storeId/batch-check` (per-item `contextual_tuples`,
  results keyed by `correlation_id`)
- `POST /stores/:storeId/list-users` (userset memberships expanded
  when `user_filter` targets the underlying user type)
- `GET /stores/:storeId/changes` (oldest-first, polling-tail tokens,
  `?type=` and `?start_time=` filters)
- `{GET,PUT} /stores/:storeId/assertions/:authorizationModelId`
- `GET /health` (auth-exempt liveness probe)
- `GET /ready` (auth-exempt readiness probe — `200 ok` only when the
  database is reachable and the configured namespace has the expected
  schema; `503` with a generic `reason` otherwise)

The full OpenFGA REST wire-compliance epic (`openfga-68n`) closed
with all seven endpoint children shipped (`openfga-7ct`,
`openfga-rvz`, `openfga-5xn`, `openfga-rae`, `openfga-bh9`,
`openfga-hqr`) plus a `@openfga/sdk` conformance suite
(`openfga-don`) that exercises every endpoint via the high-level
`OpenFgaClient` over real HTTP and asserts no in-scope endpoint
returns `501`.

Cross-cutting OpenFGA-aligned features tracked separately:

- `openfga-371` — OpenTelemetry HTTP instrumentation (see §OpenTelemetry observability)
- `openfga-711` — OIDC authentication mode (`none` and `preshared`
  modes shipped under `openfga-ywi`; OIDC layers onto the same
  middleware dispatch — see §API caller authentication)

### Conditional tuples

Support standard OpenFGA model-defined CEL conditions on stored and
contextual relationship tuples, including typed parameters, stored tuple
context, and request context. Evaluate them consistently in Check,
BatchCheck, ListObjects, and ListUsers. Preserve condition metadata through
Write, Read, and ReadChanges. Missing or invalid evaluation inputs must
follow upstream error semantics rather than silently grant access.

The requirements, runtime design, and compatibility limits are in
[`docs/features/conditional-tuples.md`](features/conditional-tuples.md).
The focused reference tests do not establish complete upstream conformance.

### Evaluation algebra

The check evaluator implements the full OpenFGA rewrite-rule set:

- `this` — direct relation. Tuples can be direct user refs
  (`user:<id>`), userset refs (`<type>:<id>#<relation>`), or typed
  wildcards (`<type>:*`).
- `computedUserset` — alias another relation on the same object.
- `tupleToUserset` — "X from Y" — for each tuple via Y, evaluate X.
- `union`, `intersection`, `difference`.

`list-objects` is a forward-walk reverse expansion that filters
candidates through `check()` to preserve correctness across
intersections and differences.

### Storage

The storage layer is engine-agnostic, routed through Kysely. Two
backends are supported and selected by the scheme of `OPENFGA_DB_URL`:

- **Postgres** (`postgres://` / `postgresql://`) — production-
  recommended. Tables live under the configured namespace
  (`OPENFGA_DB_NAMESPACE`, default `openfga`) which is realized as a
  Postgres schema. RLS is enabled with no policies — direct queries
  from a non-service role are blocked at the database, on top of the
  application-level boundary discipline.
- **SQLite** (`sqlite:` / `file:` / `:memory:`) — test backend and
  embedded-deployment option. Tables live under the configured
  namespace which is realized as a table-name prefix (e.g.
  `openfga_store`). RLS is unavailable; concurrency is single-writer.

Tables: `store`, `authorization_model`, `tuple`. Composite primary
key on `tuple` serves as natural deduplication. Indexes on
`(store_id, user_str, relation)` and
`(store_id, object_type, relation, user_str)` cover the two read
patterns the evaluator uses.

The full architectural decisions, dialect-portability hot spots, and
phasing are in
[`docs/features/db-agnosticism.md`](features/db-agnosticism.md).

Self-hosted boots may opt into running migrations against the
configured `OPENFGA_DB_URL` before binding sockets by setting
`OPENFGA_MIGRATE_ON_START=true`. Default is `false`. The flag lives
only in the self-host path (`src/server.ts`) and is intentionally not
applied by `src/index.ts`, which is the Hono app file imported by
serverless platforms. Serverless and multi-instance deployments
should leave it disabled and continue running `pnpm migrate` as an
explicit deploy step — concurrent boots correctly serialize on
`kysely_migration_lock` (the Migrator's advisory lock), but every
queued boot still pays the wait on the request-serving hot path.

### API caller authentication

The server supports OpenFGA-aligned API caller authentication modes:

- `none` — default for private-network deployments where the server is
  protected by platform, service mesh, or reverse-proxy controls.
- `shared_key` — bearer-token authentication for deployments that need
  a simple static credential at the API boundary.
- `oidc` — JWT/OIDC validation for deployments that need issuer,
  audience, and key-set based verification.

Authentication is enforced at the HTTP middleware boundary and must not
change OpenFGA request or response shapes for authorized calls.

### Idempotency keys

The server supports the `Idempotency-Key` HTTP header for mutating API
requests so clients can safely retry requests after timeouts, network
failures, or ambiguous connection resets.

Idempotency is enforced at the HTTP middleware boundary for configured
mutating endpoints. It must not change successful OpenFGA response
shapes. Idempotency persistence lives alongside the OpenFGA tables in
the configured namespace (`OPENFGA_DB_NAMESPACE`, default `openfga`)
for operational simplicity. Operational data is not part of the upstream
migration contract; see §Migration path FROM this server TO upstream OpenFGA.

### OpenTelemetry observability

The server supports OpenTelemetry tracing at the HTTP middleware
boundary. Tracing must respect incoming OpenTelemetry propagation
headers so this server can participate in traces that started upstream.

The default captured request headers must include the standard
propagation headers `traceparent`, `tracestate`, and `baggage`.
Operators can override captured request headers, captured response
headers, service metadata, exporter configuration, and related
OpenTelemetry settings through environment variables.

## Operational shape

- Single Node process. No external service dependencies beyond the
  configured database (Postgres or SQLite).
- **Postgres backend**: connects as a service-role / superuser to
  bypass RLS. Other applications sharing the same Postgres instance
  must use a different role. Connection pooling via `pg.Pool` with
  conservative defaults (max 10, idle timeout 30s). Stateless above
  the database — horizontal scaling works without coordination.
- **SQLite backend**: single-process, single-writer. WAL journal mode
  is enabled by default for non-`:memory:` paths. Suitable for tests,
  embedded deployments, and small single-node SaaS; not for
  multi-instance production. The pool-tuning environment variables
  are ignored on this backend. Horizontal scaling is not available.

## Migration path FROM this server TO upstream OpenFGA

NodeFGA's physical schema and serialization differ from upstream OpenFGA.
A direct Postgres dump/restore is unsupported on either backend.

Migration must use an explicit converter or API export/import workflow,
verified against a pinned upstream release before it is advertised as supported.
It must preserve model definitions, tuple conditions and context, assertions,
and authorization outcomes, and produce mappings for changed store/model IDs.
Operational data and historical changelog/idempotency records are not imported
as live authorization state. Consumers must use the resulting IDs and endpoint.

Acceptance requires export/import tests from both Postgres and SQLite, counts
and payload comparisons, and representative Check/ListObjects/ListUsers results
on source and destination. No converter has yet been delivered or validated.
This is a required future migration contract, not an executable migration recipe.

## Future scope (non-binding)

- Experimental dynamic conditions beyond standard model-defined conditions.
- Caching layer in front of `check` (the upstream server has one).
- A reverse-expansion algorithm for `list-objects` that doesn't fall
  back to per-candidate `check()`.

## Out of scope

- Hosted / managed offering of this server.
