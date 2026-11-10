/**
 * Configuration schema for openfga-node-server.
 *
 * This module is pure: it declares the Zod schema, derives the
 * `Config` TypeScript type via `z.infer`, and exports a few small
 * primitives the env-overlay layer reuses. It performs no I/O, no
 * env reads, and no side effects at module evaluation time. Importing
 * it from any test or runtime context is safe.
 *
 * Side-effectful loading lives in `src/config.ts`. The env-var
 * translation (flat OPENFGA_* names to nested config paths) lives in
 * `src/config-env-overrides.ts`. Both modules import this one for
 * types and defaults; this module imports neither.
 */
import { z } from 'zod'

/**
 * Strict boolean parser used by configuration consumers that accept
 * `'true'` or `'false'` (case- and whitespace-tolerant) and reject
 * anything else. Mirrors the behavior of `parseMigrateOnStart` from
 * the pre-c12 era so deployments don't see a semantic shift.
 */
function strictBool(fieldName: string) {
  return z
    .union([z.boolean(), z.string()])
    .transform((v, ctx) => {
      if (typeof v === 'boolean') return v
      const t = v.trim().toLowerCase()
      if (t === 'true') return true
      if (t === 'false') return false
      ctx.addIssue({
        code: 'custom',
        message: `${fieldName} must be 'true' or 'false'; got "${v}"`,
      })
      return z.NEVER
    })
}

/**
 * Non-negative integer parser used by every pool/timeout field that
 * went through `intFromEnv` in the pre-c12 era. Accepts a number or
 * a numeric string; coerces via `Number`; rejects non-integers and
 * negatives with the same `must be a non-negative integer; got "X"`
 * message the previous helper threw.
 */
function nonNegativeInt(fieldName: string, defaultValue: number) {
  return z
    .union([z.number(), z.string()])
    .default(defaultValue)
    .transform((v, ctx) => {
      if (typeof v === 'number') {
        if (!Number.isInteger(v) || v < 0) {
          ctx.addIssue({
            code: 'custom',
            message: `${fieldName} must be a non-negative integer; got "${v}"`,
          })
          return z.NEVER
        }
        return v
      }
      const n = Number(v)
      if (!Number.isInteger(n) || n < 0) {
        ctx.addIssue({
          code: 'custom',
          message: `${fieldName} must be a non-negative integer; got "${v}"`,
        })
        return z.NEVER
      }
      return n
    })
}

/**
 * Positive integer parser used by `idempotency.ttlMs`. Mirrors the
 * existing `readTtlFromEnv` behavior at `src/middleware/idempotency.ts`
 * which rejects 0 and negatives with `must be a positive integer`.
 */
function positiveInt(fieldName: string, defaultValue: number) {
  return z
    .union([z.number(), z.string()])
    .default(defaultValue)
    .transform((v, ctx) => {
      const n = typeof v === 'number' ? v : Number(v)
      if (!Number.isInteger(n) || n <= 0) {
        ctx.addIssue({
          code: 'custom',
          message: `${fieldName} must be a positive integer; got "${v}"`,
        })
        return z.NEVER
      }
      return n
    })
}

/**
 * TCP port parser: a non-negative-integer parse (same coercion and
 * messages as the other numeric fields) followed by a 1..65535 range
 * check. Port 0 (ephemeral) is rejected: the server logs and
 * documents a concrete listening port.
 */
function port(fieldName: string, defaultValue: number) {
  return nonNegativeInt(fieldName, defaultValue).refine(
    v => v >= 1 && v <= 65_535,
    { message: `${fieldName} must be an integer between 1 and 65535` },
  )
}

export const LogLevels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const
export type LogLevel = (typeof LogLevels)[number]

export const AuthModes = ['none', 'preshared', 'oidc'] as const
export type AuthMode = (typeof AuthModes)[number]

/**
 * Asymmetric signing algorithms accepted by OIDC mode. HS-family
 * (HS256/HS384/HS512) are explicitly excluded — the published JWKS
 * surface is asymmetric by design (RFC 7517), so an HS entry in
 * `auth.oidc.algorithms` would always fail validation and the
 * presence of one is a config error worth surfacing at boot.
 */
export const OidcAlgorithms = [
  'RS256', 'RS384', 'RS512',
  'ES256', 'ES384', 'ES512',
  'PS256', 'PS384', 'PS512',
  'EdDSA',
] as const
export type OidcAlgorithm = (typeof OidcAlgorithms)[number]

export const IdempotencyModes = ['off', 'optional', 'required'] as const
export type IdempotencyMode = (typeof IdempotencyModes)[number]

export const OtelExporterTypes = ['otlp-http', 'otlp-grpc', 'console', 'none'] as const
export type OtelExporterType = (typeof OtelExporterTypes)[number]

export const OtelSamplerTypes = [
  'always_on',
  'always_off',
  'parentbased_always_on',
  'traceidratio',
  'parentbased_traceidratio',
] as const
export type OtelSamplerType = (typeof OtelSamplerTypes)[number]

export const OtelPropagators = ['tracecontext', 'baggage', 'b3', 'b3multi', 'jaeger', 'ottrace'] as const
export type OtelPropagator = (typeof OtelPropagators)[number]

// Header names that must NEVER appear in otel.capture.* — recording
// them as span attributes would leak credentials, idempotency
// fingerprints, or session state to whatever backend the traces
// stream to. Case-insensitive match at config-load time.
const OTEL_FORBIDDEN_HEADERS = [
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'idempotency-key',
] as const

const PoolSchema = z
  .object({
    max: nonNegativeInt('db.pool.max', 10),
    min: nonNegativeInt('db.pool.min', 0),
    idleTimeoutMs: nonNegativeInt('db.pool.idleTimeoutMs', 30_000),
    connectionTimeoutMs: nonNegativeInt('db.pool.connectionTimeoutMs', 0),
    statementTimeoutMs: nonNegativeInt('db.pool.statementTimeoutMs', 0),
    queryTimeoutMs: nonNegativeInt('db.pool.queryTimeoutMs', 0),
  })
  .refine(pool => pool.min <= pool.max, {
    path: ['min'],
    message: 'db.pool.min must be less than or equal to db.pool.max',
  })
  .prefault({} as never)

const DbSchema = z
  .object({
    // Optional at the schema level so CLI entry points that don't need
    // a database (load-model CLI) can load the typed `config` without
    // setting OPENFGA_DB_URL. Storage modules call `requireDbUrl()` at
    // pool-open time to preserve the original fail-fast at server boot.
    url: z.string().min(1).optional(),
    namespace: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,62}$/, {
        message: 'db.namespace must match /^[a-z][a-z0-9_]{0,62}$/',
      })
      .default('openfga'),
    applicationName: z.string().default('openfga-node-server'),
    pool: PoolSchema,
  })
  .prefault({} as never)

const ListenersSchema = z
  .object({
    http: z
      .object({
        enabled: strictBool('listeners.http.enabled').default(true),
        port: port('listeners.http.port', 8080),
      })
      .prefault({} as never),
    https: z
      .object({
        port: port('listeners.https.port', 8443),
      })
      .prefault({} as never),
  })
  .prefault({} as never)

const TlsSchema = z
  .object({
    certFile: z.string().min(1).optional(),
    keyFile: z.string().min(1).optional(),
  })
  .prefault({} as never)

const LogSchema = z
  .object({
    level: z.enum(LogLevels).default('info'),
  })
  .prefault({} as never)

const OidcSchema = z
  .object({
    // Required at use-site when auth.mode === 'oidc'. Optional at the
    // schema level so non-OIDC deployments don't have to declare this
    // block at all. The cross-field constraint in the root schema's
    // superRefine enforces presence when the mode is 'oidc'.
    issuer: z.string().min(1).optional(),
    audience: z.string().min(1).optional(),
    issuerAliases: z.array(z.string().min(1)).default([]),
    subjects: z.array(z.string().min(1)).default([]),
    clients: z.array(z.string().min(1)).default([]),
    algorithms: z.array(z.enum(OidcAlgorithms)).default([...OidcAlgorithms]),
    clockSkewSec: nonNegativeInt('auth.oidc.clockSkewSec', 60),
    jwksUri: z.string().min(1).optional(),
    // JWKS cache lifetime — how long a fetched JWKS is considered
    // fresh before jose attempts a refresh. Default: 600_000 ms
    // (10 minutes).
    jwksCacheMaxAgeMs: nonNegativeInt('auth.oidc.jwksCacheMaxAgeMs', 600_000),
    // Cooldown between consecutive JWKS refetches triggered by a kid
    // miss. Prevents an attacker from forcing repeated refetches via
    // unknown-kid tokens. Production-safe default: 30_000 ms.
    jwksCooldownMs: nonNegativeInt('auth.oidc.jwksCooldownMs', 30_000),
  })
  .prefault({} as never)

const AuthSchema = z
  .object({
    mode: z.enum(AuthModes).default('none'),
    presharedKeys: z.array(z.string().min(1)).default([]),
    oidc: OidcSchema,
  })
  .prefault({} as never)

const IdempotencySchema = z
  .object({
    mode: z.enum(IdempotencyModes).default('off'),
    ttlMs: positiveInt('idempotency.ttlMs', 86_400_000),
  })
  .prefault({} as never)

// Optional durable write-fence extension (docs/features/write-fences.md).
// Off by default: the HTTP surface is then identical to upstream OpenFGA.
const WriteFencesSchema = z
  .object({
    enabled: strictBool('writeFences.enabled').default(false),
  })
  .prefault({} as never)

const LoadModelSchema = z
  .object({
    apiUrl: z.string().min(1).default('http://localhost:8080'),
    storeName: z.string().min(1).default('default'),
    storeId: z.string().min(1).optional(),
  })
  .prefault({} as never)

const OtelSpansSchema = z
  .object({
    http: strictBool('otel.spans.http').default(true),
    evaluator: strictBool('otel.spans.evaluator').default(true),
    storage: strictBool('otel.spans.storage').default(true),
    auth: strictBool('otel.spans.auth').default(true),
    idempotency: strictBool('otel.spans.idempotency').default(true),
  })
  .prefault({} as never)

const OtelExporterSchema = z
  .object({
    type: z.enum(OtelExporterTypes).default('otlp-http'),
    endpoint: z.string().default(''),
    headers: z.record(z.string(), z.string()).default({}),
    timeoutMs: nonNegativeInt('otel.exporter.timeoutMs', 10_000),
  })
  .prefault({} as never)

const OtelSamplerSchema = z
  .object({
    type: z.enum(OtelSamplerTypes).default('always_on'),
    ratio: z.coerce.number().min(0).max(1).default(1),
  })
  .prefault({} as never)

const OtelCaptureSchema = z
  .object({
    requestHeaders: z
      .array(z.string().min(1))
      .default(['traceparent', 'tracestate', 'baggage']),
    responseHeaders: z.array(z.string().min(1)).default([]),
  })
  .prefault({} as never)

const OtelSchema = z
  .object({
    enabled: strictBool('otel.enabled').default(false),
    service: z
      .object({
        name: z.string().min(1).default('openfga-node-server'),
        // Empty means "unset": the OTel bootstrap resolves the
        // package.json version at runtime (see
        // src/observability/version.ts).
        version: z.string().default(''),
      })
      .prefault({} as never),
    resource: z
      .object({
        attributes: z.record(z.string(), z.string()).default({}),
      })
      .prefault({} as never),
    exporter: OtelExporterSchema,
    propagators: z
      .array(z.enum(OtelPropagators))
      .default(['tracecontext', 'baggage']),
    sampler: OtelSamplerSchema,
    capture: OtelCaptureSchema,
    spans: OtelSpansSchema,
  })
  .prefault({} as never)

export const ConfigSchema = z
  .object({
    db: DbSchema,
    listeners: ListenersSchema,
    tls: TlsSchema,
    log: LogSchema,
    auth: AuthSchema,
    idempotency: IdempotencySchema,
    writeFences: WriteFencesSchema,
    loadModel: LoadModelSchema,
    otel: OtelSchema,
    migrateOnStart: strictBool('migrateOnStart').default(false),
    maxChecksPerBatchCheck: positiveInt('maxChecksPerBatchCheck', 50).refine(n => n <= 0xffff_ffff, 'maxChecksPerBatchCheck must fit uint32'),
  })
  .superRefine((cfg, ctx) => {
    const httpEnabled = cfg.listeners.http.enabled
    const httpPort = cfg.listeners.http.port
    const httpsPort = cfg.listeners.https.port
    const certFile = cfg.tls.certFile
    const keyFile = cfg.tls.keyFile

    if ((certFile && !keyFile) || (!certFile && keyFile)) {
      ctx.addIssue({
        code: 'custom',
        path: ['tls'],
        message:
          'tls.certFile and tls.keyFile must both be set together (or both unset for HTTP-only)',
      })
    }

    const httpsEnabled = Boolean(certFile && keyFile)

    if (!httpEnabled && !httpsEnabled) {
      ctx.addIssue({
        code: 'custom',
        path: ['listeners'],
        message:
          'listeners.http.enabled=false requires tls.certFile and tls.keyFile to be set; otherwise the server has no listener',
      })
    }

    if (httpEnabled && httpsEnabled && httpPort === httpsPort) {
      ctx.addIssue({
        code: 'custom',
        path: ['listeners'],
        message:
          'listeners.http.port and listeners.https.port cannot be equal when both listeners are active',
      })
    }

    if (cfg.auth.mode === 'preshared' && cfg.auth.presharedKeys.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['auth', 'presharedKeys'],
        message:
          'auth.mode=preshared requires auth.presharedKeys to be set with at least one non-empty key',
      })
    }

    // OTel header-capture safety: forbid sensitive header names in
    // either the request- or response-capture lists. Tracing backends
    // are not always trustworthy boundaries for credentials or
    // idempotency fingerprints.
    const checkHeaders = (list: string[], path: string[]): void => {
      for (const header of list) {
        if ((OTEL_FORBIDDEN_HEADERS as readonly string[]).includes(header.toLowerCase())) {
          ctx.addIssue({
            code: 'custom',
            path,
            message: `${path.join('.')} contains forbidden sensitive header "${header}"; OTel span attributes must not capture credentials or idempotency keys`,
          })
        }
      }
    }
    checkHeaders(cfg.otel.capture.requestHeaders, ['otel', 'capture', 'requestHeaders'])
    checkHeaders(cfg.otel.capture.responseHeaders, ['otel', 'capture', 'responseHeaders'])

    if (cfg.auth.mode === 'oidc') {
      if (!cfg.auth.oidc.issuer) {
        ctx.addIssue({
          code: 'custom',
          path: ['auth', 'oidc', 'issuer'],
          message: 'auth.mode=oidc requires auth.oidc.issuer to be set',
        })
      }
      if (!cfg.auth.oidc.audience) {
        ctx.addIssue({
          code: 'custom',
          path: ['auth', 'oidc', 'audience'],
          message: 'auth.mode=oidc requires auth.oidc.audience to be set',
        })
      }
      if (cfg.auth.oidc.algorithms.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['auth', 'oidc', 'algorithms'],
          message:
            'auth.mode=oidc requires auth.oidc.algorithms to contain at least one allowed algorithm',
        })
      }
    }
  })

export type Config = z.infer<typeof ConfigSchema>
