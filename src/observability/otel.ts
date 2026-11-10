/**
 * OpenTelemetry integration entry point.
 *
 * Per docs/features/opentelemetry.md. Off by default — when
 * `config.otel.enabled === false`, this module's runtime cost is
 * zero: `traced()` is a synchronous pass-through that never touches
 * the OTel API beyond a single property read, and `initOtelSdk()`
 * returns immediately without importing the SDK.
 *
 * When enabled, `initOtelSdk()` (awaited at server bootstrap)
 * dynamically imports the SDK, resolves the configured exporter /
 * sampler / propagators, and registers the tracer provider. The
 * `traced()` helper then emits spans for every wrapped call site,
 * gated per-boundary by `config.otel.spans.{category}`.
 */
import { SpanStatusCode, context, trace, type Attributes, type Span, type Tracer } from '@opentelemetry/api'
import { config } from '../config'
import type { OtelSamplerType } from '../config-schema'
import { resolvePackageVersion } from './version'

const TRACER_NAME = 'openfga-node-server'

export type SpanCategory = 'http' | 'evaluator' | 'storage' | 'auth' | 'idempotency'

let sdkStarted = false
let activeSdk: { shutdown: () => Promise<void> } | undefined
let cachedTracer: Tracer | undefined

function getTracer(): Tracer {
  if (!cachedTracer) cachedTracer = trace.getTracer(TRACER_NAME)
  return cachedTracer
}

/**
 * True when OTel is enabled AND the boundary category is on.
 * Call-site short-circuit for code that wants to skip even the
 * attribute construction when emission is off.
 */
export function spansEnabled(category: SpanCategory): boolean {
  if (!config.otel.enabled) return false
  return config.otel.spans[category]
}

/**
 * Wrap a function in a span when OTel is enabled and the boundary
 * category is on. On disabled / off categories this is a pass-through
 * — no span allocation, no attribute building.
 *
 * Attributes accept either a literal `Attributes` object or a builder
 * function so callers that compute non-trivial attributes don't pay
 * for that work when the category is off.
 */
export async function traced<T>(
  category: SpanCategory,
  name: string,
  attrs: Attributes | (() => Attributes),
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  if (!spansEnabled(category)) {
    const active = trace.getActiveSpan()
    return fn(active ?? noopSpan)
  }
  const tracer = getTracer()
  const initialAttrs = typeof attrs === 'function' ? attrs() : attrs
  return tracer.startActiveSpan(name, { attributes: initialAttrs }, async (span) => {
    try {
      const result = await fn(span)
      span.setStatus({ code: SpanStatusCode.OK })
      return result
    }
    catch (err) {
      span.recordException(err as Error)
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
    finally {
      span.end()
    }
  })
}

// No-op span used when OTel is disabled and a caller insists on a
// Span argument. The API's wrapSpanContext produces a non-recording
// span that drops every method call cheaply.
const noopSpan: Span = trace.wrapSpanContext({
  traceId: '00000000000000000000000000000000',
  spanId: '0000000000000000',
  traceFlags: 0,
})

/**
 * Initialize the OTel SDK. Idempotent — calling twice is a no-op
 * after the first successful boot. Awaited by `src/server.ts` at
 * startup BEFORE the HTTP listener binds so a misconfigured
 * exporter / propagator surfaces FATAL at boot.
 *
 * Synchronous return when `config.otel.enabled === false` — the SDK
 * is never imported and zero extra modules are pulled into the
 * bundle's runtime graph.
 */
export async function initOtelSdk(): Promise<void> {
  if (!config.otel.enabled || sdkStarted) return

  // Dynamic imports so the disabled path doesn't load any of these.
  const [
    { NodeSDK },
    resourcesModule,
    semConv,
    sdkTraceBase,
    coreModule,
    exporter,
  ] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/resources'),
    import('@opentelemetry/semantic-conventions'),
    import('@opentelemetry/sdk-trace-base'),
    import('@opentelemetry/core'),
    buildExporter(),
  ])

  const otel = config.otel
  const attrs: Record<string, string> = {
    [semConv.ATTR_SERVICE_NAME]: otel.service.name,
    ...otel.resource.attributes,
  }
  const serviceVersion = otel.service.version || resolvePackageVersion()
  if (serviceVersion) {
    attrs[semConv.ATTR_SERVICE_VERSION] = serviceVersion
  }
  const resource = resourcesModule.resourceFromAttributes(attrs)

  const sampler = buildSampler(sdkTraceBase, otel.sampler.type, otel.sampler.ratio)
  const propagator = buildPropagator(coreModule, otel.propagators)

  const sdk = new NodeSDK({
    resource,
    traceExporter: exporter,
    sampler,
    textMapPropagator: propagator,
  })

  sdk.start()
  sdkStarted = true
  activeSdk = sdk
}

/**
 * Flush pending spans and shut the SDK down. Called by the process
 * shutdown sequence in `src/server.ts`; this module deliberately
 * installs NO signal handlers (a registered SIGTERM/SIGINT listener
 * disables Node's default exit, so only the owner of the process
 * lifecycle may register one). Safe to call when OTel is disabled or
 * already shut down.
 */
export async function shutdownOtelSdk(): Promise<void> {
  const sdk = activeSdk
  activeSdk = undefined
  sdkStarted = false
  if (sdk) await sdk.shutdown()
}

async function buildExporter(): Promise<import('@opentelemetry/sdk-trace-base').SpanExporter> {
  const exp = config.otel.exporter
  switch (exp.type) {
    case 'console': {
      const { ConsoleSpanExporter } = await import('@opentelemetry/sdk-trace-base')
      return new ConsoleSpanExporter()
    }
    case 'otlp-http': {
      const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http')
      return new OTLPTraceExporter({
        url: exp.endpoint || undefined,
        headers: Object.keys(exp.headers).length > 0 ? exp.headers : undefined,
        timeoutMillis: exp.timeoutMs,
      })
    }
    case 'otlp-grpc': {
      // gRPC uses Metadata, not plain headers. Operators that need
      // auth metadata on a gRPC exporter set OTEL_EXPORTER_OTLP_HEADERS
      // which the underlying gRPC client honors via its own
      // metadata-loading path. The config.otel.exporter.headers field
      // is HTTP-only and is silently ignored here — documented in the
      // feature spec.
      const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-grpc')
      return new OTLPTraceExporter({
        url: exp.endpoint || undefined,
        timeoutMillis: exp.timeoutMs,
      })
    }
    case 'none':
      return createNoopSpanExporter()
  }
}

/**
 * True no-op exporter for `exporter.type: none`: spans are sampled and
 * built but dropped on export, so nothing is retained in memory. Tests
 * that need to inspect spans inject their own InMemorySpanExporter.
 */
export function createNoopSpanExporter(): import('@opentelemetry/sdk-trace-base').SpanExporter {
  return {
    export(_spans, resultCallback) {
      resultCallback({ code: 0 })
    },
    shutdown: () => Promise.resolve(),
    forceFlush: () => Promise.resolve(),
  }
}

function buildSampler(
  baseModule: typeof import('@opentelemetry/sdk-trace-base'),
  type: OtelSamplerType,
  ratio: number,
): import('@opentelemetry/sdk-trace-base').Sampler {
  const {
    AlwaysOnSampler,
    AlwaysOffSampler,
    ParentBasedSampler,
    TraceIdRatioBasedSampler,
  } = baseModule
  switch (type) {
    case 'always_on': return new AlwaysOnSampler()
    case 'always_off': return new AlwaysOffSampler()
    case 'parentbased_always_on': return new ParentBasedSampler({ root: new AlwaysOnSampler() })
    case 'traceidratio': return new TraceIdRatioBasedSampler(ratio)
    case 'parentbased_traceidratio':
      return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) })
  }
}

function buildPropagator(
  coreModule: typeof import('@opentelemetry/core'),
  names: readonly string[],
): import('@opentelemetry/api').TextMapPropagator {
  const { W3CTraceContextPropagator, W3CBaggagePropagator, CompositePropagator } = coreModule
  const propagators = names.map((name): import('@opentelemetry/api').TextMapPropagator => {
    switch (name) {
      case 'tracecontext': return new W3CTraceContextPropagator()
      case 'baggage': return new W3CBaggagePropagator()
      default:
        throw new Error(
          `OTel propagator "${name}" is not bundled; install the appropriate @opentelemetry/propagator-* package and add it to buildPropagator()`,
        )
    }
  })
  return new CompositePropagator({ propagators })
}

// Re-exports so call sites can type their callback args without
// pulling @opentelemetry/api directly.
export type { Span } from '@opentelemetry/api'
export const otelContext = context

/**
 * Test-only: reset cached SDK state so unit tests can re-init with
 * a fresh configuration. Production code never calls this.
 */
export function __resetOtelForTests(): void {
  sdkStarted = false
  activeSdk = undefined
  cachedTracer = undefined
}
