/**
 * Unit tests for the env-var → nested-config overlay.
 *
 * Pure module — exercises `applyEnvOverrides` with synthetic env
 * objects. No reads from the host process.env, no file I/O.
 */
import { describe, it, expect } from 'vitest'
import { applyEnvOverrides } from '../../src/config-env-overrides.js'
import { ConfigSchema } from '../../src/config-schema.js'

function overlay(env: Record<string, string | undefined>, raw: unknown = {}): Record<string, unknown> {
  return applyEnvOverrides(raw, env) as Record<string, unknown>
}

describe('applyEnvOverrides — mapping table', () => {
  it('OPENFGA_DB_URL → db.url', () => {
    const r = overlay({ OPENFGA_DB_URL: 'postgres://x/y' })
    expect((r.db as Record<string, unknown>).url).toBe('postgres://x/y')
  })

  it('OPENFGA_DB_NAMESPACE → db.namespace', () => {
    const r = overlay({ OPENFGA_DB_NAMESPACE: 'tenant_a' })
    expect((r.db as Record<string, unknown>).namespace).toBe('tenant_a')
  })

  it('OPENFGA_DB_APPLICATION_NAME → db.applicationName', () => {
    const r = overlay({ OPENFGA_DB_APPLICATION_NAME: 'my-app' })
    expect((r.db as Record<string, unknown>).applicationName).toBe('my-app')
  })

  it.each([
    ['OPENFGA_DB_POOL_MAX', 'max'],
    ['OPENFGA_DB_POOL_MIN', 'min'],
    ['OPENFGA_DB_POOL_IDLE_TIMEOUT_MS', 'idleTimeoutMs'],
    ['OPENFGA_DB_POOL_CONNECTION_TIMEOUT_MS', 'connectionTimeoutMs'],
    ['OPENFGA_DB_STATEMENT_TIMEOUT_MS', 'statementTimeoutMs'],
    ['OPENFGA_DB_QUERY_TIMEOUT_MS', 'queryTimeoutMs'],
  ])('%s → db.pool.%s', (envKey, configKey) => {
    const r = overlay({ [envKey]: '42' })
    expect(((r.db as Record<string, unknown>).pool as Record<string, unknown>)[configKey]).toBe('42')
  })

  it('OPENFGA_HTTP_ENABLED → listeners.http.enabled', () => {
    const r = overlay({ OPENFGA_HTTP_ENABLED: 'false' })
    expect(((r.listeners as Record<string, unknown>).http as Record<string, unknown>).enabled).toBe('false')
  })

  it('OPENFGA_HTTP_PORT → listeners.http.port', () => {
    const r = overlay({ OPENFGA_HTTP_PORT: '9000' })
    expect(((r.listeners as Record<string, unknown>).http as Record<string, unknown>).port).toBe('9000')
  })

  it('OPENFGA_HTTPS_PORT → listeners.https.port', () => {
    const r = overlay({ OPENFGA_HTTPS_PORT: '9443' })
    expect(((r.listeners as Record<string, unknown>).https as Record<string, unknown>).port).toBe('9443')
  })

  it('OPENFGA_TLS_CERT_FILE / OPENFGA_TLS_KEY_FILE → tls.{certFile,keyFile}', () => {
    const r = overlay({
      OPENFGA_TLS_CERT_FILE: '/etc/cert.pem',
      OPENFGA_TLS_KEY_FILE: '/etc/key.pem',
    })
    expect((r.tls as Record<string, unknown>).certFile).toBe('/etc/cert.pem')
    expect((r.tls as Record<string, unknown>).keyFile).toBe('/etc/key.pem')
  })

  it('OPENFGA_LOG_LEVEL → log.level', () => {
    const r = overlay({ OPENFGA_LOG_LEVEL: 'debug' })
    expect((r.log as Record<string, unknown>).level).toBe('debug')
  })

  it('OPENFGA_AUTH_MODE → auth.mode', () => {
    const r = overlay({ OPENFGA_AUTH_MODE: 'preshared' })
    expect((r.auth as Record<string, unknown>).mode).toBe('preshared')
  })

  it('OPENFGA_IDEMPOTENCY_MODE / TTL_MS → idempotency.*', () => {
    const r = overlay({
      OPENFGA_IDEMPOTENCY_MODE: 'required',
      OPENFGA_IDEMPOTENCY_TTL_MS: '60000',
    })
    expect((r.idempotency as Record<string, unknown>).mode).toBe('required')
    expect((r.idempotency as Record<string, unknown>).ttlMs).toBe('60000')
  })

  it('OPENFGA_API_URL / STORE_NAME / STORE_ID → loadModel.*', () => {
    const r = overlay({
      OPENFGA_API_URL: 'https://api.x',
      OPENFGA_STORE_NAME: 'main',
      OPENFGA_STORE_ID: '01ABC',
    })
    expect((r.loadModel as Record<string, unknown>).apiUrl).toBe('https://api.x')
    expect((r.loadModel as Record<string, unknown>).storeName).toBe('main')
    expect((r.loadModel as Record<string, unknown>).storeId).toBe('01ABC')
  })

  it('OPENFGA_MIGRATE_ON_START → migrateOnStart', () => {
    const r = overlay({ OPENFGA_MIGRATE_ON_START: 'true' })
    expect(r.migrateOnStart).toBe('true')
  })

  it.each([
    ['OPENFGA_AUTH_OIDC_ISSUER', 'issuer', 'https://auth.example.com'],
    ['OPENFGA_AUTH_OIDC_AUDIENCE', 'audience', 'openfga'],
    ['OPENFGA_AUTH_OIDC_CLOCK_SKEW_SEC', 'clockSkewSec', '120'],
    ['OPENFGA_AUTH_OIDC_JWKS_URI', 'jwksUri', 'https://auth.example.com/.well-known/jwks.json'],
  ])('%s → auth.oidc.%s', (envKey, configKey, value) => {
    const r = overlay({ [envKey]: value })
    expect(((r.auth as Record<string, unknown>).oidc as Record<string, unknown>)[configKey]).toBe(value)
  })

  it.each([
    ['OPENFGA_AUTH_OIDC_ISSUER_ALIASES', 'issuerAliases'],
    ['OPENFGA_AUTH_OIDC_SUBJECTS', 'subjects'],
    ['OPENFGA_AUTH_OIDC_CLIENTS', 'clients'],
    ['OPENFGA_AUTH_OIDC_ALGORITHMS', 'algorithms'],
  ])('%s splits comma-separated values into auth.oidc.%s', (envKey, configKey) => {
    const r = overlay({ [envKey]: 'a, b,,c,' })
    expect(((r.auth as Record<string, unknown>).oidc as Record<string, unknown>)[configKey]).toEqual(['a', 'b', 'c'])
  })
})

describe('applyEnvOverrides — empty-string semantics', () => {
  it('skips empty-string optional string fields (TLS files)', () => {
    const r = overlay({ OPENFGA_TLS_CERT_FILE: '', OPENFGA_TLS_KEY_FILE: '' })
    expect(r.tls).toBeUndefined()
  })

  it('skips whitespace-only optional string fields', () => {
    const r = overlay({ OPENFGA_STORE_ID: '   ' })
    expect(r.loadModel).toBeUndefined()
  })

  it('skips empty-string integer fields (pool max)', () => {
    const r = overlay({ OPENFGA_DB_POOL_MAX: '' })
    expect(r.db).toBeUndefined()
  })

  it('skips empty-string TTL', () => {
    const r = overlay({ OPENFGA_IDEMPOTENCY_TTL_MS: '' })
    expect(r.idempotency).toBeUndefined()
  })

  it('skips empty-string port (intentional tightening from current Number(\'\') → 0)', () => {
    const r = overlay({ OPENFGA_HTTP_PORT: '' })
    expect(r.listeners).toBeUndefined()
  })

  it('skips empty-string db.url so schema-level optional applies', () => {
    const r = overlay({ OPENFGA_DB_URL: '' })
    expect(r.db).toBeUndefined()
  })
})

describe('applyEnvOverrides — comma-separated arrays', () => {
  it('splits OPENFGA_AUTH_PRESHARED_KEYS on commas and trims entries', () => {
    const r = overlay({ OPENFGA_AUTH_PRESHARED_KEYS: 'k1, k2 ,k3' })
    expect((r.auth as Record<string, unknown>).presharedKeys).toEqual(['k1', 'k2', 'k3'])
  })

  it('drops empty entries from the keys list', () => {
    const r = overlay({ OPENFGA_AUTH_PRESHARED_KEYS: 'k1,,k2,, ,k3' })
    expect((r.auth as Record<string, unknown>).presharedKeys).toEqual(['k1', 'k2', 'k3'])
  })

  it('produces an empty array when the env var is empty', () => {
    // empty trimmed → readNonEmpty returns undefined → key is not written;
    // schema default ([]) applies.
    const r = overlay({ OPENFGA_AUTH_PRESHARED_KEYS: '' })
    expect(r.auth).toBeUndefined()
  })
})

describe('applyEnvOverrides — preserves raw object', () => {
  it('leaves unrelated fields untouched', () => {
    const raw = { db: { url: 'from-file', namespace: 'fromfile' } }
    const r = overlay({ OPENFGA_DB_URL: 'from-env' }, raw)
    expect((r.db as Record<string, unknown>).url).toBe('from-env')
    expect((r.db as Record<string, unknown>).namespace).toBe('fromfile')
  })

  it('does not mutate the raw object', () => {
    const raw = { db: { url: 'original' } }
    overlay({ OPENFGA_DB_URL: 'override' }, raw)
    expect(raw.db.url).toBe('original')
  })

  it('overwrites file values when env var is set', () => {
    const raw = { listeners: { http: { port: 8000 } } }
    const r = overlay({ OPENFGA_HTTP_PORT: '9000' }, raw)
    expect(((r.listeners as Record<string, unknown>).http as Record<string, unknown>).port).toBe('9000')
  })

  it('keeps file values when env var is empty', () => {
    const raw = { listeners: { http: { port: 8000 } } }
    const r = overlay({ OPENFGA_HTTP_PORT: '' }, raw)
    expect(((r.listeners as Record<string, unknown>).http as Record<string, unknown>).port).toBe(8000)
  })

  it('keeps file values when env var is unset', () => {
    const raw = { listeners: { http: { port: 8000 } } }
    const r = overlay({}, raw)
    expect(((r.listeners as Record<string, unknown>).http as Record<string, unknown>).port).toBe(8000)
  })
})

describe('applyEnvOverrides + ConfigSchema — round-trip', () => {
  it('an env-only setup produces a valid config', () => {
    const merged = applyEnvOverrides({}, {
      OPENFGA_DB_URL: 'postgres://localhost/test',
      OPENFGA_LOG_LEVEL: 'debug',
      OPENFGA_IDEMPOTENCY_MODE: 'required',
      OPENFGA_IDEMPOTENCY_TTL_MS: '60000',
    })
    const cfg = ConfigSchema.parse(merged)
    expect(cfg.db.url).toBe('postgres://localhost/test')
    expect(cfg.log.level).toBe('debug')
    expect(cfg.idempotency.mode).toBe('required')
    expect(cfg.idempotency.ttlMs).toBe(60_000)
  })

  it('env-overlay TLS pair both empty produces no TLS section, schema accepts', () => {
    const merged = applyEnvOverrides({}, {
      OPENFGA_TLS_CERT_FILE: '',
      OPENFGA_TLS_KEY_FILE: '',
    })
    const cfg = ConfigSchema.parse(merged)
    expect(cfg.tls.certFile).toBeUndefined()
    expect(cfg.tls.keyFile).toBeUndefined()
  })

  it('env-overlay TLS pair both set produces a TLS section, schema accepts', () => {
    const merged = applyEnvOverrides({}, {
      OPENFGA_TLS_CERT_FILE: '/c',
      OPENFGA_TLS_KEY_FILE: '/k',
    })
    const cfg = ConfigSchema.parse(merged)
    expect(cfg.tls.certFile).toBe('/c')
    expect(cfg.tls.keyFile).toBe('/k')
  })

  it('env-overlay TLS only one set produces a malformed config, schema rejects', () => {
    const merged = applyEnvOverrides({}, { OPENFGA_TLS_CERT_FILE: '/c' })
    expect(ConfigSchema.safeParse(merged).success).toBe(false)
  })
})


it('configures the BatchCheck limit through file and upstream environment names', () => {
  expect(ConfigSchema.parse(applyEnvOverrides({ maxChecksPerBatchCheck: 100 }, {})).maxChecksPerBatchCheck).toBe(100)
  expect(ConfigSchema.parse(applyEnvOverrides({ maxChecksPerBatchCheck: 100 }, { OPENFGA_MAX_CHECKS_PER_BATCH_CHECK: '2' })).maxChecksPerBatchCheck).toBe(2)
  expect(ConfigSchema.parse(applyEnvOverrides({}, { OPENFGA_MAX_CHECKS_PER_BATCH_CHECK: '' })).maxChecksPerBatchCheck).toBe(50)
})
