/**
 * Integration regression test for openfga-k2a.14 — only 2xx responses
 * are recorded for replay.
 *
 * Before the change, a 4xx response under an Idempotency-Key was
 * stored and replayed for the whole TTL, so a client that fixed the
 * underlying condition and retried with the same key kept receiving
 * the stale failure. Now any non-2xx response releases the claim and a
 * retry re-runs the request.
 *
 * Scenario: a /write that deletes a tuple which does not exist yet
 * fails with 400. After the tuple is written (under another key), the
 * same request with the same key succeeds, and is then replayed.
 *
 * Runs against SQLite via `integration` and Postgres via
 * `integration-pg`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Hono } from 'hono'
import { buildApp } from '../../src/routes/index'
import { createStore } from '../../src/storage/stores'
import { bootstrapIntegrationDb } from '../_helpers/integration-bootstrap'
import { reloadConfigForTests } from '../../src/config'

const bootstrap = await bootstrapIntegrationDb()

afterAll(async () => {
  await bootstrap.teardown()
})

const describeIfDb = bootstrap.ready ? describe : describe.skip

describeIfDb('openfga-k2a.14 — non-2xx responses are not replayed', () => {
  let app: Hono
  const previousMode = process.env['OPENFGA_IDEMPOTENCY_MODE']

  beforeAll(async () => {
    process.env['OPENFGA_IDEMPOTENCY_MODE'] = 'optional'
    await reloadConfigForTests()
    app = buildApp()
  })

  afterAll(async () => {
    if (previousMode === undefined) delete process.env['OPENFGA_IDEMPOTENCY_MODE']
    else process.env['OPENFGA_IDEMPOTENCY_MODE'] = previousMode
    await reloadConfigForTests()
  })

  function post(path: string, body: unknown, idempotencyKey?: string): Request {
    return new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    })
  }

  it('a 4xx response is not replayed; the retry re-runs and its 2xx is replayed', async () => {
    const tag = `non2xx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const store = await createStore(tag)
    const modelRes = await app.fetch(post(`/stores/${store.id}/authorization-models`, {
      schema_version: '1.1',
      type_definitions: [
        { type: 'user' },
        { type: 'doc', relations: { viewer: { this: {} } }, metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'user' }] } } } },
      ],
    }))
    expect(modelRes.status).toBe(201)

    const tuple = { user: 'user:anne', relation: 'viewer', object: 'doc:1' }
    const deleteBody = { deletes: { tuple_keys: [tuple] } }
    const key = `del-${tag}`

    const first = await app.fetch(post(`/stores/${store.id}/write`, deleteBody, key))
    expect(first.status).toBeGreaterThanOrEqual(400)
    expect(first.status).toBeLessThan(500)

    const written = await app.fetch(post(`/stores/${store.id}/write`, { writes: { tuple_keys: [tuple] } }))
    expect(written.status).toBe(200)

    // Same key, same body: re-runs instead of replaying the 4xx.
    const retry = await app.fetch(post(`/stores/${store.id}/write`, deleteBody, key))
    expect(retry.status).toBe(200)

    // The 2xx is now recorded: a further retry replays it (the tuple is
    // gone, so a re-run would have failed with 400).
    const replay = await app.fetch(post(`/stores/${store.id}/write`, deleteBody, key))
    expect(replay.status).toBe(200)
  })
})
