import { describe, expect, it } from 'vitest'
import { selectLogTransport } from '../../src/logger.js'
import { resolvePackageVersion } from '../../src/observability/version.js'
import { createNoopSpanExporter } from '../../src/observability/otel.js'
import { ConfigSchema } from '../../src/config-schema.js'
import { applyEnvOverrides } from '../../src/config-env-overrides.js'

describe('selectLogTransport', () => {
  const base = { isTTY: true, nodeEnv: 'development', prettyAvailable: true }
  it('uses pino-pretty for interactive non-production runs', () => {
    expect(selectLogTransport(base)?.target).toBe('pino-pretty')
  })
  it.each([
    ['production', { nodeEnv: 'production' }],
    ['non-TTY', { isTTY: false }],
    ['pino-pretty missing', { prettyAvailable: false }],
  ])('falls back to JSON: %s', (_name, patch) => {
    expect(selectLogTransport({ ...base, ...patch })).toBeUndefined()
  })
})

describe('resolvePackageVersion', () => {
  it('reads the real package.json version', () => {
    expect(resolvePackageVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })
  it('returns undefined when no package.json is readable', () => {
    expect(resolvePackageVersion(() => { throw new Error('ENOENT') })).toBeUndefined()
  })
})

describe('createNoopSpanExporter', () => {
  it('reports success and retains nothing', () => {
    const exp = createNoopSpanExporter()
    let result: unknown
    exp.export([{} as never], (r) => { result = r })
    expect(result).toEqual({ code: 0 })
    expect(Object.keys(exp)).not.toContain('getFinishedSpans')
  })
})

describe('validation bounds', () => {
  it('rejects pool.min greater than pool.max', () => {
    const r = ConfigSchema.safeParse({ db: { pool: { min: 5, max: 2 } } })
    expect(r.success).toBe(false)
    expect(JSON.stringify(r.error?.issues)).toContain('db.pool.min must be less than or equal to db.pool.max')
  })
  it('accepts pool.min equal to pool.max', () => {
    expect(ConfigSchema.safeParse({ db: { pool: { min: 3, max: 3 } } }).success).toBe(true)
  })
  it.each([0, 65536, -1, 1.5, 'abc'])('rejects http port %s', (p) => {
    expect(ConfigSchema.safeParse({ listeners: { http: { port: p } } }).success).toBe(false)
  })
  it.each([1, 8080, '65535'])('accepts https port %s', (p) => {
    expect(ConfigSchema.safeParse({ listeners: { https: { port: p } } }).success).toBe(true)
  })
})

describe('JWKS env mapping', () => {
  it('maps cache max age and cooldown', () => {
    const cfg = ConfigSchema.parse(applyEnvOverrides({}, {
      OPENFGA_AUTH_OIDC_JWKS_CACHE_MAX_AGE_MS: '1234',
      OPENFGA_AUTH_OIDC_JWKS_COOLDOWN_MS: '56',
    }))
    expect(cfg.auth.oidc.jwksCacheMaxAgeMs).toBe(1234)
    expect(cfg.auth.oidc.jwksCooldownMs).toBe(56)
  })
})
