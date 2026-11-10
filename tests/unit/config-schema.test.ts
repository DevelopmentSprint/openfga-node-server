/**
 * Unit tests for the configuration Zod schema.
 *
 * Pure module — exercises `ConfigSchema` parsing in isolation. No
 * environment, no file I/O, no side effects.
 */
import { describe, it, expect } from 'vitest'
import { ConfigSchema } from '../../src/config-schema.js'

describe('ConfigSchema — defaults', () => {
  it('parses an empty object to a fully-defaulted config', () => {
    const cfg = ConfigSchema.parse({})
    expect(cfg.db.namespace).toBe('openfga')
    expect(cfg.db.applicationName).toBe('openfga-node-server')
    expect(cfg.db.url).toBeUndefined()
    expect(cfg.db.pool.max).toBe(10)
    expect(cfg.db.pool.min).toBe(0)
    expect(cfg.db.pool.idleTimeoutMs).toBe(30_000)
    expect(cfg.db.pool.connectionTimeoutMs).toBe(0)
    expect(cfg.db.pool.statementTimeoutMs).toBe(0)
    expect(cfg.db.pool.queryTimeoutMs).toBe(0)
    expect(cfg.listeners.http.enabled).toBe(true)
    expect(cfg.listeners.http.port).toBe(8080)
    expect(cfg.listeners.https.port).toBe(8443)
    expect(cfg.tls.certFile).toBeUndefined()
    expect(cfg.tls.keyFile).toBeUndefined()
    expect(cfg.log.level).toBe('info')
    expect(cfg.auth.mode).toBe('none')
    expect(cfg.auth.presharedKeys).toEqual([])
    expect(cfg.idempotency.mode).toBe('off')
    expect(cfg.idempotency.ttlMs).toBe(86_400_000)
    expect(cfg.writeFences.enabled).toBe(false)
    expect(cfg.loadModel.apiUrl).toBe('http://localhost:8080')
    expect(cfg.loadModel.storeName).toBe('default')
    expect(cfg.loadModel.storeId).toBeUndefined()
    expect(cfg.migrateOnStart).toBe(false)
    expect(cfg.maxChecksPerBatchCheck).toBe(50)
  })

  it('accepts a fully-specified config object', () => {
    const cfg = ConfigSchema.parse({
      db: {
        url: 'postgres://localhost/openfga',
        namespace: 'openfga_test',
        applicationName: 'test-app',
        pool: { max: 5, min: 1, idleTimeoutMs: 10_000, connectionTimeoutMs: 5_000 },
      },
      listeners: {
        http: { enabled: false, port: 9000 },
        https: { port: 9443 },
      },
      tls: { certFile: '/etc/cert.pem', keyFile: '/etc/key.pem' },
      log: { level: 'debug' },
      auth: { mode: 'preshared', presharedKeys: ['k1', 'k2'] },
      idempotency: { mode: 'required', ttlMs: 60_000 },
      loadModel: { apiUrl: 'https://api.example.com', storeName: 'main', storeId: '01ABC' },
      migrateOnStart: true,
    })
    expect(cfg.db.url).toBe('postgres://localhost/openfga')
    expect(cfg.listeners.http.enabled).toBe(false)
    expect(cfg.tls.certFile).toBe('/etc/cert.pem')
    expect(cfg.auth.mode).toBe('preshared')
    expect(cfg.auth.presharedKeys).toEqual(['k1', 'k2'])
    expect(cfg.idempotency.ttlMs).toBe(60_000)
    expect(cfg.migrateOnStart).toBe(true)
  })
})

describe('ConfigSchema — db.namespace', () => {
  it('accepts default-shaped names', () => {
    expect(ConfigSchema.parse({ db: { namespace: 'openfga' } }).db.namespace).toBe('openfga')
    expect(ConfigSchema.parse({ db: { namespace: 'app_authz' } }).db.namespace).toBe('app_authz')
  })

  it('rejects names starting with a digit', () => {
    const result = ConfigSchema.safeParse({ db: { namespace: '1openfga' } })
    expect(result.success).toBe(false)
  })

  it('rejects names with uppercase letters', () => {
    expect(ConfigSchema.safeParse({ db: { namespace: 'OpenFGA' } }).success).toBe(false)
  })

  it('rejects names with hyphens or other punctuation', () => {
    expect(ConfigSchema.safeParse({ db: { namespace: 'open-fga' } }).success).toBe(false)
    expect(ConfigSchema.safeParse({ db: { namespace: 'open.fga' } }).success).toBe(false)
  })
})

describe('ConfigSchema — boolean coercion', () => {
  it.each([
    ['true', true],
    ['false', false],
    ['TRUE', true],
    ['False', false],
    ['  true  ', true],
  ])('strictBool accepts %s as %s', (input, expected) => {
    expect(ConfigSchema.parse({ migrateOnStart: input }).migrateOnStart).toBe(expected)
    // For listeners.http.enabled, provide TLS pair when disabling HTTP so the
    // "at least one listener" cross-field check doesn't fire.
    const cfg = ConfigSchema.parse({
      listeners: { http: { enabled: input } },
      tls: { certFile: '/c', keyFile: '/k' },
    })
    expect(cfg.listeners.http.enabled).toBe(expected)
  })

  it('rejects non-boolean strings', () => {
    const r = ConfigSchema.safeParse({ migrateOnStart: 'yes' })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues[0]!.message).toContain('migrateOnStart')
      expect(r.error.issues[0]!.message).toContain('yes')
    }
  })
})

describe('ConfigSchema — integer coercion', () => {
  it.each([
    ['0', 0],
    ['10', 10],
    [42, 42],
  ])('nonNegativeInt accepts %s', (input, expected) => {
    expect(ConfigSchema.parse({ db: { pool: { max: input } } }).db.pool.max).toBe(expected)
  })

  it.each([
    '-1',
    '1.5',
    'abc',
  ])('nonNegativeInt rejects %s', (bad) => {
    const r = ConfigSchema.safeParse({ db: { pool: { max: bad } } })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues[0]!.message).toContain('non-negative integer')
    }
  })

  it('positiveInt rejects 0 and negatives for idempotency.ttlMs', () => {
    expect(ConfigSchema.safeParse({ idempotency: { ttlMs: 0 } }).success).toBe(false)
    expect(ConfigSchema.safeParse({ idempotency: { ttlMs: '-1' } }).success).toBe(false)
    expect(ConfigSchema.safeParse({ idempotency: { ttlMs: 1 } }).success).toBe(true)
  })

  it('positiveInt error message identifies the field', () => {
    const r = ConfigSchema.safeParse({ idempotency: { ttlMs: 0 } })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues[0]!.message).toContain('idempotency.ttlMs')
      expect(r.error.issues[0]!.message).toContain('positive integer')
    }
  })
})

describe('ConfigSchema — cross-field constraints', () => {
  it('rejects HTTP and HTTPS on the same port when both are active', () => {
    const r = ConfigSchema.safeParse({
      listeners: { http: { enabled: true, port: 8443 }, https: { port: 8443 } },
      tls: { certFile: '/c', keyFile: '/k' },
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some(i => i.message.includes('cannot be equal'))).toBe(true)
    }
  })

  it('allows HTTP and HTTPS on the same port number when HTTPS is not enabled', () => {
    const r = ConfigSchema.safeParse({
      listeners: { http: { enabled: true, port: 8443 }, https: { port: 8443 } },
    })
    expect(r.success).toBe(true)
  })

  it('rejects TLS cert without key', () => {
    const r = ConfigSchema.safeParse({ tls: { certFile: '/c' } })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some(i => i.message.includes('both be set together'))).toBe(true)
    }
  })

  it('rejects TLS key without cert', () => {
    expect(ConfigSchema.safeParse({ tls: { keyFile: '/k' } }).success).toBe(false)
  })

  it('rejects http.enabled=false without TLS', () => {
    const r = ConfigSchema.safeParse({
      listeners: { http: { enabled: false } },
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some(i => i.message.includes('no listener'))).toBe(true)
    }
  })

  it('accepts http.enabled=false with TLS configured', () => {
    const r = ConfigSchema.safeParse({
      listeners: { http: { enabled: false } },
      tls: { certFile: '/c', keyFile: '/k' },
    })
    expect(r.success).toBe(true)
  })

  it('rejects auth.mode=preshared with empty presharedKeys', () => {
    const r = ConfigSchema.safeParse({ auth: { mode: 'preshared', presharedKeys: [] } })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some(i => i.message.includes('at least one'))).toBe(true)
    }
  })

  it('accepts auth.mode=preshared with at least one key', () => {
    const r = ConfigSchema.safeParse({ auth: { mode: 'preshared', presharedKeys: ['k1'] } })
    expect(r.success).toBe(true)
  })

  it('rejects auth.mode=oidc without issuer', () => {
    const r = ConfigSchema.safeParse({
      auth: { mode: 'oidc', oidc: { audience: 'aud' } },
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some(i => i.message.includes('auth.oidc.issuer'))).toBe(true)
    }
  })

  it('rejects auth.mode=oidc without audience', () => {
    const r = ConfigSchema.safeParse({
      auth: { mode: 'oidc', oidc: { issuer: 'https://auth.example.com' } },
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some(i => i.message.includes('auth.oidc.audience'))).toBe(true)
    }
  })

  it('accepts auth.mode=oidc with issuer + audience set', () => {
    const r = ConfigSchema.safeParse({
      auth: {
        mode: 'oidc',
        oidc: { issuer: 'https://auth.example.com', audience: 'openfga' },
      },
    })
    expect(r.success).toBe(true)
  })

  it('rejects HS256 in auth.oidc.algorithms', () => {
    const r = ConfigSchema.safeParse({
      auth: {
        mode: 'oidc',
        oidc: {
          issuer: 'https://auth.example.com',
          audience: 'openfga',
          algorithms: ['HS256'],
        },
      },
    })
    expect(r.success).toBe(false)
  })

  it('rejects empty auth.oidc.algorithms when mode=oidc', () => {
    const r = ConfigSchema.safeParse({
      auth: {
        mode: 'oidc',
        oidc: {
          issuer: 'https://auth.example.com',
          audience: 'openfga',
          algorithms: [],
        },
      },
    })
    expect(r.success).toBe(false)
  })
})

describe('ConfigSchema — enums', () => {
  it('rejects unknown log level', () => {
    expect(ConfigSchema.safeParse({ log: { level: 'verbose' } }).success).toBe(false)
  })

  it('rejects unknown idempotency mode', () => {
    expect(ConfigSchema.safeParse({ idempotency: { mode: 'always' } }).success).toBe(false)
  })

  it('rejects unknown auth mode', () => {
    expect(ConfigSchema.safeParse({ auth: { mode: 'oauth2' } }).success).toBe(false)
  })
})


describe('ConfigSchema — BatchCheck limit', () => {
  it.each([0, -1, 1.5, 'invalid', 4294967296])('rejects invalid limit %j', value => {
    expect(ConfigSchema.safeParse({ maxChecksPerBatchCheck: value }).success).toBe(false)
  })
})
