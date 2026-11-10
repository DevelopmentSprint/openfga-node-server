/**
 * Integration regression test for openfga-k2a.3 — idempotency records
 * are namespaced by the authenticated caller.
 *
 * Before the fix, records were keyed by the raw Idempotency-Key only,
 * so a second authenticated caller that sent the same key and body
 * received the first caller's cached response (and could probe
 * whether a key existed at all). This test drives the full route
 * stack with preshared auth (two keys) and real idempotency storage.
 *
 * Runs against SQLite via the `integration` project and against
 * Postgres via `integration-pg`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Hono } from 'hono'
import { buildApp } from '../../src/routes/index'
import { bootstrapIntegrationDb } from '../_helpers/integration-bootstrap'
import { reloadConfigForTests } from '../../src/config'

const bootstrap = await bootstrapIntegrationDb()

afterAll(async () => {
  await bootstrap.teardown()
})

const describeIfDb = bootstrap.ready ? describe : describe.skip

const CALLER_A = 'fixture-caller-a'
const CALLER_B = 'fixture-caller-b'
const ENV_KEYS = ['OPENFGA_IDEMPOTENCY_MODE', 'OPENFGA_AUTH_MODE', 'OPENFGA_AUTH_PRESHARED_KEYS'] as const

describeIfDb('openfga-k2a.3 — principal-scoped idempotency keys', () => {
  let app: Hono
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

  beforeAll(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k]
    process.env['OPENFGA_IDEMPOTENCY_MODE'] = 'optional'
    process.env['OPENFGA_AUTH_MODE'] = 'preshared'
    process.env['OPENFGA_AUTH_PRESHARED_KEYS'] = `${CALLER_A},${CALLER_B}`
    await reloadConfigForTests()
    app = buildApp()
  })

  afterAll(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    await reloadConfigForTests()
  })

  function createStoreReq(caller: string, idempotencyKey: string, name: string): Request {
    return new Request('http://localhost/stores', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Authorization': ['Bearer', caller].join(' '),
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({ name }),
    })
  }

  it('a second caller with the same key and body does not receive the first caller\'s cached response', async () => {
    const tag = `principal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const sharedKey = `shared-${tag}`

    const resA = await app.fetch(createStoreReq(CALLER_A, sharedKey, tag))
    expect(resA.status).toBe(201)
    const storeA = await resA.json() as { id: string }

    const resB = await app.fetch(createStoreReq(CALLER_B, sharedKey, tag))
    expect(resB.status).toBe(201)
    const storeB = await resB.json() as { id: string }
    expect(storeB.id).not.toBe(storeA.id)

    // Each caller still gets its own replay.
    const retryA = await app.fetch(createStoreReq(CALLER_A, sharedKey, tag))
    expect(retryA.status).toBe(201)
    expect((await retryA.json() as { id: string }).id).toBe(storeA.id)

    const retryB = await app.fetch(createStoreReq(CALLER_B, sharedKey, tag))
    expect((await retryB.json() as { id: string }).id).toBe(storeB.id)
  })

  it('a second caller cannot probe another caller\'s key via a fingerprint mismatch', async () => {
    const tag = `probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const sharedKey = `shared-${tag}`

    expect((await app.fetch(createStoreReq(CALLER_A, sharedKey, `${tag}-a`))).status).toBe(201)
    // Different body under the same key: for caller A this would be a
    // 422; for caller B the key is unused, so it is a fresh request.
    expect((await app.fetch(createStoreReq(CALLER_B, sharedKey, `${tag}-b`))).status).toBe(201)
    expect((await app.fetch(createStoreReq(CALLER_A, sharedKey, `${tag}-b`))).status).toBe(422)
  })
})
