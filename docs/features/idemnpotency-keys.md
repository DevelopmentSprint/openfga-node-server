# Idempotency Keys

## Status

Proposed.

## Source of Truth

- PRD: `docs/PRD.md`, "Idempotency keys".
- External protocol: `Idempotency-Key` HTTP header behavior from the IETF HTTPAPI draft, as implemented by `idempot-js`.
- Implementation candidate: `idempot-js` Hono middleware with a persistent store.

## Business Intent

Clients call OpenFGA write-style endpoints during request handling, setup flows, and deployment automation. These clients can retry after timeouts, dropped connections, or ambiguous responses. Without idempotency, a retry can create duplicate stores or authorization models, or can apply the same mutating operation more than once.

The server should support client-provided idempotency keys for mutating requests. A repeated request with the same key and same fingerprint should return the original response. A repeated request with the same key and a different fingerprint should be rejected.

## Goals

- Support the `Idempotency-Key` header for configured mutating endpoints.
- Preserve existing OpenFGA response bodies for successful first requests and replayed successful requests. Only 2xx responses are persisted and replayed.
- Use persistent idempotency storage so retry protection survives process restarts and horizontal scaling.
- Persist idempotency state in the `openfga` schema with a documented `pg_dump --exclude-table` recipe so the migration path to upstream OpenFGA is preserved operationally rather than by schema isolation.
- Make rollout configurable so existing clients are not broken by default.

## Non-Goals

- Do not add idempotency to evaluator internals or storage repositories.
- Do not require idempotency keys for read-style endpoints by default.
- Do not generate idempotency keys for clients.
- Do not couple idempotency persistence to OpenFGA wire shapes or evaluator state. The idempotency table lives alongside the OpenFGA tables in the same schema for operational simplicity, but it is not part of the OpenFGA-compatible state contract and must be excluded from schema dumps that target upstream migration.

## Endpoint Scope

Idempotency applies to mutating endpoints:

- `POST /stores`
- `POST /stores/:storeId/authorization-models`
- `POST /stores/:storeId/write`

Idempotency does not apply by default to read-style POST endpoints:

- `POST /stores/:storeId/check`
- `POST /stores/:storeId/read`
- `POST /stores/:storeId/list-objects`

If a future endpoint mutates persistent state, it must explicitly decide whether idempotency applies before implementation.

## Configuration

Use a mode switch rather than a boolean so rollout behavior is explicit:

- `OPENFGA_IDEMPOTENCY_MODE=off` disables idempotency. This is the default.
- `OPENFGA_IDEMPOTENCY_MODE=optional` enables idempotency when a request includes `Idempotency-Key`, but permits requests without a key.
- `OPENFGA_IDEMPOTENCY_MODE=required` requires `Idempotency-Key` on scoped mutating endpoints.

Additional configuration:

- `OPENFGA_IDEMPOTENCY_TTL_MS` sets record retention. The default is 24 hours (`86400000`) unless this project chooses a different value.
- The Postgres backing store reuses `OPENFGA_DB_URL` and writes to `openfga.idempotency_keys` in the same `openfga` schema as the OpenFGA tables. Operators cutting over to upstream OpenFGA must run `pg_dump --schema=openfga --exclude-table='openfga.idempotency_keys'` so the dump only carries OpenFGA-compatible state. The README quick-start and the migration recipe in the PRD document this requirement.
- Future backing stores (for example Redis) may be added behind a configuration switch, but the v1 implementation is Postgres-only and does not introduce a store-selector environment variable until a second store actually exists.

## Middleware Ordering

Authentication must run before idempotency. Unauthorized requests must not create, replay, or inspect idempotency records.

## Caller Scoping

Keys are scoped to the authenticated caller (principal). The stored key is a SHA-256 of the JSON-encoded pair `[principal, Idempotency-Key]`, so the raw client key is never persisted and two callers that choose the same `Idempotency-Key` never replay, conflict with, or probe each other's records. The principal is set by the auth middleware:

- Preshared-key mode: a SHA-256 digest of the matched key (stable across configuration reordering; the key itself is never stored).
- OIDC mode: the token's `sub` and client (`client_id`, falling back to `azp`).
- Auth mode `none`: a single constant anonymous principal.

The `Idempotency-Key` header is trimmed and must be at most 255 characters; a longer key is rejected with `400` before any record is created.

Request logging should continue to record method, path, status, and duration. It must not log idempotency keys.

Idempotency middleware should run before route handlers for scoped mutating endpoints. Route handlers should not need to know whether a response is original or replayed unless the selected middleware exposes response headers that are safe and useful to clients.

## Storage

Idempotency requires persistent storage. In-memory storage is not acceptable for production because it does not survive process restarts and cannot coordinate horizontally scaled instances.

The v1 backing store is the same Postgres database the OpenFGA tables live in. The idempotency table is created in the `openfga` schema as `openfga.idempotency_keys`. The migration that creates it lives in `migrations/` alongside the OpenFGA migration so a single `pnpm migrate up` brings the database to a working state.

The in-flight claim token is stored in its own nullable `claim_token` column of `idempotency_keys`; `response_status` holds only a real HTTP status.

The `openfga` schema must remain a faithful subset of the upstream OpenFGA reference schema so `pg_dump --schema=openfga` produces a valid migration source. The idempotency table is not part of the OpenFGA-compatible state contract. To preserve the migration path, operators run `pg_dump --schema=openfga --exclude-table='openfga.idempotency_keys'` when cutting over to upstream OpenFGA. The PRD documents this recipe in §"Migration path FROM this server TO upstream OpenFGA" or in §"Idempotency keys".

The implementation must not add other non-OpenFGA tables to the `openfga` schema. The `idempotency_keys` table is the single intentional exception, justified by operational simplicity and the documented `--exclude-table` workflow. Any future non-OpenFGA persistence (for example a feature flag table or a webhook queue) must use a different schema.

## Request Fingerprint

The request fingerprint must include at least:

- HTTP method.
- Route path.
- Request body.

The method and the concrete request path (not the route pattern) are hashed, so the same key reused against two stores does not replay across stores. The fingerprint may exclude non-semantic fields only when there is a documented use case. The initial implementation should not exclude fields by default.

## Expected Behavior

When idempotency is off:

- Requests behave as they do today.

When idempotency is optional:

- Requests without `Idempotency-Key` behave as they do today.
- Requests with a new key process normally and persist the response if it is 2xx.
- Requests with the same key and same fingerprint return the persisted response.
- A response that is not 2xx (4xx or 5xx), or a handler that throws, releases the key: nothing is persisted, and a retry with the same key re-runs the request instead of replaying a cached failure.
- An empty original body (for example `204`) is stored as empty and replays as an empty body with the original status.
- A key that stays in flight for longer than the 5-minute in-flight lease (its owner crashed or hung) becomes reclaimable by a later request. Completing or releasing a claim only affects the row the claiming request owns, so a request whose lease expired cannot overwrite the new owner's record.
- Requests with the same key and a different fingerprint return a client error.
- Concurrent requests with the same key return a conflict while the first request is still processing.

When idempotency is required:

- Scoped mutating requests without `Idempotency-Key` return a client error before the route handler runs.
- Scoped mutating requests with invalid keys return a client error before the route handler runs.

## Error Semantics

The implementation should follow the middleware's IETF-compliant behavior unless it conflicts with this project's established error envelope:

- Missing required key: `400`.
- Same key with different fingerprint: `422`.
- Concurrent request with same key while the original is processing: `409`.
- Idempotency store unavailable after retries or an open circuit: `503`.

Errors must be client-safe and must not include raw idempotency keys, database details, or secret configuration values.

## Observability

The server should expose enough structured logging to diagnose idempotency behavior without leaking keys:

- Whether idempotency was disabled, optional, or required.
- Whether a scoped request was original, replayed, rejected for conflict, or rejected for fingerprint mismatch.
- Store failure and circuit-breaker events, if exposed by the middleware.

Logs must avoid raw `Idempotency-Key` values. If correlation is needed, log a stable hash of the key.

## Acceptance Criteria

- The PRD includes idempotency-key support in current scope.
- A configured mutating endpoint can replay the original response for the same `Idempotency-Key` and same request fingerprint.
- Reusing a key with a different request fingerprint returns `422`.
- Non-2xx responses and thrown handlers are not persisted; a retry re-runs the request.
- A key used by one authenticated caller is invisible to another caller.
- An `Idempotency-Key` longer than 255 characters returns `400`.
- Concurrent requests with the same key return `409` for the later request while the first is still processing.
- Required mode rejects scoped mutating requests that omit `Idempotency-Key`.
- Optional mode permits requests without `Idempotency-Key`.
- Read-style POST endpoints are not subject to idempotency by default.
- Idempotency records persist in the `openfga` schema in a dedicated `openfga.idempotency_keys` table that is separate from any OpenFGA table.
- The migration recipe `pg_dump --schema=openfga --exclude-table='openfga.idempotency_keys'` is documented in the PRD or feature spec so operators can migrate to upstream OpenFGA without carrying idempotency state.
- Tests cover off, optional, and required modes.
- Documentation describes configuration, endpoint scope, storage requirements, and retention.

## Open Questions

- Should `/stores` require idempotency in production when idempotency is enabled, or should all scoped endpoints share the same mode?
- Should replayed responses include idempotency status headers if the middleware provides them?
