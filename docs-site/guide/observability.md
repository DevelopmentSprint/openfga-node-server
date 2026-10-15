# Observability — OpenTelemetry Tracing

NodeFGA ships first-class OpenTelemetry tracing at
every internal and external API boundary. It's **off by default**.
When you turn it on, the SDK initializes at boot — before listeners
bind — and spans emit through any exporter you configure.

## Quick start

```yaml
otel:
  enabled: true
  exporter:
    type: otlp-http
    endpoint: http://collector.internal:4318/v1/traces
```

Or via env vars:

```sh
OPENFGA_OTEL_ENABLED=true
OPENFGA_OTEL_EXPORTER_TYPE=otlp-http
OPENFGA_OTEL_EXPORTER_ENDPOINT=http://collector.internal:4318/v1/traces
```

The server starts; the first request through `/stores/*` emits a
parent span carrying the route attributes, and every internal
boundary (evaluator, storage) shows up as a child span underneath.

## What gets traced

Five **boundary categories**, each independently gateable:

| Category | What it traces |
|---|---|
| `http` | The Hono request lifecycle. Picks up incoming W3C `traceparent` / `tracestate` / `baggage` and continues the upstream trace. Powered by `@hono/otel`. |
| `evaluator` | `check`, `expand`, `list-objects`, `list-users`, `batch-check`. Each entry point gets its own span with store ID, model ID, and outcome attributes. |
| `storage` | `read_tuples`, `apply_tuple_mutations`, `list_changes`, `load_model_index`. Captures result counts, write/delete batch sizes, and parent-child relationships under the evaluator span. |
| `auth` | Reserved — auth dispatcher outcome spans are wired in the schema but the middleware-side instrumentation lands in a follow-up. |
| `idempotency` | Same — reserved. |

Each category has a config knob under `otel.spans.*`. Turning a
category off makes its `traced()` wrappers true no-ops — no span
construction, no attribute building, no SDK overhead at the
disabled call sites.

```yaml
otel:
  enabled: true
  spans:
    http: true
    evaluator: true
    storage: false      # firehose of storage spans is too noisy for our trace backend
    auth: true
    idempotency: true
```

## Span catalog

Span names follow `openfga.<boundary>.<operation>`. Attribute names
use the `openfga.` prefix to distinguish them from semantic-
convention attributes.

### HTTP (`otel.spans.http`)

Emitted by `@hono/otel`. One root server span per request with:
- HTTP method, route, status code
- Captured request headers (default: `traceparent`, `tracestate`,
  `baggage`)
- Captured response headers (default: none)

### Evaluator (`otel.spans.evaluator`)

| Span name | Attributes |
|---|---|
| `openfga.evaluator.check` | `openfga.store_id`, `openfga.model_id`, `openfga.allowed` |
| `openfga.evaluator.expand` | `openfga.store_id`, `openfga.model_id`, `openfga.object_type`, `openfga.relation` |
| `openfga.evaluator.list_objects` | `openfga.store_id`, `openfga.model_id`, `openfga.type`, `openfga.relation`, `openfga.result_count` |
| `openfga.evaluator.list_users` | `openfga.store_id`, `openfga.model_id`, `openfga.object_type`, `openfga.relation`, `openfga.result_count` |
| `openfga.evaluator.batch_check` | `openfga.store_id`, `openfga.model_id`, `openfga.batch_size` |

### Storage (`otel.spans.storage`)

| Span name | Attributes |
|---|---|
| `openfga.storage.read_tuples` | `openfga.store_id`, `openfga.page_size`, `openfga.result_count` |
| `openfga.storage.apply_tuple_mutations` | `openfga.store_id`, `openfga.write_count`, `openfga.delete_count` |
| `openfga.storage.list_changes` | `openfga.store_id`, `openfga.page_size`, `openfga.result_count` |
| `openfga.storage.load_model_index` | `openfga.store_id`, `openfga.model_id` |

## What is NOT captured

By design:

- **Tuple-level user identifiers, relations, and object references.**
  Tuple data is PII-adjacent in many deployments (user emails as
  `user:alice@example.com`, document IDs as `doc:contract-7`).
  Capturing them in span attributes would leak that data into
  whatever backend the traces stream to. Operators can opt in
  later via a `otel.capture.tupleAttributes` flag if a customer
  needs it.
- **Sensitive HTTP headers.** `authorization`, `cookie`,
  `set-cookie`, `proxy-authorization`, `x-api-key`, and
  `idempotency-key` cannot be added to
  `otel.capture.{request,response}Headers`. The schema rejects
  them at config-load. This is a hard guarantee — not a default
  that operators can override.

## Exporter, sampler, propagators

All standard:

```yaml
otel:
  exporter:
    type: otlp-http        # otlp-http | otlp-grpc | console | none
    endpoint: ''           # OTEL_EXPORTER_OTLP_ENDPOINT also honored
    headers: {}            # static OTLP headers for the HTTP exporter
    timeoutMs: 10000

  sampler:
    type: always_on        # always_on | always_off |
                           # parentbased_always_on |
                           # traceidratio | parentbased_traceidratio
    ratio: 1.0             # used by ratio-based samplers (0.0–1.0)

  propagators:
    - tracecontext         # W3C Trace Context
    - baggage              # W3C Baggage
```

### Which standard `OTEL_*` env vars are honored

The OpenTelemetry SDK honors some upstream env vars natively; others
are overridden because the server constructs the sampler and
propagator from `otel.*` config explicitly at boot:

| Env var | Honored? | Notes |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Yes | Used when `otel.exporter.endpoint` is empty (the default). |
| `OTEL_EXPORTER_OTLP_HEADERS` | Yes (OTLP HTTP) | Used when `otel.exporter.headers` is empty. For OTLP gRPC, this env var is the only headers/metadata path. |
| `OTEL_RESOURCE_ATTRIBUTES` | Yes | Merged with `otel.resource.attributes`. |
| `OTEL_SERVICE_NAME` | Overridden | `otel.service.name` wins. |
| `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG` | **No** | Sampler is constructed from `otel.sampler.type` and `otel.sampler.ratio`. Configure via `OPENFGA_OTEL_SAMPLER_*`. |
| `OTEL_PROPAGATORS` | **No** | Propagators are constructed from `otel.propagators`. Configure via `OPENFGA_OTEL_PROPAGATORS`. |

## Sampling at production volume

For a high-traffic deployment:

```yaml
otel:
  enabled: true
  sampler:
    type: parentbased_traceidratio
    ratio: 0.05            # 5% of root-sampled traces
  spans:
    storage: false         # storage is hot-path; spans there outpace evaluator 10:1
```

`parentbased_traceidratio` means: if an upstream trace was sampled,
ours is too (preserving causality across services). If we're the
root, sample 5%.

## Boot-time fail-fast

OTel SDK init runs before listeners bind. A misconfigured exporter
URL or unsupported propagator surfaces as
`FATAL otel_setup_failed; refusing to start`. The server never
accepts traffic while in a known-bad telemetry state.

## Zero cost when disabled

When `otel.enabled = false` (the default), the OTel SDK and all
transitive dependencies are **never imported**. The `traced()`
helper is a synchronous pass-through that doesn't even build the
attribute object. The build's runtime graph in the disabled state
matches what it was before this feature shipped.

This is verified by the unit test suite: a `traced()` call with an
attribute-builder function asserts the builder is never invoked
when emission is off.

## See also

- [Enable OpenTelemetry](/runbooks/enable-otel) — operator
  checklist for production rollout
- The internal feature spec at
  [`docs/features/opentelemetry.md`](https://github.com/DevelopmentSprint/openfga-node-server/blob/develop/docs/features/opentelemetry.md)
  in the repo carries the full validation strategy, security
  model, and span-attribute contract.
