# OpenTelemetry Observability

## Status

Proposed.

## Source of Truth

- PRD: `docs/PRD.md` §"OpenTelemetry observability" (L174-184).
- HTTP middleware: `@hono/otel` for the request-response boundary.
- Internal-boundary spans: `@opentelemetry/api` `tracer.startActiveSpan` wrapped in a thin in-repo helper.
- SDK: `@opentelemetry/sdk-node` + the trace OTLP exporters; standard `OTEL_*` env vars apply.
- Propagation: W3C Trace Context + W3C Baggage.

## Business Intent

Deployments need request traces that connect this authorization server to upstream application traffic AND illuminate where time goes inside the server when a check is slow. The HTTP-only instrumentation that this spec originally proposed answered the first need but not the second — a 300ms `check` request showed up as one 300ms span with no breakdown.

This feature instruments at every internal AND external API boundary: HTTP request handling, auth, idempotency, evaluator entry points (check, expand, list-objects, list-users, batch-check), and storage reads / writes / changelog. Each boundary is a separate granular knob in configuration so operators can turn off categories whose signal volume isn't worth the cost.

OpenTelemetry is **off by default**. Enabling it must not change OpenFGA request or response shapes for authorized calls. Every configuration lever is surfaced via the c12 + Zod schema landed under openfga-iie.

## Goals

- **Off by default**. `config.otel.enabled = false` leaves runtime behavior identical to today; the SDK is not imported at all in that path.
- **External boundary**: install `@hono/otel` to trace the Hono request-response lifecycle. Respect incoming W3C `traceparent` / `tracestate` / `baggage`.
- **Internal boundaries**: wrap evaluator entry points (check, expand, listObjects, listUsers, batchCheck), storage entry points (read tuples, write tuples, list changes, load model index, store CRUD, assertion CRUD), and middleware decisions (auth dispatch outcome, idempotency claim/complete/release) with named spans carrying boundary-specific attributes.
- **Per-boundary knobs**. `config.otel.spans.{http,evaluator,storage,auth,idempotency}` independently gates each category so an operator can keep HTTP spans on while turning off the storage-layer firehose.
- **Configurable exporter**. OTLP-HTTP (default when enabled), OTLP-gRPC, and console exporters. Endpoint, headers, and timeout are surfaced via config; standard `OTEL_*` env vars work too.
- **Configurable sampler**. `always_on` (default), `always_off`, `parentbased_always_on`, `traceidratio`, `parentbased_traceidratio`. Sampler ratio is configurable.
- **Configurable propagators**. Defaults to `tracecontext` + `baggage`. Operators can opt in to additional propagators.
- **Configurable header capture**. Request defaults to `traceparent` / `tracestate` / `baggage`. Response defaults to empty. Sensitive headers (`authorization`, `cookie`, etc.) explicitly rejected at config-load if listed in capture.
- **Bundle hygiene**. The OTel SDK and its transitive deps are dynamic-imported only when `config.otel.enabled === true`, so the disabled-mode build/start path is unchanged.

## Non-Goals

- **No metrics**. This feature ships traces only. A future bead may add a metrics pipeline using the same SDK plumbing.
- **No log signal export**. This feature does not pipe pino logs into the OTel logs pipeline. Existing structured logging stays as the canonical low-cardinality operational log.
- **No automatic instrumentation packages**. `@opentelemetry/auto-instrumentations-node` is not used — we want the spans we emit to be intentional, scoped to our boundaries, and named consistently. Auto-instrumenting `pg`, `node:http`, and friends would produce noise that competes with the in-repo spans.
- **No span-attribute capture of OpenFGA tuple data by default**. Spans carry route, store id, model id, and counts — not user identifiers, relations, or object refs — unless the operator opts in. Tuple data is potentially sensitive (PII-adjacent in many deployments).
- **No PRD changes**. PRD §"OpenTelemetry observability" already names the surface; this feature implements it.

## Configuration Surface

Extends `openfga.config.yaml` with a top-level `otel` section:

```yaml
otel:
  # Master switch. Off by default. When false, the SDK is never
  # imported and no spans are emitted.
  enabled: false

  service:
    # Reported as service.name in resource attributes. Default:
    # 'openfga-node-server'.
    name: openfga-node-server
    # Reported as service.version. Defaults to package.json version
    # when unset.
    version: ''

  resource:
    # Additional resource attributes (key→string). Merged on top of
    # service.name/version. Use for environment, region, etc.
    attributes: {}

  exporter:
    # otlp-http (default) | otlp-grpc | console | none
    # 'none' samples and builds spans but drops them on export; nothing
    # is retained in memory.
    type: otlp-http
    # OTLP endpoint URL. Falls back to OTEL_EXPORTER_OTLP_ENDPOINT or
    # OTEL_EXPORTER_OTLP_TRACES_ENDPOINT when unset.
    endpoint: ''
    # Static headers attached to OTLP exports (e.g. for auth tokens).
    # Falls back to OTEL_EXPORTER_OTLP_HEADERS when unset.
    headers: {}
    # Timeout per export request, in milliseconds.
    timeoutMs: 10000

  propagators:
    # W3C defaults. Other supported values: 'b3', 'b3multi',
    # 'jaeger', 'ottrace'.
    - tracecontext
    - baggage

  sampler:
    # always_on (default) | always_off | parentbased_always_on |
    # traceidratio | parentbased_traceidratio
    type: always_on
    # Used by traceidratio and parentbased_traceidratio. 0.0-1.0.
    ratio: 1.0

  capture:
    # Captured request headers (recorded as span attributes).
    requestHeaders: [traceparent, tracestate, baggage]
    # Captured response headers. Default: empty.
    responseHeaders: []

  # Per-boundary span gates. All default true when otel.enabled is
  # true. Setting any to false suppresses that boundary's spans.
  spans:
    http: true          # External boundary — Hono request lifecycle.
    evaluator: true     # Internal — check, expand, list_objects,
                        # list_users, batch_check.
    storage: true       # Internal — every TupleStore + storage
                        # operation (read, write, list_changes,
                        # load_model_index, stores, assertions).
    auth: true          # Internal — auth dispatch outcome span.
    idempotency: true   # Internal — claim/complete/release/replay.
```

## Shutdown

The SDK is shut down (flushing pending spans) as one step of the server's graceful shutdown on `SIGTERM` or `SIGINT`, after listeners drain and before the database pool closes. The OTel module installs no signal handlers of its own. A second signal forces an immediate exit.

## Env-Var Override Mapping

Every `OPENFGA_OTEL_*` variable maps onto the nested config path. The `OTEL_*` standard variables continue to be honored by the SDK natively (we don't re-read them) and are documented here for operator convenience.

| Env var | Config path |
|---|---|
| `OPENFGA_OTEL_ENABLED` | `otel.enabled` |
| `OPENFGA_OTEL_SERVICE_NAME` | `otel.service.name` |
| `OPENFGA_OTEL_SERVICE_VERSION` | `otel.service.version` |
| `OPENFGA_OTEL_EXPORTER_TYPE` | `otel.exporter.type` |
| `OPENFGA_OTEL_EXPORTER_ENDPOINT` | `otel.exporter.endpoint` |
| `OPENFGA_OTEL_EXPORTER_TIMEOUT_MS` | `otel.exporter.timeoutMs` |
| `OPENFGA_OTEL_EXPORTER_HEADERS` | `otel.exporter.headers` (OTel `key=value` list) |
| `OPENFGA_OTEL_RESOURCE_ATTRIBUTES` | `otel.resource.attributes` (OTel `key=value` list) |
| `OPENFGA_OTEL_PROPAGATORS` | `otel.propagators` (comma-string → string[]) |
| `OPENFGA_OTEL_SAMPLER_TYPE` | `otel.sampler.type` |
| `OPENFGA_OTEL_SAMPLER_RATIO` | `otel.sampler.ratio` |
| `OPENFGA_OTEL_CAPTURE_REQUEST_HEADERS` | `otel.capture.requestHeaders` (comma-string → string[]) |
| `OPENFGA_OTEL_CAPTURE_RESPONSE_HEADERS` | `otel.capture.responseHeaders` (comma-string → string[]) |
| `OPENFGA_OTEL_SPANS_HTTP` | `otel.spans.http` |
| `OPENFGA_OTEL_SPANS_EVALUATOR` | `otel.spans.evaluator` |
| `OPENFGA_OTEL_SPANS_STORAGE` | `otel.spans.storage` |
| `OPENFGA_OTEL_SPANS_AUTH` | `otel.spans.auth` |
| `OPENFGA_OTEL_SPANS_IDEMPOTENCY` | `otel.spans.idempotency` |

`OPENFGA_OTEL_EXPORTER_HEADERS` (`otel.exporter.headers`) and `OPENFGA_OTEL_RESOURCE_ATTRIBUTES` (`otel.resource.attributes`) are the project-specific counterparts of `OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_RESOURCE_ATTRIBUTES` and use the same format: comma-separated `key=value` pairs, values percent-decoded. A malformed entry fails startup with an error that names the variable and entry position but never echoes the value (headers can carry credentials). See `docs/features/configuration.md`.

Standard `OTEL_*` env vars (honored by the SDK directly): `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_PROPAGATORS`, `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG`. When both project-specific and standard variables target the same setting, the project-specific value wins.

## Span Catalog

Span names follow `openfga.<boundary>.<operation>` with attributes carrying boundary-specific context. Sensitive fields (tuple users, relations, raw bodies) are NOT captured.

**External (`otel.spans.http`):** `@hono/otel` emits the root server span per request with route, method, status code, and configured captured headers as attributes.

**Internal — evaluator (`otel.spans.evaluator`):**

| Span name | Attributes |
|---|---|
| `openfga.evaluator.check` | `openfga.store_id`, `openfga.model_id`, `openfga.allowed` (boolean) |
| `openfga.evaluator.expand` | `openfga.store_id`, `openfga.model_id`, `openfga.object_type`, `openfga.relation` |
| `openfga.evaluator.list_objects` | `openfga.store_id`, `openfga.model_id`, `openfga.type`, `openfga.relation`, `openfga.result_count` |
| `openfga.evaluator.list_users` | `openfga.store_id`, `openfga.model_id`, `openfga.object_type`, `openfga.relation`, `openfga.result_count` |
| `openfga.evaluator.batch_check` | `openfga.store_id`, `openfga.model_id`, `openfga.batch_size` |

**Internal — storage (`otel.spans.storage`):**

| Span name | Attributes |
|---|---|
| `openfga.storage.read_tuples` | `openfga.store_id`, `openfga.page_size`, `openfga.result_count` |
| `openfga.storage.apply_tuple_mutations` | `openfga.store_id`, `openfga.write_count`, `openfga.delete_count` |
| `openfga.storage.list_changes` | `openfga.store_id`, `openfga.page_size`, `openfga.result_count` |
| `openfga.storage.load_model_index` | `openfga.store_id`, `openfga.model_id` |
| `openfga.storage.list_users_for_relation` | `openfga.store_id` (no relation or object IDs by default) |

**Internal — middleware (`otel.spans.auth`, `otel.spans.idempotency`):**

| Span name | Attributes |
|---|---|
| `openfga.auth.dispatch` | `openfga.auth_mode` (`none`/`preshared`/`oidc`), `openfga.auth_outcome` (`allow`/`reject:<reason>`) |
| `openfga.idempotency.claim` | `openfga.idempotency_mode`, `openfga.scope_path` |
| `openfga.idempotency.complete` | `openfga.scope_path` |
| `openfga.idempotency.replay` | `openfga.scope_path`, `openfga.replay_status` |

## Validation Strategy

- `config.otel.enabled = false` (default) means the SDK is never imported. `src/observability/otel.ts` exports a `traced()` helper whose body is a synchronous pass-through when disabled — no span allocation, no attribute building.
- When enabled, the SDK is initialized in `src/server.ts` before listeners bind, similar to the OIDC discovery pre-fetch pattern. SDK init failures (bad exporter URL, invalid sampler type) are fatal at boot.
- The `traced()` helper takes the boundary category as its first argument and checks `config.otel.spans.{category}` to decide whether to emit. Disabling a category is zero-cost at the call site — the helper short-circuits to the wrapped function without span construction.
- Sensitive-header capture rejection happens at Zod parse: a `capture.requestHeaders` or `capture.responseHeaders` entry matching one of the rejection-list values causes a config-load error. Rejection list: `authorization`, `cookie`, `set-cookie`, `proxy-authorization`, `x-api-key`, `idempotency-key`.

## Middleware Ordering

Recommended order in `src/routes/index.ts` (when `otel.enabled = true` and `otel.spans.http = true`):

1. `otelMiddleware()` — wraps everything below in the request span.
2. `requestLog` — structured log per request.
3. `authMiddleware` — `/stores/*` scope.
4. `requireStore` — `/stores/:storeId/*` scope.
5. `idempotencyMiddleware` — configured scopes.
6. Route handlers.

This places the OTel server span as the parent of every subsequent decision so an auth rejection or idempotency replay still produces a parent span carrying the route + status code.

## Test Strategy

- Unit tests for `src/observability/otel.ts`:
  - `traced()` is a pass-through when `otel.enabled = false` — no SDK imports trigger.
  - `traced()` emits a span with the expected name + attributes when enabled.
  - Per-category gating: setting `otel.spans.evaluator = false` makes evaluator `traced()` calls pass-through even when `otel.enabled = true`.
- Unit tests for `src/config-schema.ts` OTel additions:
  - Capture list with a sensitive header rejected at parse.
  - Unknown exporter type / sampler type rejected at parse.
  - Default state parses with `otel.enabled = false`.
- Integration test for HTTP boundary:
  - With OTel enabled and a `console` exporter, a request to `/stores` produces a recorded span with the route attribute.
  - Incoming `traceparent` is observed (verified by inspecting the recorded span's trace id).
- Unit tests for span emission at evaluator + storage boundaries (using an in-memory `InMemorySpanExporter`).

## Dependency Changes

- Add (when OTel is enabled): `@opentelemetry/api`, `@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/exporter-trace-otlp-grpc`, `@opentelemetry/resources`, `@opentelemetry/semantic-conventions`, `@hono/otel`.
- These are static `dependencies` in `package.json` but only `import()`-ed dynamically from `src/observability/otel.ts` when `config.otel.enabled === true`. The disabled path doesn't load them.

## Acceptance Criteria

- `config.otel.enabled = false` preserves current runtime behavior (no SDK init, no spans emitted, no perf regression).
- `config.otel.enabled = true` initializes the SDK before binding listeners; SDK init failure is FATAL.
- HTTP boundary: `@hono/otel` is installed when `otel.enabled && otel.spans.http`. Incoming `traceparent` / `tracestate` continue upstream traces.
- Every span name in the Span Catalog is emitted when its category is enabled.
- Every category gate (`otel.spans.{http,evaluator,storage,auth,idempotency}`) independently suppresses its category's spans.
- Sensitive headers cannot be added to the capture list — Zod rejects at config-load.
- Every config field documented in §Configuration Surface is reachable via `OPENFGA_OTEL_*` env-var overrides per §Env-Var Override Mapping.
- Unit tests cover the schema, the `traced()` helper's enabled/disabled paths, and per-category gating.
- Integration test verifies the HTTP boundary emits the expected span via an in-process exporter and that incoming `traceparent` is honored.
- `openfga.config.example.yaml`, `.env.example`, and `README.md` are updated.

## Open Questions

- **Console exporter for dev**: shipped under `exporter.type: console`. Done.
- **`/health` exclusion**: spans on `/health` are noisy. Decision: `@hono/otel` instruments all routes; operators can exclude via `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` filtering or sampling. Revisit if this becomes a real-world ops pain point.
- **Tuple-data attribute capture**: not captured by default for privacy. Future operator-opt-in flag (`otel.capture.tupleAttributes = true`) could be added if a customer needs it. Out of scope here.
- **`@opentelemetry/sdk-node` 0.x versioning**: the JS SDK has not yet shipped a 1.0 for `sdk-node`; the API package IS 1.x stable. The 0.x stream is the project's published stable. Pin to a current minor and bump deliberately.
