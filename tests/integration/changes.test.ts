/**
 * Integration tests for GET /stores/:storeId/changes.
 *
 * Pinned by openfga-bh9: tuple writes/deletes record changes
 * transactionally, the changelog is paginated newest-first with a
 * round-tripping continuation_token, the optional `type` filter
 * narrows by object type, and `start_time` admits only changes at or
 * after the timestamp. Runs against SQLite by default via the
 * `integration` vitest project; the `integration-pg` project re-runs
 * the same specs against Postgres.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/routes/index'
import { createStore } from '../../src/storage/stores'
import { writeAuthorizationModel } from '../../src/storage/authorization-models'
import { writeTuples, deleteTuples } from '../../src/storage/tuples'
import { bootstrapIntegrationDb } from '../_helpers/integration-bootstrap'

const bootstrap = await bootstrapIntegrationDb()

afterAll(async () => {
  await bootstrap.teardown()
})

const describeIfDb = bootstrap.ready ? describe : describe.skip

interface ChangesResponse {
  changes: Array<{
    tuple_key: { user: string, relation: string, object: string }
    operation: 'TUPLE_OPERATION_WRITE' | 'TUPLE_OPERATION_DELETE'
    timestamp: string
  }>
  continuation_token: string
}

describeIfDb('GET /stores/:storeId/changes', () => {
  async function setupStore() {
    const store = await createStore(`changes-${Date.now()}-${Math.random()}`)
    await writeAuthorizationModel(store.id, {
      schema_version: '1.1',
      type_definitions: [
        { type: 'user' },
        {
          type: 'doc',
          relations: { viewer: { this: {} } },
          metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'user' }] } } },
        },
        {
          type: 'folder',
          relations: { viewer: { this: {} } },
          metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'user' }] } } },
        },
      ],
    })
    return store.id
  }

  function get(storeId: string, query: string): Request {
    return new Request(`http://localhost/stores/${storeId}/changes${query}`)
  }

  it('records a TUPLE_OPERATION_WRITE for each successful write', async () => {
    const app = buildApp()
    const storeId = await setupStore()
    await writeTuples(storeId, [
      { user: 'user:alice', relation: 'viewer', object: 'doc:1' },
      { user: 'user:bob', relation: 'viewer', object: 'doc:1' },
    ])

    const res = await app.fetch(get(storeId, '?page_size=100'))
    expect(res.status).toBe(200)
    const json = await res.json() as ChangesResponse
    expect(json.changes).toHaveLength(2)
    for (const c of json.changes) expect(c.operation).toBe('TUPLE_OPERATION_WRITE')
    // OpenFGA ReadChanges is oldest-first (ascending by timestamp).
    // Two same-microsecond inserts are tiebroken by ULID id ASC, so
    // the FIRST write comes first.
    expect(json.changes.map((c) => c.tuple_key.user)).toEqual(['user:alice', 'user:bob'])
  })

  it('records a TUPLE_OPERATION_DELETE for each successful delete', async () => {
    const app = buildApp()
    const storeId = await setupStore()
    await writeTuples(storeId, [{ user: 'user:alice', relation: 'viewer', object: 'doc:1' }])
    await deleteTuples(storeId, [{ user: 'user:alice', relation: 'viewer', object: 'doc:1' }])

    const res = await app.fetch(get(storeId, '?page_size=100'))
    const json = await res.json() as ChangesResponse
    // ASC ordering: write first, delete second.
    expect(json.changes.map((c) => c.operation)).toEqual([
      'TUPLE_OPERATION_WRITE',
      'TUPLE_OPERATION_DELETE',
    ])
  })

  it('honors the ?type= filter to narrow to a single object type', async () => {
    const app = buildApp()
    const storeId = await setupStore()
    await writeTuples(storeId, [
      { user: 'user:alice', relation: 'viewer', object: 'doc:1' },
      { user: 'user:alice', relation: 'viewer', object: 'folder:f1' },
    ])

    const res = await app.fetch(get(storeId, '?type=doc&page_size=100'))
    const json = await res.json() as ChangesResponse
    const objects = json.changes.map((c) => c.tuple_key.object)
    expect(objects).toEqual(['doc:1'])
  })

  it('rounds-trips continuation_token to enumerate all changes exactly once', async () => {
    const app = buildApp()
    const storeId = await setupStore()
    const recorded: Array<{ user: string, op: 'TUPLE_OPERATION_WRITE' | 'TUPLE_OPERATION_DELETE' }> = []
    for (let i = 0; i < 5; i++) {
      await writeTuples(storeId, [{ user: `user:u${i}`, relation: 'viewer', object: 'doc:1' }])
      recorded.push({ user: `user:u${i}`, op: 'TUPLE_OPERATION_WRITE' })
    }

    const seen: typeof recorded = []
    let token: string | undefined
    let safety = 50
    while (safety > 0) {
      const url = `?page_size=2${token ? `&continuation_token=${encodeURIComponent(token)}` : ''}`
      const res = await app.fetch(get(storeId, url))
      const json = await res.json() as ChangesResponse
      // OpenFGA ReadChanges in polling-tail mode returns empty
      // changes (with the supplied token echoed) when there are no
      // new events since the cursor. That's the natural exit
      // condition under ASC ordering — token never becomes '' once
      // any events exist, so break on empty changes array.
      if (json.changes.length === 0) break
      for (const c of json.changes) seen.push({ user: c.tuple_key.user, op: c.operation })
      token = json.continuation_token
      safety--
    }
    expect(safety).toBeGreaterThan(0)
    // ASC ordering: events returned in recorded order, not reversed.
    expect(seen).toEqual(recorded)
    expect(new Set(seen.map((s) => s.user)).size).toBe(seen.length)
  })

  // Regression for openfga-ra9: the OpenFGA ReadChanges contract for
  // an exhausted continuation read echoes the supplied token so a
  // polling-tail client can resume from the same position once new
  // events arrive.
  it('echoes the supplied continuation_token when no new events have arrived since the cursor', async () => {
    const app = buildApp()
    const storeId = await setupStore()
    await writeTuples(storeId, [
      { user: 'user:alice', relation: 'viewer', object: 'doc:1' },
    ])

    // First call: get the head-of-history token.
    const first = await app.fetch(get(storeId, '?page_size=100'))
    const firstJson = await first.json() as ChangesResponse
    expect(firstJson.changes).toHaveLength(1)
    const tailToken = firstJson.continuation_token
    expect(tailToken).not.toBe('')

    // Poll: no new events, server echoes the same token so the
    // client can keep polling from the same position.
    const second = await app.fetch(get(storeId, `?continuation_token=${encodeURIComponent(tailToken)}`))
    const secondJson = await second.json() as ChangesResponse
    expect(secondJson.changes).toEqual([])
    expect(secondJson.continuation_token).toBe(tailToken)

    // Now add a new event and resume — should surface only the new event.
    await writeTuples(storeId, [
      { user: 'user:bob', relation: 'viewer', object: 'doc:2' },
    ])
    const third = await app.fetch(get(storeId, `?continuation_token=${encodeURIComponent(tailToken)}`))
    const thirdJson = await third.json() as ChangesResponse
    expect(thirdJson.changes).toHaveLength(1)
    expect(thirdJson.changes[0]?.tuple_key.user).toBe('user:bob')
    expect(thirdJson.continuation_token).not.toBe('')
    expect(thirdJson.continuation_token).not.toBe(tailToken)
  })

  it('honors start_time to exclude changes recorded before the cutoff', async () => {
    const app = buildApp()
    const storeId = await setupStore()
    await writeTuples(storeId, [{ user: 'user:before', relation: 'viewer', object: 'doc:1' }])
    // Sleep ~50ms so the cutoff lands cleanly between the two inserts.
    await new Promise((r) => setTimeout(r, 50))
    const cutoff = new Date().toISOString()
    await new Promise((r) => setTimeout(r, 50))
    await writeTuples(storeId, [{ user: 'user:after', relation: 'viewer', object: 'doc:1' }])

    const res = await app.fetch(get(storeId, `?start_time=${encodeURIComponent(cutoff)}`))
    const json = await res.json() as ChangesResponse
    const users = json.changes.map((c) => c.tuple_key.user)
    expect(users).toEqual(['user:after'])
  })

  // Regression for openfga-ra9 review: a continuation_token issued
  // under ?type=doc must not be reusable without the same type
  // filter. Without this guard, a polling stream could leak
  // unrelated object-type changes once the client drops or swaps
  // the filter.
  it('rejects a continuation_token issued under ?type= when re-presented without type', async () => {
    const app = buildApp()
    const storeId = await setupStore()
    await writeTuples(storeId, [
      { user: 'user:alice', relation: 'viewer', object: 'doc:1' },
      { user: 'user:alice', relation: 'viewer', object: 'folder:f1' },
    ])

    const filtered = await app.fetch(get(storeId, '?type=doc&page_size=100'))
    const filteredJson = await filtered.json() as ChangesResponse
    const tokenForDoc = filteredJson.continuation_token
    expect(tokenForDoc).not.toBe('')

    // Reuse the doc-issued token without the type filter — must 400.
    const reused = await app.fetch(get(storeId, `?continuation_token=${encodeURIComponent(tokenForDoc)}`))
    expect(reused.status).toBe(400)
    const body = await reused.json() as { code: string }
    expect(body.code).toBe('query_string_type_continuation_token_mismatch')
  })

  it('rejects a continuation_token issued under ?type=doc when re-presented with ?type=folder', async () => {
    const app = buildApp()
    const storeId = await setupStore()
    await writeTuples(storeId, [{ user: 'user:alice', relation: 'viewer', object: 'doc:1' }])

    const filtered = await app.fetch(get(storeId, '?type=doc&page_size=100'))
    const filteredJson = await filtered.json() as ChangesResponse
    const tokenForDoc = filteredJson.continuation_token
    expect(tokenForDoc).not.toBe('')

    const swapped = await app.fetch(
      get(storeId, `?type=folder&continuation_token=${encodeURIComponent(tokenForDoc)}`),
    )
    expect(swapped.status).toBe(400)
    const body = await swapped.json() as { code: string }
    expect(body.code).toBe('query_string_type_continuation_token_mismatch')
  })

  it('rejects a token issued WITHOUT type when re-presented WITH a type filter', async () => {
    const app = buildApp()
    const storeId = await setupStore()
    await writeTuples(storeId, [{ user: 'user:alice', relation: 'viewer', object: 'doc:1' }])

    const unfiltered = await app.fetch(get(storeId, '?page_size=100'))
    const unfilteredJson = await unfiltered.json() as ChangesResponse
    const tokenNoType = unfilteredJson.continuation_token
    expect(tokenNoType).not.toBe('')

    const swapped = await app.fetch(
      get(storeId, `?type=doc&continuation_token=${encodeURIComponent(tokenNoType)}`),
    )
    expect(swapped.status).toBe(400)
    const body = await swapped.json() as { code: string }
    expect(body.code).toBe('query_string_type_continuation_token_mismatch')
  })

  // Regression for openfga-ra9 review: same-transaction inserts
  // share `inserted_at` to the microsecond. The cursor must rely on
  // the bigserial `seq` column for deterministic same-tx ordering;
  // the prior id-tiebroken implementation showed 8/30 inversions.
  it('preserves same-transaction insertion order across the changelog', async () => {
    const app = buildApp()
    const storeId = await setupStore()

    // Two writes in ONE transaction. ULID-tiebroken ordering would
    // randomly invert these on a non-trivial fraction of runs;
    // bigserial seq tiebreaks them deterministically.
    await writeTuples(storeId, [
      { user: 'user:first', relation: 'viewer', object: 'doc:1' },
      { user: 'user:second', relation: 'viewer', object: 'doc:1' },
    ])

    // Run the assertion many times. Without the seq fix, this would
    // fail intermittently within a single test execution if two ULIDs
    // sorted unfavorably; with seq it always reads first→second.
    for (let attempt = 0; attempt < 10; attempt++) {
      const res = await app.fetch(get(storeId, '?page_size=100'))
      const json = await res.json() as ChangesResponse
      const users = json.changes.map((c) => c.tuple_key.user)
      expect(users).toEqual(['user:first', 'user:second'])
    }
  })

  it('returns 400 invalid_continuation_token for a malformed continuation_token', async () => {
    const app = buildApp()
    const storeId = await setupStore()
    const res = await app.fetch(get(storeId, '?continuation_token=not-real'))
    expect(res.status).toBe(400)
    const body = await res.json() as { code: string }
    expect(body.code).toBe('invalid_continuation_token')
  })

  it('returns 400 validation_error for a malformed start_time', async () => {
    const app = buildApp()
    const storeId = await setupStore()
    const res = await app.fetch(get(storeId, '?start_time=not-a-timestamp'))
    expect(res.status).toBe(400)
    const body = await res.json() as { code: string }
    expect(body.code).toBe('validation_error')
  })
})
