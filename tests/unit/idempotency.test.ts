/**
 * Unit tests for the Idempotency-Key middleware.
 *
 * The storage layer (`src/storage/idempotency.ts`) is mocked so these
 * tests run without a database. Persistence and SQL semantics are
 * exercised by the integration test in
 * tests/integration/idempotency.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

const claimKey = vi.fn()
const completeKey = vi.fn()
const releaseKey = vi.fn()

vi.mock('../../src/storage/idempotency.js', () => ({
  claimKey: (...args: unknown[]) => claimKey(...args),
  completeKey: (...args: unknown[]) => completeKey(...args),
  releaseKey: (...args: unknown[]) => releaseKey(...args),
}))

const { idempotencyMiddleware, MAX_IDEMPOTENCY_KEY_LENGTH, scopedIdempotencyKey } = await import('../../src/middleware/idempotency.js')
const { ANONYMOUS_PRINCIPAL, setAuthPrincipal } = await import('../../src/middleware/caller.js')

const TOKEN = '11111111-2222-4333-8444-555555555555'
const CLAIMED = { kind: 'claimed', token: TOKEN }
const anon = (key: string): string => scopedIdempotencyKey(ANONYMOUS_PRINCIPAL, key)

interface AppOptions {
  mode: 'off' | 'optional' | 'required'
  ttlMs?: number
  handler?: (() => unknown) | (() => Promise<unknown>)
  status?: number
}

function buildApp({ mode, ttlMs = 60_000, handler, status = 200 }: AppOptions): Hono {
  const app = new Hono()
  app.use(
    '*',
    idempotencyMiddleware({
      mode,
      ttlMs,
      scopes: [
        { method: 'POST', path: '/stores' },
        { method: 'POST', path: '/stores/:storeId/write' },
      ],
    }),
  )
  app.post('/stores', async (c) => {
    const body = handler ? await handler() : { id: 'new-store', echoed: await c.req.json().catch(() => null) }
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  })
  app.post('/stores/:storeId/write', async (c) => {
    if (handler) await handler()
    return c.json({})
  })
  app.post('/stores/:storeId/check', async (c) => c.json({ allowed: true }))
  return app
}

function reqJson(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  claimKey.mockReset()
  completeKey.mockReset()
  releaseKey.mockReset()
})

describe('idempotency middleware — mode=off', () => {
  it('does not consult the store even when an Idempotency-Key is present', async () => {
    const app = buildApp({ mode: 'off' })
    const res = await app.fetch(reqJson('/stores', { name: 'test' }, { 'Idempotency-Key': 'k1' }))
    expect(res.status).toBe(200)
    expect(claimKey).not.toHaveBeenCalled()
    expect(completeKey).not.toHaveBeenCalled()
  })
})

describe('idempotency middleware — mode=optional', () => {
  it('passes through when no Idempotency-Key is provided', async () => {
    const app = buildApp({ mode: 'optional' })
    const res = await app.fetch(reqJson('/stores', { name: 'test' }))
    expect(res.status).toBe(200)
    expect(claimKey).not.toHaveBeenCalled()
  })

  it('does not apply to non-scoped routes even when an Idempotency-Key is provided', async () => {
    const app = buildApp({ mode: 'optional' })
    const res = await app.fetch(reqJson('/stores/abc/check', {}, { 'Idempotency-Key': 'k1' }))
    expect(res.status).toBe(200)
    expect(claimKey).not.toHaveBeenCalled()
  })

  it('claims, runs the handler, and persists the response on first request', async () => {
    claimKey.mockResolvedValueOnce(CLAIMED)
    completeKey.mockResolvedValueOnce(true)

    const app = buildApp({ mode: 'optional' })
    const res = await app.fetch(reqJson('/stores', { name: 'first' }, { 'Idempotency-Key': 'abc' }))

    expect(res.status).toBe(200)
    expect(claimKey).toHaveBeenCalledTimes(1)
    expect(completeKey).toHaveBeenCalledTimes(1)
    const [key, token, status, body] = completeKey.mock.calls[0]!
    expect(key).toBe(anon('abc'))
    expect(token).toBe(TOKEN)
    expect(status).toBe(200)
    expect(body).toEqual({ id: 'new-store', echoed: { name: 'first' } })
    expect(releaseKey).not.toHaveBeenCalled()
  })

  it('replays the cached response on a matching retry without invoking the handler', async () => {
    const handler = vi.fn().mockResolvedValue({ should: 'not-run' })
    claimKey.mockResolvedValueOnce({ kind: 'replay', status: 200, body: { id: 'cached', echoed: { name: 'first' } } })

    const app = buildApp({ mode: 'optional', handler })
    const res = await app.fetch(reqJson('/stores', { name: 'first' }, { 'Idempotency-Key': 'abc' }))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 'cached', echoed: { name: 'first' } })
    expect(handler).not.toHaveBeenCalled()
    expect(completeKey).not.toHaveBeenCalled()
  })

  it('returns 409 when the store reports an in-flight request with the same key', async () => {
    claimKey.mockResolvedValueOnce({ kind: 'in_flight' })
    const handler = vi.fn()

    const app = buildApp({ mode: 'optional', handler })
    const res = await app.fetch(reqJson('/stores', { name: 'first' }, { 'Idempotency-Key': 'abc' }))

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'idempotency_in_flight' })
    expect(handler).not.toHaveBeenCalled()
    expect(completeKey).not.toHaveBeenCalled()
  })

  it('returns 422 when the same key is reused with a different fingerprint', async () => {
    claimKey.mockResolvedValueOnce({ kind: 'mismatch' })
    const handler = vi.fn()

    const app = buildApp({ mode: 'optional', handler })
    const res = await app.fetch(reqJson('/stores', { name: 'different' }, { 'Idempotency-Key': 'abc' }))

    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ code: 'idempotency_fingerprint_mismatch' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('returns 503 when the idempotency store fails on claim', async () => {
    claimKey.mockRejectedValueOnce(new Error('connection refused'))
    const handler = vi.fn()

    const app = buildApp({ mode: 'optional', handler })
    const res = await app.fetch(reqJson('/stores', { name: 'first' }, { 'Idempotency-Key': 'abc' }))

    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ code: 'idempotency_store_unavailable' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('releases the slot when the handler returns 5xx so retries can succeed', async () => {
    claimKey.mockResolvedValueOnce(CLAIMED)
    releaseKey.mockResolvedValueOnce(true)

    const app = buildApp({ mode: 'optional', status: 500, handler: () => ({ code: 'internal' }) })
    const res = await app.fetch(reqJson('/stores', { name: 'first' }, { 'Idempotency-Key': 'abc' }))

    expect(res.status).toBe(500)
    expect(releaseKey).toHaveBeenCalledWith(anon('abc'), TOKEN)
    expect(completeKey).not.toHaveBeenCalled()
  })

  // openfga-k2a.14 — only 2xx responses are recorded and replayed.
  it.each([400, 404, 409, 422])('releases the slot (does not persist) when the handler returns %i', async (status) => {
    claimKey.mockResolvedValueOnce(CLAIMED)
    releaseKey.mockResolvedValueOnce(true)

    const app = buildApp({ mode: 'optional', status, handler: () => ({ code: 'validation_error' }) })
    const res = await app.fetch(reqJson('/stores', { name: 'first' }, { 'Idempotency-Key': 'abc' }))

    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ code: 'validation_error' })
    expect(releaseKey).toHaveBeenCalledWith(anon('abc'), TOKEN)
    expect(completeKey).not.toHaveBeenCalled()
  })

  it('persists a 201 response', async () => {
    claimKey.mockResolvedValueOnce(CLAIMED)
    completeKey.mockResolvedValueOnce(true)
    const app = buildApp({ mode: 'optional', status: 201 })
    const res = await app.fetch(reqJson('/stores', { name: 'first' }, { 'Idempotency-Key': 'abc' }))
    expect(res.status).toBe(201)
    expect(completeKey.mock.calls[0]![2]).toBe(201)
    expect(releaseKey).not.toHaveBeenCalled()
  })

  it('stores an empty 204 body as undefined and replays it as an empty body', async () => {
    claimKey.mockResolvedValueOnce(CLAIMED)
    completeKey.mockResolvedValueOnce(true)
    const app = new Hono()
    app.use('*', idempotencyMiddleware({ mode: 'optional', ttlMs: 60_000, scopes: [{ method: 'POST', path: '/stores' }] }))
    app.post('/stores', c => c.body(null, 204))

    const first = await app.fetch(reqJson('/stores', {}, { 'Idempotency-Key': 'abc' }))
    expect(first.status).toBe(204)
    const [, , status, body] = completeKey.mock.calls[0]!
    expect(status).toBe(204)
    expect(body).toBeUndefined()

    claimKey.mockResolvedValueOnce({ kind: 'replay', status: 204, body: null })
    const replay = await app.fetch(reqJson('/stores', {}, { 'Idempotency-Key': 'abc' }))
    expect(replay.status).toBe(204)
    expect(await replay.text()).toBe('')
  })

  it('replays a stored NULL body on a 200 as an empty body, not the literal "null"', async () => {
    claimKey.mockResolvedValueOnce({ kind: 'replay', status: 200, body: null })
    const app = buildApp({ mode: 'optional' })
    const res = await app.fetch(reqJson('/stores', {}, { 'Idempotency-Key': 'abc' }))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })

  it('releases the slot and propagates when the handler throws', async () => {
    claimKey.mockResolvedValueOnce(CLAIMED)
    releaseKey.mockResolvedValueOnce(true)

    const app = new Hono()
    app.use('*', idempotencyMiddleware({
      mode: 'optional',
      ttlMs: 60_000,
      scopes: [{ method: 'POST', path: '/stores' }],
    }))
    app.post('/stores', () => {
      throw new Error('boom')
    })
    app.onError((_err, c) => c.json({ code: 'internal_error' }, 500))

    const res = await app.fetch(reqJson('/stores', { name: 'first' }, { 'Idempotency-Key': 'abc' }))
    expect(res.status).toBe(500)
    expect(releaseKey).toHaveBeenCalledWith(anon('abc'), TOKEN)
  })

  it('treats whitespace-only Idempotency-Key as missing and passes through', async () => {
    const app = buildApp({ mode: 'optional' })
    const res = await app.fetch(reqJson('/stores', { name: 'first' }, { 'Idempotency-Key': '   ' }))
    expect(res.status).toBe(200)
    expect(claimKey).not.toHaveBeenCalled()
  })
})

describe('idempotency middleware — mode=required', () => {
  it('returns 400 when Idempotency-Key is missing on a scoped endpoint', async () => {
    const app = buildApp({ mode: 'required' })
    const res = await app.fetch(reqJson('/stores', { name: 'first' }))

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'invalid_argument' })
    expect(claimKey).not.toHaveBeenCalled()
  })

  it('returns 400 when Idempotency-Key is empty on a scoped endpoint', async () => {
    const app = buildApp({ mode: 'required' })
    const res = await app.fetch(reqJson('/stores', { name: 'first' }, { 'Idempotency-Key': '' }))

    expect(res.status).toBe(400)
    expect(claimKey).not.toHaveBeenCalled()
  })

  it('does not require Idempotency-Key on non-scoped endpoints', async () => {
    const app = buildApp({ mode: 'required' })
    const res = await app.fetch(reqJson('/stores/abc/check', {}))

    expect(res.status).toBe(200)
    expect(claimKey).not.toHaveBeenCalled()
  })

  it('processes the request when Idempotency-Key is present', async () => {
    claimKey.mockResolvedValueOnce(CLAIMED)
    completeKey.mockResolvedValueOnce(true)

    const app = buildApp({ mode: 'required' })
    const res = await app.fetch(reqJson('/stores', { name: 'first' }, { 'Idempotency-Key': 'abc' }))

    expect(res.status).toBe(200)
    expect(claimKey).toHaveBeenCalledTimes(1)
    expect(completeKey).toHaveBeenCalledTimes(1)
  })
})

describe('idempotency middleware — fingerprint stability', () => {
  it('different bodies on the same route produce different fingerprints', async () => {
    claimKey.mockResolvedValue(CLAIMED)
    completeKey.mockResolvedValue(true)

    const app = buildApp({ mode: 'optional' })
    await app.fetch(reqJson('/stores', { name: 'a' }, { 'Idempotency-Key': 'k1' }))
    await app.fetch(reqJson('/stores', { name: 'b' }, { 'Idempotency-Key': 'k2' }))

    const fpA = claimKey.mock.calls[0]![1]
    const fpB = claimKey.mock.calls[1]![1]
    expect(fpA).not.toBe(fpB)
  })

  it('same body on different routes produces different fingerprints', async () => {
    claimKey.mockResolvedValue(CLAIMED)
    completeKey.mockResolvedValue(true)

    const app = buildApp({ mode: 'optional' })
    await app.fetch(reqJson('/stores', { name: 'a' }, { 'Idempotency-Key': 'k1' }))
    await app.fetch(reqJson('/stores/abc/write', { name: 'a' }, { 'Idempotency-Key': 'k2' }))

    const fpA = claimKey.mock.calls[0]![1]
    const fpB = claimKey.mock.calls[1]![1]
    expect(fpA).not.toBe(fpB)
  })

  it('identical body and route produce identical fingerprints', async () => {
    claimKey.mockResolvedValue(CLAIMED)
    completeKey.mockResolvedValue(true)

    const app = buildApp({ mode: 'optional' })
    await app.fetch(reqJson('/stores', { name: 'same' }, { 'Idempotency-Key': 'k1' }))
    await app.fetch(reqJson('/stores', { name: 'same' }, { 'Idempotency-Key': 'k2' }))

    const fpA = claimKey.mock.calls[0]![1]
    const fpB = claimKey.mock.calls[1]![1]
    expect(fpA).toBe(fpB)
  })

  // Regression for openfga-fot: prior implementation hashed the
  // matched route pattern (`/stores/:storeId/write`) instead of the
  // concrete request path, so the SAME Idempotency-Key + same body
  // across two stores collided on the same fingerprint and replayed
  // store A's response under store B's namespace. This test sends
  // the production failure scenario: same key, same body, two
  // different concrete storeId path components, and asserts the
  // fingerprints differ so the storage layer can never confuse them.
  it('same Idempotency-Key + same body across two stores produces different fingerprints (no cross-store replay)', async () => {
    claimKey.mockResolvedValue(CLAIMED)
    completeKey.mockResolvedValue(true)

    const app = buildApp({ mode: 'optional' })
    const SHARED_KEY = 'shared-cross-store-key'
    await app.fetch(reqJson('/stores/storeA/write', { name: 'same' }, { 'Idempotency-Key': SHARED_KEY }))
    await app.fetch(reqJson('/stores/storeB/write', { name: 'same' }, { 'Idempotency-Key': SHARED_KEY }))

    // Both calls reached the storage layer with the SAME (principal-
    // scoped) key — confirms the test setup matches the production
    // scenario.
    const keyA = claimKey.mock.calls[0]![0]
    const keyB = claimKey.mock.calls[1]![0]
    expect(keyA).toBe(anon(SHARED_KEY))
    expect(keyB).toBe(anon(SHARED_KEY))

    // The load-bearing assertion: identical key + body must produce
    // different fingerprints when the concrete storeId differs, so
    // the storage layer treats the second call as a fresh claim or
    // as a fingerprint-mismatch — never as a replay of store A.
    const fpA = claimKey.mock.calls[0]![1]
    const fpB = claimKey.mock.calls[1]![1]
    expect(fpA).not.toBe(fpB)
  })

})

describe('idempotency middleware — principal scoping (openfga-k2a.3)', () => {
  function appAs(principal: string | null): Hono {
    const app = new Hono()
    if (principal !== null) {
      app.use('*', async (c, next) => {
        setAuthPrincipal(c, principal)
        await next()
      })
    }
    app.use('*', idempotencyMiddleware({ mode: 'optional', ttlMs: 60_000, scopes: [{ method: 'POST', path: '/stores' }] }))
    app.post('/stores', c => c.json({ id: 'x' }))
    return app
  }

  it('namespaces the stored key by the authenticated principal', async () => {
    claimKey.mockResolvedValue(CLAIMED)
    completeKey.mockResolvedValue(true)

    await appAs('preshared:aaa').fetch(reqJson('/stores', { name: 'same' }, { 'Idempotency-Key': 'k1' }))
    await appAs('preshared:bbb').fetch(reqJson('/stores', { name: 'same' }, { 'Idempotency-Key': 'k1' }))

    const keyA = claimKey.mock.calls[0]![0] as string
    const keyB = claimKey.mock.calls[1]![0] as string
    expect(keyA).not.toBe(keyB)
    expect(keyA).toBe(scopedIdempotencyKey('preshared:aaa', 'k1'))
    // The raw client key never reaches storage.
    expect(keyA).not.toContain('k1')
    expect(keyA).toMatch(/^[0-9a-f]{64}$/)
  })

  it('treats a missing principal as the anonymous principal', async () => {
    claimKey.mockResolvedValue(CLAIMED)
    completeKey.mockResolvedValue(true)
    await appAs(null).fetch(reqJson('/stores', {}, { 'Idempotency-Key': 'k1' }))
    await appAs(ANONYMOUS_PRINCIPAL).fetch(reqJson('/stores', {}, { 'Idempotency-Key': 'k1' }))
    expect(claimKey.mock.calls[0]![0]).toBe(claimKey.mock.calls[1]![0])
  })

  it('scopedIdempotencyKey is unambiguous across principal/key boundaries', () => {
    expect(scopedIdempotencyKey('a', 'bc')).not.toBe(scopedIdempotencyKey('ab', 'c'))
  })
})

describe('idempotency middleware — key length bound (openfga-k2a.3)', () => {
  it('rejects an over-long Idempotency-Key with 400 before touching the store', async () => {
    const app = buildApp({ mode: 'optional' })
    const longKey = 'k'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1)
    const res = await app.fetch(reqJson('/stores', { name: 'x' }, { 'Idempotency-Key': longKey }))
    expect(res.status).toBe(400)
    const body = await res.json() as { code: string, message: string }
    expect(body.code).toBe('invalid_argument')
    expect(body.message).not.toContain(longKey)
    expect(claimKey).not.toHaveBeenCalled()
  })

  it('accepts a key exactly at the limit', async () => {
    claimKey.mockResolvedValueOnce(CLAIMED)
    completeKey.mockResolvedValueOnce(true)
    const app = buildApp({ mode: 'optional' })
    const res = await app.fetch(reqJson('/stores', { name: 'x' }, { 'Idempotency-Key': 'k'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH) }))
    expect(res.status).toBe(200)
    expect(claimKey).toHaveBeenCalledTimes(1)
  })
})

describe('idempotency middleware — lost ownership (openfga-k2a.3)', () => {
  it('still returns the handler response when completion finds the claim was taken over', async () => {
    claimKey.mockResolvedValueOnce(CLAIMED)
    completeKey.mockResolvedValueOnce(false)
    const app = buildApp({ mode: 'optional' })
    const res = await app.fetch(reqJson('/stores', { name: 'x' }, { 'Idempotency-Key': 'abc' }))
    expect(res.status).toBe(200)
    // Not our row any more: must not attempt to delete it.
    expect(releaseKey).not.toHaveBeenCalled()
  })
})
