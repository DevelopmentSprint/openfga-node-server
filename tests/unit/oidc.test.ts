/**
 * Unit tests for the OIDC bearer-token middleware.
 *
 * Generates an in-memory RSA keypair, exposes a fixture JWKS endpoint
 * via @hono/node-server on a random port, and exercises the full
 * validation pipeline (sig / iss / aud / exp / nbf / alg / sub /
 * client). The middleware is composed with an explicit `jwksUri`
 * pointing at the fixture server so no real-world OIDC discovery
 * fires during tests.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from 'jose'
import { oidcMiddleware, resetOidcDiscoveryCacheForTests } from '../../src/middleware/oidc'
import { getAuthPrincipal } from '../../src/middleware/caller'
import { logger } from '../../src/logger'
import type { OidcConfig } from '../../src/middleware/oidc'

interface KeyMaterial {
  publicKey: CryptoKey
  privateKey: CryptoKey
  kid: string
  jwk: JWK
}

async function generateKey(alg: 'RS256' | 'ES256'): Promise<KeyMaterial> {
  const kp = await generateKeyPair(alg, { extractable: true })
  const jwk = await exportJWK(kp.publicKey)
  const kid = `test-${alg}-${Math.random().toString(36).slice(2, 8)}`
  jwk.kid = kid
  jwk.alg = alg
  jwk.use = 'sig'
  return { publicKey: kp.publicKey, privateKey: kp.privateKey, kid, jwk }
}

interface Fixture {
  jwksUri: string
  issuer: string
  rs256: KeyMaterial
  es256: KeyMaterial
  rotated: KeyMaterial | null
  shutdown(): Promise<void>
}

async function bootFixture(): Promise<Fixture> {
  const rs256 = await generateKey('RS256')
  const es256 = await generateKey('ES256')
  const fixture: Fixture = {
    jwksUri: '',
    issuer: '',
    rs256,
    es256,
    rotated: null,
    shutdown: async () => {},
  }

  const jwksApp = new Hono()
  jwksApp.get('/jwks.json', (c) => {
    const keys: JWK[] = [fixture.rs256.jwk, fixture.es256.jwk]
    if (fixture.rotated) keys.push(fixture.rotated.jwk)
    return c.json({ keys })
  })

  return await new Promise((resolve) => {
    const server = serve({ fetch: jwksApp.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      fixture.jwksUri = `http://127.0.0.1:${info.port}/jwks.json`
      fixture.issuer = `http://127.0.0.1:${info.port}/`
      fixture.shutdown = () => new Promise<void>((res, rej) => {
        server.close((err) => err ? rej(err) : res())
      })
      resolve(fixture)
    })
  })
}

function defaultConfig(fixture: Fixture, overrides: Partial<OidcConfig> = {}): OidcConfig {
  return {
    issuer: fixture.issuer,
    audience: 'openfga-test',
    issuerAliases: [],
    subjects: [],
    clients: [],
    algorithms: ['RS256', 'ES256'],
    clockSkewSec: 60,
    jwksUri: fixture.jwksUri,
    // Force a short cooldown in tests so JWKS rotation cases can
    // trigger a refetch without an artificial clock advance.
    jwksCacheMaxAgeMs: 60_000,
    jwksCooldownMs: 1,
    ...overrides,
  }
}

function buildApp(cfg: OidcConfig): Hono {
  const app = new Hono()
  app.use('/stores/*', oidcMiddleware(cfg))
  app.get('/stores/anything', (c) => c.json({ allowed: true }))
  return app
}

interface SignOpts {
  key: KeyMaterial
  alg?: string
  issuer?: string
  audience?: string | string[]
  subject?: string
  expiresInSec?: number
  notBeforeSec?: number
  claims?: Record<string, unknown>
}

async function makeJwt(fixture: Fixture, opts: SignOpts): Promise<string> {
  const alg = opts.alg ?? 'RS256'
  const now = Math.floor(Date.now() / 1000)
  const exp = now + (opts.expiresInSec ?? 600)
  const nbf = opts.notBeforeSec !== undefined ? now + opts.notBeforeSec : now - 1
  const audience = opts.audience ?? 'openfga-test'

  let jwt = new SignJWT({ ...(opts.claims ?? {}) })
    .setProtectedHeader({ alg, kid: opts.key.kid })
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .setNotBefore(nbf)
    .setIssuer(opts.issuer ?? fixture.issuer)
    .setAudience(audience)
  if (opts.subject) jwt = jwt.setSubject(opts.subject)
  return jwt.sign(opts.key.privateKey)
}

async function bearer(app: Hono, token: string | undefined): Promise<Response> {
  const headers: Record<string, string> = {}
  if (token !== undefined) headers.Authorization = token
  return app.fetch(new Request('http://localhost/stores/anything', { headers }))
}

let fixture: Fixture

beforeAll(async () => {
  fixture = await bootFixture()
})

afterAll(async () => {
  await fixture.shutdown()
})

beforeEach(() => {
  resetOidcDiscoveryCacheForTests()
})

describe('oidcMiddleware — happy path', () => {
  it('accepts a valid RS256 token', async () => {
    const token = await makeJwt(fixture, { key: fixture.rs256 })
    const res = await bearer(buildApp(defaultConfig(fixture)), `Bearer ${token}`)
    expect(res.status).toBe(200)
  })

  it('accepts a valid ES256 token', async () => {
    const token = await makeJwt(fixture, { key: fixture.es256, alg: 'ES256' })
    const res = await bearer(buildApp(defaultConfig(fixture)), `Bearer ${token}`)
    expect(res.status).toBe(200)
  })
})

describe('oidcMiddleware — header handling', () => {
  it('rejects requests with no Authorization header', async () => {
    const res = await bearer(buildApp(defaultConfig(fixture)), undefined)
    expect(res.status).toBe(401)
  })

  it('rejects non-Bearer schemes', async () => {
    const token = await makeJwt(fixture, { key: fixture.rs256 })
    const res = await bearer(buildApp(defaultConfig(fixture)), `Token ${token}`)
    expect(res.status).toBe(401)
  })

  it('rejects empty Bearer token', async () => {
    const res = await bearer(buildApp(defaultConfig(fixture)), 'Bearer ')
    expect(res.status).toBe(401)
  })
})

describe('oidcMiddleware — claim validation', () => {
  it('rejects expired tokens', async () => {
    const token = await makeJwt(fixture, { key: fixture.rs256, expiresInSec: -3600 })
    const res = await bearer(buildApp(defaultConfig(fixture)), `Bearer ${token}`)
    expect(res.status).toBe(401)
  })

  it('rejects not-yet-valid tokens', async () => {
    const token = await makeJwt(fixture, { key: fixture.rs256, notBeforeSec: 3600 })
    const res = await bearer(buildApp(defaultConfig(fixture)), `Bearer ${token}`)
    expect(res.status).toBe(401)
  })

  it('rejects wrong issuer', async () => {
    const token = await makeJwt(fixture, { key: fixture.rs256, issuer: 'https://other.example.com/' })
    const res = await bearer(buildApp(defaultConfig(fixture)), `Bearer ${token}`)
    expect(res.status).toBe(401)
  })

  it('accepts a token whose iss matches issuerAliases', async () => {
    const aliasIssuer = 'https://alias.example.com/'
    const token = await makeJwt(fixture, { key: fixture.rs256, issuer: aliasIssuer })
    const cfg = defaultConfig(fixture, { issuerAliases: [aliasIssuer] })
    const res = await bearer(buildApp(cfg), `Bearer ${token}`)
    expect(res.status).toBe(200)
  })

  it('rejects wrong audience', async () => {
    const token = await makeJwt(fixture, { key: fixture.rs256, audience: 'someone-else' })
    const res = await bearer(buildApp(defaultConfig(fixture)), `Bearer ${token}`)
    expect(res.status).toBe(401)
  })

  it('tolerates clock skew within clockSkewSec', async () => {
    // Token expired 30 seconds ago. clockSkewSec=60 means jose still
    // accepts it.
    const token = await makeJwt(fixture, { key: fixture.rs256, expiresInSec: -30 })
    const res = await bearer(buildApp(defaultConfig(fixture, { clockSkewSec: 60 })), `Bearer ${token}`)
    expect(res.status).toBe(200)
  })
})

describe('oidcMiddleware — algorithm restriction', () => {
  it('rejects a token signed with an algorithm not in the allowlist', async () => {
    const cfg = defaultConfig(fixture, { algorithms: ['ES256'] })
    const token = await makeJwt(fixture, { key: fixture.rs256, alg: 'RS256' })
    const res = await bearer(buildApp(cfg), `Bearer ${token}`)
    expect(res.status).toBe(401)
  })
})

describe('oidcMiddleware — sub allowlist', () => {
  it('accepts a sub in the allowlist', async () => {
    const cfg = defaultConfig(fixture, { subjects: ['user:alice'] })
    const token = await makeJwt(fixture, { key: fixture.rs256, subject: 'user:alice' })
    const res = await bearer(buildApp(cfg), `Bearer ${token}`)
    expect(res.status).toBe(200)
  })

  it('rejects a sub not in the allowlist', async () => {
    const cfg = defaultConfig(fixture, { subjects: ['user:alice'] })
    const token = await makeJwt(fixture, { key: fixture.rs256, subject: 'user:bob' })
    const res = await bearer(buildApp(cfg), `Bearer ${token}`)
    expect(res.status).toBe(401)
  })
})

describe('oidcMiddleware — client allowlist', () => {
  it('accepts when client_id matches the allowlist', async () => {
    const cfg = defaultConfig(fixture, { clients: ['svc-a'] })
    const token = await makeJwt(fixture, {
      key: fixture.rs256,
      claims: { client_id: 'svc-a' },
    })
    const res = await bearer(buildApp(cfg), `Bearer ${token}`)
    expect(res.status).toBe(200)
  })

  it('accepts when azp matches the allowlist (no client_id)', async () => {
    const cfg = defaultConfig(fixture, { clients: ['svc-b'] })
    const token = await makeJwt(fixture, {
      key: fixture.rs256,
      claims: { azp: 'svc-b' },
    })
    const res = await bearer(buildApp(cfg), `Bearer ${token}`)
    expect(res.status).toBe(200)
  })

  it('rejects when neither client_id nor azp matches', async () => {
    const cfg = defaultConfig(fixture, { clients: ['svc-a'] })
    const token = await makeJwt(fixture, {
      key: fixture.rs256,
      claims: { client_id: 'svc-z' },
    })
    const res = await bearer(buildApp(cfg), `Bearer ${token}`)
    expect(res.status).toBe(401)
  })
})

describe('oidcMiddleware — JWKS rotation', () => {
  it('accepts a token signed by a key added to the JWKS after the middleware was built', async () => {
    const app = buildApp(defaultConfig(fixture))

    // Prime the middleware with an initial successful verification so
    // the JWKS is fetched once with the original key set.
    const primer = await makeJwt(fixture, { key: fixture.rs256 })
    expect((await bearer(app, `Bearer ${primer}`)).status).toBe(200)

    // Rotate: add a new RS256 key to the fixture's published JWKS.
    const rotated = await generateKey('RS256')
    fixture.rotated = rotated

    // Sign a token with the new kid; jose refetches the JWKS on a kid
    // miss and the new key is accepted.
    const token = await makeJwt(fixture, { key: rotated })
    const res = await bearer(app, `Bearer ${token}`)
    expect(res.status).toBe(200)

    // Clean up so other tests' fixtures aren't affected.
    fixture.rotated = null
  })
})

describe('oidcMiddleware — required exp claim (openfga-k2a.3)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('rejects a correctly signed token that carries no exp claim, logging time_claim_invalid', async () => {
    const warn = vi.spyOn(logger, 'warn')
    const now = Math.floor(Date.now() / 1000)
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: fixture.rs256.kid })
      .setIssuedAt(now)
      .setNotBefore(now - 1)
      .setIssuer(fixture.issuer)
      .setAudience('openfga-test')
      .sign(fixture.rs256.privateKey)

    const res = await bearer(buildApp(defaultConfig(fixture)), `Bearer ${token}`)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({
      code: 'unauthenticated',
      message: 'missing or invalid Authorization header',
    })
    const rejection = warn.mock.calls.find(call => call[1] === 'auth_rejected')
    expect(rejection?.[0]).toMatchObject({ reason: 'time_claim_invalid' })
  })
})

describe('oidcMiddleware — Bearer scheme case (RFC 7235, openfga-k2a.3)', () => {
  it.each(['bearer', 'BEARER', 'BeArEr'])('accepts the %s scheme spelling', async (scheme) => {
    const token = await makeJwt(fixture, { key: fixture.rs256 })
    const res = await bearer(buildApp(defaultConfig(fixture)), `${scheme} ${token}`)
    expect(res.status).toBe(200)
  })
})

describe('oidcMiddleware — caller principal (openfga-k2a.3)', () => {
  function principalApp(cfg: OidcConfig): Hono {
    const app = new Hono()
    app.use('/stores/*', oidcMiddleware(cfg))
    app.get('/stores/anything', c => c.json({ principal: getAuthPrincipal(c) }))
    return app
  }

  it('exposes a principal derived from sub and client, distinct per subject', async () => {
    const app = principalApp(defaultConfig(fixture))
    const alice = await makeJwt(fixture, { key: fixture.rs256, subject: 'alice', claims: { azp: 'svc-1' } })
    const bob = await makeJwt(fixture, { key: fixture.rs256, subject: 'bob', claims: { azp: 'svc-1' } })
    const pa = (await (await bearer(app, `Bearer ${alice}`)).json()) as { principal: string }
    const pb = (await (await bearer(app, `Bearer ${bob}`)).json()) as { principal: string }
    expect(pa.principal).toMatch(/^oidc:/)
    expect(pa.principal).toContain('alice')
    expect(pa.principal).not.toBe(pb.principal)
    expect(pa.principal).not.toContain(alice)
  })
})
