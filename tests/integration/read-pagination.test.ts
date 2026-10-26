/**
 * Integration tests for /read continuation_token round-trip.
 *
 * Pinned by openfga-5uv: the /read endpoint accepted but ignored
 * `continuation_token` and always returned `''`, so any store with
 * more tuples than the requested page_size was unreachable beyond
 * the first page over the wire-compatible API. This test seeds N
 * tuples and walks the entire result via repeated /read calls,
 * asserting that every tuple is enumerated exactly once.
 *
 * Runs against SQLite by default via the `integration` vitest project;
 * the `integration-pg` project re-runs the same specs against Postgres.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/routes/index'
import { createStore } from '../../src/storage/stores'
import { writeTuples } from '../../src/storage/tuples'
import { writeAuthorizationModel } from '../../src/storage/authorization-models'
import { bootstrapIntegrationDb } from '../_helpers/integration-bootstrap'

const bootstrap = await bootstrapIntegrationDb()

afterAll(async () => {
  await bootstrap.teardown()
})

const describeIfDb = bootstrap.ready ? describe : describe.skip

interface ReadResponse {
  tuples: Array<{
    key: { user: string, relation: string, object: string }
    timestamp: string
  }>
  continuation_token: string
}

describeIfDb('POST /stores/:storeId/read continuation_token round-trip', () => {
  async function setup() {
    const app = buildApp()
    const store = await createStore(`read-page-${Date.now()}-${Math.random()}`)
    await writeAuthorizationModel(store.id, {
      schema_version: '1.1',
      type_definitions: [
        { type: 'user' },
        {
          type: 'doc',
          relations: { viewer: { this: {} } },
          metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'user' }] } } },
        },
      ],
    })
    return { app, storeId: store.id }
  }

  function read(storeId: string, body: unknown): Request {
    return new Request(`http://localhost/stores/${storeId}/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('returns a non-empty continuation_token when more rows exist beyond page_size', async () => {
    const { app, storeId } = await setup()
    await writeTuples(storeId, [
      { user: 'user:alice', relation: 'viewer', object: 'doc:1' },
      { user: 'user:alice', relation: 'viewer', object: 'doc:2' },
      { user: 'user:alice', relation: 'viewer', object: 'doc:3' },
    ])

    const res = await app.fetch(read(storeId, { page_size: 2 }))
    expect(res.status).toBe(200)
    const json = await res.json() as ReadResponse
    expect(json.tuples).toHaveLength(2)
    expect(json.continuation_token).not.toBe('')
  })

  it('round-trips the continuation_token to enumerate every tuple exactly once', async () => {
    const { app, storeId } = await setup()
    const expected = Array.from({ length: 5 }, (_, i) => `doc:${i}`)
    await writeTuples(storeId, expected.map(object => ({ user: 'user:alice', relation: 'viewer', object })))

    const seen: string[] = []
    let token: string | undefined
    let safety = 50
    while (safety > 0) {
      const body: { page_size: number, continuation_token?: string } = { page_size: 2 }
      if (token !== undefined) body.continuation_token = token
      const res = await app.fetch(read(storeId, body))
      expect(res.status).toBe(200)
      const json = await res.json() as ReadResponse
      for (const t of json.tuples) seen.push(t.key.object)
      if (json.continuation_token === '') break
      token = json.continuation_token
      safety--
    }
    expect(safety).toBeGreaterThan(0)
    expect(seen.sort()).toEqual([...expected].sort())
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('returns an empty token on the page that exhausts the result set', async () => {
    const { app, storeId } = await setup()
    await writeTuples(storeId, [
      { user: 'user:alice', relation: 'viewer', object: 'doc:1' },
    ])

    const res = await app.fetch(read(storeId, { page_size: 10 }))
    expect(res.status).toBe(200)
    const json = await res.json() as ReadResponse
    expect(json.tuples).toHaveLength(1)
    expect(json.continuation_token).toBe('')
  })

  it('returns 400 invalid_argument for a malformed continuation_token', async () => {
    const { app, storeId } = await setup()
    const res = await app.fetch(read(storeId, { continuation_token: 'not-a-real-token' }))
    expect(res.status).toBe(400)
    const body = await res.json() as { code: string }
    expect(body.code).toBe('invalid_argument')
  })

  // Regression for openfga-5uv review: a structurally valid base64url
  // JSON cursor with a non-parseable timestamp must NOT reach
  // Postgres (which would surface 22007 invalid_datetime_format as a
  // 500). The decoder validates inserted_at is a real ISO timestamp.
  it('returns 400 invalid_argument for a continuation_token with an unparseable timestamp', async () => {
    const { app, storeId } = await setup()
    const evilToken = Buffer.from(
      JSON.stringify({
        inserted_at: 'not-a-timestamp',
        object_type: 'doc',
        object_id: '1',
        relation: 'viewer',
        user_str: 'user:alice',
      }),
      'utf8',
    ).toString('base64url')
    const res = await app.fetch(read(storeId, { continuation_token: evilToken }))
    expect(res.status).toBe(400)
    const body = await res.json() as { code: string }
    expect(body.code).toBe('invalid_argument')
  })

  // Regression for openfga-5uv review: page_size: 0 used to pass the
  // schema's .nonnegative() check and crash the slice logic with a
  // 500. The schema is now .positive() so page_size: 0 is rejected
  // at the validation boundary even when rows exist.
  it('returns 400 invalid_argument for page_size: 0 even when tuples exist', async () => {
    const { app, storeId } = await setup()
    await writeTuples(storeId, [
      { user: 'user:alice', relation: 'viewer', object: 'doc:1' },
    ])
    const res = await app.fetch(read(storeId, { page_size: 0 }))
    expect(res.status).toBe(400)
    const body = await res.json() as { code: string }
    expect(body.code).toBe('invalid_argument')
  })

  it('respects filter narrowing alongside pagination', async () => {
    const { app, storeId } = await setup()
    await writeTuples(storeId, [
      { user: 'user:alice', relation: 'viewer', object: 'doc:1' },
      { user: 'user:alice', relation: 'viewer', object: 'doc:2' },
      { user: 'user:bob', relation: 'viewer', object: 'doc:3' },
    ])

    // Filter narrows to alice's tuples; pagination walks just those.
    const seen: string[] = []
    let token: string | undefined
    let safety = 10
    while (safety > 0) {
      const body: Record<string, unknown> = {
        tuple_key: { object: 'doc:', user: 'user:alice' },
        page_size: 1,
      }
      if (token !== undefined) body.continuation_token = token
      const res = await app.fetch(read(storeId, body))
      const json = await res.json() as ReadResponse
      for (const t of json.tuples) seen.push(t.key.object)
      if (json.continuation_token === '') break
      token = json.continuation_token
      safety--
    }
    expect(safety).toBeGreaterThan(0)
    expect(seen.sort()).toEqual(['doc:1', 'doc:2'])
  })
})
