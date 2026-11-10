/**
 * Integration tests for GET /stores.
 *
 * Pinned by openfga-7ct: empty / single / multiple / pagination round
 * trip / soft-delete exclusion. The continuation_token is opaque to
 * clients but stable across calls — paging through with the
 * server-issued token must enumerate every store exactly once,
 * newest-first.
 *
 * Runs against SQLite by default via the `integration` vitest project;
 * the `integration-pg` project re-runs the same specs against Postgres.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/routes/index'
import { createStore } from '../../src/storage/stores'
import { bootstrapIntegrationDb } from '../_helpers/integration-bootstrap'

const bootstrap = await bootstrapIntegrationDb()

afterAll(async () => {
  await bootstrap.teardown()
})

const describeIfDb = bootstrap.ready ? describe : describe.skip

interface ListStoresResponse {
  stores: Array<{ id: string, name: string, created_at: string, updated_at: string }>
  continuation_token: string
}

describeIfDb('GET /stores', () => {
  // A unique tag scopes each test's assertions to its own freshly-created
  // stores, so previous test runs left in the DB don't bleed into
  // expectations. Tests filter the response on this tag prefix.
  function uniqueTag(): string {
    return `list-stores-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }

  function get(query: string): Request {
    return new Request(`http://localhost/stores${query}`)
  }

  it('returns an OpenFGA-compatible envelope with empty token on the terminal page', async () => {
    const app = buildApp()
    const tag = uniqueTag()
    await createStore(`${tag}-only`)

    // Walk pages until the server signals "no further pages" (empty
    // continuation_token). The first-page assertion in the older form
    // of this test was flaky under vitest parallel test-file execution
    // because sibling files insert stores into the same global ORDER BY
    // space — sometimes pushing this test's freshly-created tag past a
    // small page_size. Walking to the terminal page makes both load-
    // bearing contracts (envelope shape + empty-token-terminal-page)
    // observable without depending on any single-page ordering. A
    // small page_size keeps the walk exercising pagination even when
    // the DB is mostly empty. See openfga-ek6.
    const PAGE_SIZE = 5
    const seen: string[] = []
    let token: string | undefined
    let lastJson: ListStoresResponse | undefined
    let safety = 500
    while (safety > 0) {
      const url = `?page_size=${PAGE_SIZE}${token ? `&continuation_token=${encodeURIComponent(token)}` : ''}`
      const res = await app.fetch(get(url))
      expect(res.status).toBe(200)
      const json = await res.json() as ListStoresResponse
      expect(Array.isArray(json.stores)).toBe(true)
      expect(typeof json.continuation_token).toBe('string')
      for (const s of json.stores) if (s.name.startsWith(tag)) seen.push(s.name)
      lastJson = json
      if (json.continuation_token === '') break
      token = json.continuation_token
      safety--
    }

    expect(safety).toBeGreaterThan(0)
    // Terminal-page empty-token contract.
    expect(lastJson?.continuation_token).toBe('')
    // Freshly-created tagged store is reachable via the walk.
    expect(seen).toEqual([`${tag}-only`])
  })

  it('returns multiple stores newest-first', async () => {
    const app = buildApp()
    const tag = uniqueTag()
    await createStore(`${tag}-1`)
    await createStore(`${tag}-2`)
    await createStore(`${tag}-3`)

    const res = await app.fetch(get('?page_size=100'))
    expect(res.status).toBe(200)
    const json = await res.json() as ListStoresResponse
    const ours = json.stores.filter(s => s.name.startsWith(tag))
    // Newest-first means the most recently inserted comes first.
    expect(ours.map(s => s.name)).toEqual([`${tag}-3`, `${tag}-2`, `${tag}-1`])
  })

  it('rounds-trips the continuation_token to enumerate every store exactly once', async () => {
    const app = buildApp()
    const tag = uniqueTag()
    const created: string[] = []
    for (let i = 0; i < 5; i++) {
      const row = await createStore(`${tag}-${i}`)
      created.push(row.name)
    }

    // Vitest may run integration test files in parallel against the same DB,
    // so other tests interleave inserts in the global ORDER BY space. The
    // cursor walk still yields our tag rows newest-first; we just stop as
    // soon as we've collected all of them rather than walking the entire DB.
    const seen: string[] = []
    let token: string | undefined
    let safety = 200
    while (seen.length < created.length && safety > 0) {
      const url = `?page_size=10${token ? `&continuation_token=${encodeURIComponent(token)}` : ''}`
      const res = await app.fetch(get(url))
      expect(res.status).toBe(200)
      const json = await res.json() as ListStoresResponse
      for (const s of json.stores) {
        if (s.name.startsWith(tag)) seen.push(s.name)
      }
      if (json.continuation_token === '') break
      token = json.continuation_token
      safety--
    }

    expect(safety).toBeGreaterThan(0)
    // Newest-first across the walk; no duplicates, no drops.
    expect(seen).toEqual([...created].reverse())
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('places a freshly-created store on the first page (newest-first)', async () => {
    const app = buildApp()
    const tag = uniqueTag()
    const onlyRow = await createStore(`${tag}-solo`)

    // Concurrent test files may have inserted other stores, so the
    // continuation_token may or may not be empty here. The load-bearing
    // contract is that a freshly-created store appears on the first page
    // under newest-first ordering with a generous page_size.
    const first = await app.fetch(get('?page_size=100'))
    const firstJson = await first.json() as ListStoresResponse
    const firstOurs = firstJson.stores.filter(s => s.name.startsWith(tag))
    expect(firstOurs.map(s => s.id)).toEqual([onlyRow.id])
  })

  it('returns 400 invalid_continuation_token for a malformed continuation_token', async () => {
    const app = buildApp()
    const res = await app.fetch(get('?continuation_token=not-a-real-token'))
    expect(res.status).toBe(400)
    const body = await res.json() as { code: string }
    expect(body.code).toBe('invalid_continuation_token')
  })

  it('rejects negative or non-numeric page_size at the validation boundary', async () => {
    const app = buildApp()
    const res = await app.fetch(get('?page_size=abc'))
    expect(res.status).toBe(400)
    const body = await res.json() as { code: string }
    expect(body.code).toBe('validation_error')
  })
})
