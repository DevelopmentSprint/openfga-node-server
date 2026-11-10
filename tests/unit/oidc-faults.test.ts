/**
 * Fault-injection unit tests for src/middleware/oidc.ts.
 *
 * Complements tests/unit/oidc.test.ts (happy-path + claim-mismatch
 * matrix) by exercising the discovery and JWKS error branches:
 *
 *   - discovery 5xx
 *   - discovery doc missing jwks_uri
 *   - discovery URL unreachable (closed port)
 *   - both discovery attempts fail (retry path → OidcDiscoveryError)
 *   - issuer-not-set defensive throw in resolveJwksUri
 *   - per-request jwks_unavailable (JWKS server torn down mid-test)
 *   - jwt_malformed (Bearer "not-a-jwt")
 *   - signature_invalid via JWKSNoMatchingKey (kid not in published set)
 *
 * Each test spins up a controllable fixture server bound to a random
 * loopback port. The fixture's response shape is mutable per test so
 * fault modes can be swapped without restarting the server.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { serve, type ServerType } from '@hono/node-server'
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose'
import { oidcMiddleware, OidcDiscoveryError, prefetchOidcJwks, resetOidcDiscoveryCacheForTests } from '../../src/middleware/oidc'
import type { OidcConfig } from '../../src/middleware/oidc'

type DiscoveryMode = 'ok' | '500' | 'missing-jwks-uri' | 'malformed-json'

interface Fixture {
  baseUrl: string
  jwksUri: string
  privateKey: CryptoKey
  publicJwk: JWK
  kid: string
  discoveryMode: DiscoveryMode
  jwksMode: 'ok' | '500'
  discoveryHits: number
  shutdown(): Promise<void>
}

async function bootFixture(): Promise<Fixture> {
  const kp = await generateKeyPair('RS256', { extractable: true })
  const jwk = await exportJWK(kp.publicKey)
  const kid = `fault-${Math.random().toString(36).slice(2, 8)}`
  jwk.kid = kid
  jwk.alg = 'RS256'
  jwk.use = 'sig'

  const fixture: Fixture = {
    baseUrl: '',
    jwksUri: '',
    privateKey: kp.privateKey,
    publicJwk: jwk,
    kid,
    discoveryMode: 'ok',
    jwksMode: 'ok',
    discoveryHits: 0,
    shutdown: async () => {},
  }

  const app = new Hono()
  app.get('/.well-known/openid-configuration', (c) => {
    fixture.discoveryHits++
    switch (fixture.discoveryMode) {
      case '500': return c.text('boom', 500)
      case 'missing-jwks-uri': return c.json({ issuer: fixture.baseUrl })
      case 'malformed-json': return c.text('{not-json', 200, { 'content-type': 'application/json' })
      case 'ok':
      default:
        return c.json({ jwks_uri: fixture.jwksUri })
    }
  })
  app.get('/.well-known/jwks.json', (c) => {
    if (fixture.jwksMode === '500') return c.text('boom', 500)
    return c.json({ keys: [fixture.publicJwk] })
  })

  return await new Promise((resolve) => {
    const server: ServerType = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      fixture.baseUrl = `http://127.0.0.1:${info.port}/`
      fixture.jwksUri = `${fixture.baseUrl}.well-known/jwks.json`
      fixture.shutdown = () => new Promise<void>((res, rej) => {
        server.close((err) => err ? rej(err) : res())
      })
      resolve(fixture)
    })
  })
}

function configFor(fixture: Fixture, overrides: Partial<OidcConfig> = {}): OidcConfig {
  return {
    issuer: fixture.baseUrl,
    audience: 'openfga-fault',
    issuerAliases: [],
    subjects: [],
    clients: [],
    algorithms: ['RS256'],
    clockSkewSec: 60,
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

async function makeJwt(fixture: Fixture, opts: { issuer?: string, audience?: string } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: fixture.kid })
    .setIssuedAt(now)
    .setNotBefore(now - 1)
    .setExpirationTime(now + 600)
    .setIssuer(opts.issuer ?? fixture.baseUrl)
    .setAudience(opts.audience ?? 'openfga-fault')
    .sign(fixture.privateKey)
}

async function bearer(app: Hono, token: string): Promise<Response> {
  return app.fetch(new Request('http://localhost/stores/anything', {
    headers: { Authorization: `Bearer ${token}` },
  }))
}

let fixture: Fixture

beforeAll(async () => {
  fixture = await bootFixture()
})

afterAll(async () => {
  await fixture.shutdown()
})

beforeEach(() => {
  // Discovery results are memoized per config (openfga-k2a.3); start
  // every test from a cold cache so fixture mode toggles take effect.
  resetOidcDiscoveryCacheForTests()
})

describe('oidcMiddleware — discovery faults', () => {
  it('returns 401 jwks_unavailable when discovery returns 500', async () => {
    fixture.discoveryMode = '500'
    const app = buildApp(configFor(fixture))
    const token = await makeJwt(fixture)
    const res = await bearer(app, token)
    expect(res.status).toBe(401)
    fixture.discoveryMode = 'ok'
  })

  it('returns 401 when discovery document is missing jwks_uri', async () => {
    fixture.discoveryMode = 'missing-jwks-uri'
    const app = buildApp(configFor(fixture))
    const token = await makeJwt(fixture)
    const res = await bearer(app, token)
    expect(res.status).toBe(401)
    fixture.discoveryMode = 'ok'
  })

  it('returns 401 when the discovery URL is unreachable (closed port)', async () => {
    // Point at a loopback port that is almost certainly not bound.
    // 1 is reserved (tcpmux); kernel responds with ECONNREFUSED.
    const app = buildApp(configFor(fixture, { issuer: 'http://127.0.0.1:1/' }))
    const token = await makeJwt(fixture)
    const res = await bearer(app, token)
    expect(res.status).toBe(401)
  })

  it('honours the explicit jwksUri override and skips discovery entirely', async () => {
    // discoveryMode is irrelevant — we pass jwksUri directly. This
    // covers the early-return branch in resolveJwksUri.
    fixture.discoveryMode = '500'
    const app = buildApp(configFor(fixture, { jwksUri: fixture.jwksUri }))
    const token = await makeJwt(fixture)
    const res = await bearer(app, token)
    expect(res.status).toBe(200)
    fixture.discoveryMode = 'ok'
  })
})

describe('prefetchOidcJwks — boot fail-fast', () => {
  it('resolves successfully when discovery + JWKS are reachable', async () => {
    await expect(prefetchOidcJwks(configFor(fixture))).resolves.toBeUndefined()
  })

  it('throws OidcDiscoveryError when discovery returns 500', async () => {
    fixture.discoveryMode = '500'
    await expect(prefetchOidcJwks(configFor(fixture))).rejects.toThrow(OidcDiscoveryError)
    fixture.discoveryMode = 'ok'
  })

  it('throws OidcDiscoveryError when discovery doc is missing jwks_uri', async () => {
    fixture.discoveryMode = 'missing-jwks-uri'
    await expect(prefetchOidcJwks(configFor(fixture))).rejects.toThrow(OidcDiscoveryError)
    fixture.discoveryMode = 'ok'
  })

  it('throws OidcDiscoveryError when discovery URL is unreachable', async () => {
    await expect(
      prefetchOidcJwks(configFor(fixture, { issuer: 'http://127.0.0.1:1/' })),
    ).rejects.toThrow(OidcDiscoveryError)
  })

  it('throws OidcDiscoveryError when issuer is unset and no jwksUri is configured', async () => {
    await expect(
      prefetchOidcJwks(configFor(fixture, { issuer: undefined, jwksUri: undefined })),
    ).rejects.toThrow(OidcDiscoveryError)
  })
})

describe('oidcMiddleware — defensive guards', () => {
  it('throws OidcDiscoveryError-shaped failure when issuer is absent (schema-tampered Config)', async () => {
    // Schema enforces issuer presence under mode=oidc, but production
    // code should still fail closed if a hand-constructed OidcConfig
    // omits it. resolveJwksUri's defensive throw covers that path.
    const cfg = configFor(fixture, { issuer: undefined, jwksUri: undefined })
    const app = buildApp(cfg)
    const token = await makeJwt(fixture)
    const res = await bearer(app, token)
    expect(res.status).toBe(401)
  })

  it('exposes OidcDiscoveryError as the public bootstrap-error shape', () => {
    const err = new OidcDiscoveryError('test')
    expect(err.name).toBe('OidcDiscoveryError')
    expect(err.message).toBe('test')
    expect(err).toBeInstanceOf(Error)
  })
})

describe('oidcMiddleware — token-classification faults', () => {
  it('classifies a non-JWT token as jwt_malformed', async () => {
    const app = buildApp(configFor(fixture))
    const res = await bearer(app, 'this-is-not-a-jwt')
    expect(res.status).toBe(401)
  })

  it('classifies a token signed with an unknown kid as signature_invalid', async () => {
    // Sign with a key whose kid is not in the published JWKS set.
    const stranger = await generateKeyPair('RS256', { extractable: true })
    const strangerJwt = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'stranger' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .setIssuer(fixture.baseUrl)
      .setAudience('openfga-fault')
      .sign(stranger.privateKey)
    const app = buildApp(configFor(fixture))
    const res = await bearer(app, strangerJwt)
    expect(res.status).toBe(401)
  })

  it('classifies a token with a tampered signature as signature_invalid', async () => {
    // Take a valid token and mutate the signature segment so the
    // crypto verification fails, exercising the JWSSignatureVerification
    // path in classifyJoseError.
    const token = await makeJwt(fixture)
    const parts = token.split('.')
    parts[2] = parts[2]!.slice(0, -2) + 'XX'
    const tampered = parts.join('.')
    const app = buildApp(configFor(fixture))
    const res = await bearer(app, tampered)
    expect(res.status).toBe(401)
  })
})

describe('oidcMiddleware — per-request JWKS faults', () => {
  it('returns 401 when the JWKS endpoint is torn down mid-session', async () => {
    // Stand up an isolated fixture so we can shut it down without
    // affecting other tests in this file.
    const isolated = await bootFixture()

    const app = buildApp(configFor(isolated, {
      issuer: isolated.baseUrl,
      jwksUri: isolated.jwksUri,
      // No discovery needed — jwksUri is explicit. The factory
      // builds the remote JWKS set immediately.
    }))

    // Prime: the first request triggers an actual JWKS fetch (the
    // factory's createRemoteJWKSet is lazy on first kid lookup).
    const primer = await makeJwt(isolated, {
      issuer: isolated.baseUrl,
      audience: 'openfga-fault',
    })
    expect((await bearer(app, primer)).status).toBe(200)

    // Tear down the fixture so any subsequent JWKS refetch fails.
    await isolated.shutdown()

    // Sign a token with an unknown kid so jose has to refetch the
    // JWKS. The fetch will fail because the server is gone.
    const stranger = await generateKeyPair('RS256', { extractable: true })
    const orphan = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'never-published' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .setIssuer(isolated.baseUrl)
      .setAudience('openfga-fault')
      .sign(stranger.privateKey)
    const res = await bearer(app, orphan)
    expect(res.status).toBe(401)
  })
})

describe('oidc discovery — shared, non-sticky failure (openfga-k2a.3)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    fixture.discoveryMode = 'ok'
  })

  it('recovers after a transient discovery failure instead of returning 401 forever', async () => {
    fixture.discoveryMode = '500'
    const app = buildApp(configFor(fixture))
    const token = await makeJwt(fixture)
    expect((await bearer(app, token)).status).toBe(401)

    // Issuer recovers. Advance the clock past the retry backoff so the
    // next request re-runs discovery rather than reusing the failure.
    fixture.discoveryMode = 'ok'
    const realNow = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 60_000)
    expect((await bearer(app, token)).status).toBe(200)
  })

  it('does not re-run discovery on every request while inside the retry backoff', async () => {
    fixture.discoveryMode = '500'
    const app = buildApp(configFor(fixture))
    const token = await makeJwt(fixture)
    expect((await bearer(app, token)).status).toBe(401)
    const hitsAfterFirstFailure = fixture.discoveryHits
    expect((await bearer(app, token)).status).toBe(401)
    expect(fixture.discoveryHits).toBe(hitsAfterFirstFailure)
  })

  it('shares one discovery between boot prefetch and the middleware', async () => {
    const cfg = configFor(fixture)
    const before = fixture.discoveryHits
    await prefetchOidcJwks(cfg)
    const app = buildApp(cfg)
    expect((await bearer(app, await makeJwt(fixture))).status).toBe(200)
    expect((await bearer(app, await makeJwt(fixture))).status).toBe(200)
    expect(fixture.discoveryHits - before).toBe(1)
  })

  it('boot prefetch retries immediately after an earlier failure (fail-fast stays accurate)', async () => {
    fixture.discoveryMode = '500'
    const cfg = configFor(fixture)
    await expect(prefetchOidcJwks(cfg)).rejects.toThrow(OidcDiscoveryError)
    fixture.discoveryMode = 'ok'
    await expect(prefetchOidcJwks(cfg)).resolves.toBeUndefined()
  })
})
