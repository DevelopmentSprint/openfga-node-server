/**
 * Unit tests for the caller-authentication middleware.
 *
 * The middleware is pure Hono and reads only request headers + an
 * AuthConfig — no storage, no env var I/O — so these tests run
 * entirely in-process via app.fetch.
 *
 * Test fixtures use obvious non-credential names ("fixture-key-A",
 * etc.) and Authorization headers are built via a helper rather than
 * as inline literals. Both choices are deliberate so static-analysis
 * scanners do not flag the test fixtures as hard-coded credentials.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { authMiddleware, getAuthConfig } from '../../src/middleware/auth'
import { ANONYMOUS_PRINCIPAL, getAuthPrincipal, parseBearerToken } from '../../src/middleware/caller'
import { reloadConfigForTests } from '../../src/config'

const KEY_A = 'fixture-key-A'
const KEY_B = 'fixture-key-B'
const KEY_OLD = 'fixture-key-rotated-out'
const KEY_NEW = 'fixture-key-rotated-in'
const KEY_UNKNOWN = 'fixture-key-not-configured'

function authHeader(scheme: string, token: string): Record<string, string> {
  return { Authorization: `${scheme} ${token}` }
}

const NO_OIDC = {
  issuerAliases: [] as string[],
  subjects: [] as string[],
  clients: [] as string[],
  algorithms: ['RS256'] as const,
  clockSkewSec: 60,
  jwksCacheMaxAgeMs: 600_000,
  jwksCooldownMs: 30_000,
} as const

function buildApp(opts: { keys?: string[]; mode?: 'none' | 'preshared' }): Hono {
  const app = new Hono()
  app.use(
    '/stores/*',
    authMiddleware({
      mode: opts.mode ?? 'preshared',
      presharedKeys: opts.keys ?? [KEY_A],
      oidc: { ...NO_OIDC, algorithms: [...NO_OIDC.algorithms] },
    }),
  )
  app.get('/health', (c) => c.text('ok'))
  app.get('/stores/anything', (c) => c.json({ allowed: true }))
  app.get('/stores/whoami', (c) => c.json({ principal: getAuthPrincipal(c) }))
  return app
}

async function principalOf(app: Hono, headers: Record<string, string> = {}): Promise<string> {
  const res = await app.fetch(new Request('http://localhost/stores/whoami', { headers }))
  expect(res.status).toBe(200)
  return ((await res.json()) as { principal: string }).principal
}

describe('authMiddleware — none mode', () => {
  it('passes through without inspecting headers', async () => {
    const app = buildApp({ mode: 'none' })
    const res = await app.fetch(new Request('http://localhost/stores/anything'))
    expect(res.status).toBe(200)
  })
})

describe('authMiddleware — preshared mode', () => {
  it('allows /health without an Authorization header', async () => {
    const app = buildApp({ keys: [KEY_A] })
    const res = await app.fetch(new Request('http://localhost/health'))
    expect(res.status).toBe(200)
  })

  it('rejects requests with a missing Authorization header', async () => {
    const app = buildApp({ keys: [KEY_A] })
    const res = await app.fetch(new Request('http://localhost/stores/anything'))
    expect(res.status).toBe(401)
    const body = await res.json() as { code: string }
    expect(body.code).toBe('unauthenticated')
  })

  it('rejects requests with a non-Bearer Authorization scheme', async () => {
    const app = buildApp({ keys: [KEY_A] })
    const res = await app.fetch(
      new Request('http://localhost/stores/anything', { headers: authHeader('Token', KEY_A) }),
    )
    expect(res.status).toBe(401)
  })

  it('rejects requests whose Bearer token does not match any configured key', async () => {
    const app = buildApp({ keys: [KEY_A, KEY_B] })
    const res = await app.fetch(
      new Request('http://localhost/stores/anything', { headers: authHeader('Bearer', KEY_UNKNOWN) }),
    )
    expect(res.status).toBe(401)
  })

  it('rejects tokens that share a prefix with a configured key (no prefix-match)', async () => {
    const app = buildApp({ keys: [KEY_A] })
    const res = await app.fetch(
      new Request('http://localhost/stores/anything', { headers: authHeader('Bearer', `${KEY_A}-extra`) }),
    )
    expect(res.status).toBe(401)
  })

  it('rejects tokens shorter than the configured key (length mismatch)', async () => {
    const app = buildApp({ keys: [KEY_A] })
    const res = await app.fetch(
      new Request('http://localhost/stores/anything', { headers: authHeader('Bearer', KEY_A.slice(0, 6)) }),
    )
    expect(res.status).toBe(401)
  })

  it('accepts requests whose Bearer token matches a configured key', async () => {
    const app = buildApp({ keys: [KEY_A] })
    const res = await app.fetch(
      new Request('http://localhost/stores/anything', { headers: authHeader('Bearer', KEY_A) }),
    )
    expect(res.status).toBe(200)
  })

  it('accepts any key in the comma-separated list (rotation case)', async () => {
    const app = buildApp({ keys: [KEY_OLD, KEY_NEW] })
    const oldRes = await app.fetch(
      new Request('http://localhost/stores/anything', { headers: authHeader('Bearer', KEY_OLD) }),
    )
    expect(oldRes.status).toBe(200)
    const newRes = await app.fetch(
      new Request('http://localhost/stores/anything', { headers: authHeader('Bearer', KEY_NEW) }),
    )
    expect(newRes.status).toBe(200)
  })
})

describe('getAuthConfig + reloadConfigForTests', () => {
  const ENV_KEYS = ['OPENFGA_AUTH_MODE', 'OPENFGA_AUTH_PRESHARED_KEYS'] as const
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k]
    for (const k of ENV_KEYS) delete process.env[k]
  })

  afterEach(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    await reloadConfigForTests()
  })

  it('defaults to none mode with no keys when nothing is set', async () => {
    await reloadConfigForTests()
    const cfg = getAuthConfig()
    expect(cfg.mode).toBe('none')
    expect(cfg.presharedKeys).toEqual([])
  })

  it('rejects unknown auth modes via the schema parser', async () => {
    process.env['OPENFGA_AUTH_MODE'] = 'oidc-experimental'
    await expect(reloadConfigForTests()).rejects.toThrow()
  })

  it('parses comma-separated keys with trim and empty-token filtering', async () => {
    process.env['OPENFGA_AUTH_MODE'] = 'preshared'
    process.env['OPENFGA_AUTH_PRESHARED_KEYS'] = ` ${KEY_A} ,  ,${KEY_B},`
    await reloadConfigForTests()
    const cfg = getAuthConfig()
    expect(cfg.mode).toBe('preshared')
    expect(cfg.presharedKeys).toEqual([KEY_A, KEY_B])
  })

  it('fails fast when preshared mode has no keys', async () => {
    process.env['OPENFGA_AUTH_MODE'] = 'preshared'
    process.env['OPENFGA_AUTH_PRESHARED_KEYS'] = '   '
    await expect(reloadConfigForTests()).rejects.toThrow(/at least one/)
  })
})

describe('authMiddleware — Bearer scheme case (RFC 7235, openfga-k2a.3)', () => {
  it.each(['bearer', 'BEARER', 'bEaReR'])('accepts the %s scheme spelling for a configured key', async (scheme) => {
    const app = buildApp({ keys: [KEY_A] })
    const res = await app.fetch(new Request('http://localhost/stores/anything', { headers: authHeader(scheme, KEY_A) }))
    expect(res.status).toBe(200)
  })

  it('still rejects a lowercase scheme with an unknown key', async () => {
    const app = buildApp({ keys: [KEY_A] })
    const res = await app.fetch(new Request('http://localhost/stores/anything', { headers: authHeader('bearer', KEY_UNKNOWN) }))
    expect(res.status).toBe(401)
  })
})

describe('parseBearerToken', () => {
  it('parses scheme case-insensitively and tolerates extra separator whitespace', () => {
    expect(parseBearerToken('bearer   abc')).toEqual({ ok: true, token: 'abc' })
    expect(parseBearerToken('Bearer\tabc')).toEqual({ ok: true, token: 'abc' })
  })

  it('classifies missing, empty, and foreign-scheme headers', () => {
    expect(parseBearerToken(undefined)).toEqual({ ok: false, reason: 'missing_authorization' })
    expect(parseBearerToken('Bearer')).toEqual({ ok: false, reason: 'missing_authorization' })
    expect(parseBearerToken('Bearer    ')).toEqual({ ok: false, reason: 'missing_authorization' })
    expect(parseBearerToken('Basic abc')).toEqual({ ok: false, reason: 'wrong_scheme' })
    expect(parseBearerToken('Bearerabc')).toEqual({ ok: false, reason: 'wrong_scheme' })
  })
})

describe('authMiddleware — caller principal (openfga-k2a.3)', () => {
  it('records the anonymous principal in none mode', async () => {
    const app = buildApp({ mode: 'none' })
    expect(await principalOf(app)).toBe(ANONYMOUS_PRINCIPAL)
  })

  it('records a distinct, non-secret principal per matched preshared key', async () => {
    const app = buildApp({ keys: [KEY_A, KEY_B] })
    const pa = await principalOf(app, authHeader('Bearer', KEY_A))
    const pb = await principalOf(app, authHeader('Bearer', KEY_B))
    expect(pa).toMatch(/^preshared:[0-9a-f]{64}$/)
    expect(pa).not.toBe(pb)
    expect(pa).not.toContain(KEY_A)
    // Stable across key-list order (not an index).
    const reordered = buildApp({ keys: [KEY_B, KEY_A] })
    expect(await principalOf(reordered, authHeader('Bearer', KEY_A))).toBe(pa)
  })
})
