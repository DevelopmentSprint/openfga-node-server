/**
 * Schema + env-overlay tests for the OTel configuration surface.
 * Runtime helper coverage lives in tests/unit/otel-helper.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { ConfigSchema } from '../../src/config-schema.js'
import { applyEnvOverrides } from '../../src/config-env-overrides.js'

describe('OtelSchema — defaults', () => {
  it('parses an empty config with otel.enabled=false', () => {
    const cfg = ConfigSchema.parse({})
    expect(cfg.otel.enabled).toBe(false)
    expect(cfg.otel.service.name).toBe('openfga-node-server')
    expect(cfg.otel.exporter.type).toBe('otlp-http')
    expect(cfg.otel.sampler.type).toBe('always_on')
    expect(cfg.otel.propagators).toEqual(['tracecontext', 'baggage'])
    expect(cfg.otel.capture.requestHeaders).toEqual(['traceparent', 'tracestate', 'baggage'])
    expect(cfg.otel.capture.responseHeaders).toEqual([])
    expect(cfg.otel.spans).toEqual({
      http: true,
      evaluator: true,
      storage: true,
      auth: true,
      idempotency: true,
    })
  })

  it('accepts a fully-specified otel block', () => {
    const cfg = ConfigSchema.parse({
      otel: {
        enabled: true,
        service: { name: 'svc', version: '1.0.0' },
        resource: { attributes: { env: 'prod' } },
        exporter: { type: 'console', endpoint: '', timeoutMs: 5000, headers: {} },
        sampler: { type: 'traceidratio', ratio: 0.1 },
        propagators: ['tracecontext'],
        capture: { requestHeaders: ['x-trace-id'], responseHeaders: ['x-served-by'] },
        spans: {
          http: true, evaluator: false, storage: false, auth: false, idempotency: false,
        },
      },
    })
    expect(cfg.otel.enabled).toBe(true)
    expect(cfg.otel.sampler.ratio).toBe(0.1)
    expect(cfg.otel.spans.evaluator).toBe(false)
  })
})

describe('OtelSchema — validation', () => {
  it.each([
    'authorization',
    'cookie',
    'set-cookie',
    'proxy-authorization',
    'x-api-key',
    'idempotency-key',
    'AUTHORIZATION', // case-insensitive
  ])('rejects sensitive header %s in capture.requestHeaders', (header) => {
    const r = ConfigSchema.safeParse({ otel: { capture: { requestHeaders: [header] } } })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some(i => i.message.includes('forbidden sensitive header'))).toBe(true)
    }
  })

  it.each(['authorization', 'cookie', 'x-api-key'])(
    'rejects sensitive header %s in capture.responseHeaders',
    (header) => {
      expect(ConfigSchema.safeParse({ otel: { capture: { responseHeaders: [header] } } }).success).toBe(false)
    },
  )

  it('rejects unknown exporter type', () => {
    expect(ConfigSchema.safeParse({ otel: { exporter: { type: 'jaeger-thrift' } } }).success).toBe(false)
  })

  it('rejects unknown sampler type', () => {
    expect(ConfigSchema.safeParse({ otel: { sampler: { type: 'custom' } } }).success).toBe(false)
  })

  it('rejects unknown propagator', () => {
    expect(ConfigSchema.safeParse({ otel: { propagators: ['quantum'] } }).success).toBe(false)
  })

  it('rejects sampler ratio outside [0, 1]', () => {
    expect(ConfigSchema.safeParse({ otel: { sampler: { ratio: 1.5 } } }).success).toBe(false)
    expect(ConfigSchema.safeParse({ otel: { sampler: { ratio: -0.1 } } }).success).toBe(false)
  })
})

describe('applyEnvOverrides — OTel mapping', () => {
  // Each case names the env var, a typed getter into the parsed
  // result, and the expected value. Typed getters avoid a dynamic
  // property walk over user-supplied segment names.
  interface OtelOut {
    otel: {
      enabled?: unknown
      service?: { name?: unknown, version?: unknown }
      exporter?: { type?: unknown, endpoint?: unknown, timeoutMs?: unknown }
      sampler?: { type?: unknown, ratio?: unknown }
      spans?: {
        http?: unknown
        evaluator?: unknown
        storage?: unknown
        auth?: unknown
        idempotency?: unknown
      }
      propagators?: unknown
      capture?: { requestHeaders?: unknown, responseHeaders?: unknown }
    }
  }

  function overlay(env: Record<string, string | undefined>): OtelOut {
    return applyEnvOverrides({}, env) as OtelOut
  }

  const scalarCases: Array<[string, (r: OtelOut) => unknown, string]> = [
    ['OPENFGA_OTEL_ENABLED', r => r.otel.enabled, 'true'],
    ['OPENFGA_OTEL_SERVICE_NAME', r => r.otel.service?.name, 'my-svc'],
    ['OPENFGA_OTEL_SERVICE_VERSION', r => r.otel.service?.version, '2.1.0'],
    ['OPENFGA_OTEL_EXPORTER_TYPE', r => r.otel.exporter?.type, 'otlp-grpc'],
    ['OPENFGA_OTEL_EXPORTER_ENDPOINT', r => r.otel.exporter?.endpoint, 'http://collector:4318'],
    ['OPENFGA_OTEL_EXPORTER_TIMEOUT_MS', r => r.otel.exporter?.timeoutMs, '15000'],
    ['OPENFGA_OTEL_SAMPLER_TYPE', r => r.otel.sampler?.type, 'traceidratio'],
    ['OPENFGA_OTEL_SAMPLER_RATIO', r => r.otel.sampler?.ratio, '0.5'],
    ['OPENFGA_OTEL_SPANS_HTTP', r => r.otel.spans?.http, 'false'],
    ['OPENFGA_OTEL_SPANS_EVALUATOR', r => r.otel.spans?.evaluator, 'false'],
    ['OPENFGA_OTEL_SPANS_STORAGE', r => r.otel.spans?.storage, 'false'],
    ['OPENFGA_OTEL_SPANS_AUTH', r => r.otel.spans?.auth, 'false'],
    ['OPENFGA_OTEL_SPANS_IDEMPOTENCY', r => r.otel.spans?.idempotency, 'false'],
  ]

  it.each(scalarCases)('%s maps to the documented config path', (envKey, getter, value) => {
    const r = overlay({ [envKey]: value })
    expect(getter(r)).toBe(value)
  })

  const listCases: Array<[string, (r: OtelOut) => unknown]> = [
    ['OPENFGA_OTEL_PROPAGATORS', r => r.otel.propagators],
    ['OPENFGA_OTEL_CAPTURE_REQUEST_HEADERS', r => r.otel.capture?.requestHeaders],
    ['OPENFGA_OTEL_CAPTURE_RESPONSE_HEADERS', r => r.otel.capture?.responseHeaders],
  ]

  it.each(listCases)('%s splits comma-separated values', (envKey, getter) => {
    const r = overlay({ [envKey]: 'a, b,,c,' })
    expect(getter(r)).toEqual(['a', 'b', 'c'])
  })
})

describe('applyEnvOverrides — OTel map-valued env vars', () => {
  type MapOut = { otel?: { exporter?: { headers?: unknown }, resource?: { attributes?: unknown } } }
  const run = (env: Record<string, string | undefined>) => applyEnvOverrides({}, env) as MapOut

  it('parses OTel-standard key=value lists for exporter headers', () => {
    const out = run({ OPENFGA_OTEL_EXPORTER_HEADERS: ' x-api-key = abc%20def , authorization=Bearer%20tok%3Dx==,, ' })
    expect(out.otel?.exporter?.headers).toEqual({ 'x-api-key': 'abc def', authorization: 'Bearer tok=x==' })
  })

  it('parses resource attributes and lets file values be overridden', () => {
    const out = applyEnvOverrides(
      { otel: { resource: { attributes: { stale: '1' } } } },
      { OPENFGA_OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment=prod,service.namespace=a%2Fb' },
    ) as MapOut
    expect(out.otel?.resource?.attributes).toEqual({ 'deployment.environment': 'prod', 'service.namespace': 'a/b' })
  })

  it('treats empty and unset values as not set', () => {
    expect(run({ OPENFGA_OTEL_EXPORTER_HEADERS: '  ' }).otel).toBeUndefined()
    expect(run({}).otel).toBeUndefined()
  })

  it('accepts a list of only empty entries as an empty map', () => {
    expect(run({ OPENFGA_OTEL_EXPORTER_HEADERS: ' , ,' }).otel?.exporter?.headers).toEqual({})
  })

  it('rejects an entry without "=" naming the variable but not the value', () => {
    expect(() => run({ OPENFGA_OTEL_EXPORTER_HEADERS: 'ok=1,SECRETTOKEN' }))
      .toThrowError(/OPENFGA_OTEL_EXPORTER_HEADERS: entry 2/)
    try { run({ OPENFGA_OTEL_EXPORTER_HEADERS: 'ok=1,SECRETTOKEN' }) }
    catch (err) { expect((err as Error).message).not.toContain('SECRETTOKEN') }
  })

  it('rejects an empty key and bad percent-encoding', () => {
    expect(() => run({ OPENFGA_OTEL_RESOURCE_ATTRIBUTES: '=v' })).toThrowError(/OPENFGA_OTEL_RESOURCE_ATTRIBUTES: entry 1/)
    expect(() => run({ OPENFGA_OTEL_RESOURCE_ATTRIBUTES: 'k=%E0%A4%A' })).toThrowError(/percent-encoded/)
  })
})
