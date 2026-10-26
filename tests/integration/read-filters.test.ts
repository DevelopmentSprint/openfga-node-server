/**
 * Integration tests for the /read endpoint's object-filter semantics.
 *
 * Pinned by openfga-7y8: tuple_key.object accepts both full
 * "type:id" references and type-only "type:" filters; the latter
 * returns every tuple of that type matching the rest of the filter.
 *
 * Runs against SQLite by default via the `integration` vitest project;
 * the `integration-pg` project re-runs the same specs against Postgres.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/routes/index'
import { createStore } from '../../src/storage/stores'
import { writeAuthorizationModel } from '../../src/storage/authorization-models'
import { writeTuples } from '../../src/storage/tuples'
import { bootstrapIntegrationDb } from '../_helpers/integration-bootstrap'

const bootstrap = await bootstrapIntegrationDb()

afterAll(async () => {
  await bootstrap.teardown()
})

const describeIfDb = bootstrap.ready ? describe : describe.skip

interface ReadResponse {
  tuples: Array<{ key: { user: string, relation: string, object: string } }>
}

describeIfDb('/read object-filter semantics', () => {
  async function setup() {
    const app = buildApp()
    const store = await createStore(`read-filters-${Date.now()}-${Math.random()}`)
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
    await writeTuples(store.id, [
      { user: 'user:alice', relation: 'viewer', object: 'doc:1' },
      { user: 'user:alice', relation: 'viewer', object: 'doc:2' },
      { user: 'user:bob', relation: 'viewer', object: 'folder:f1' },
    ])
    return { app, storeId: store.id }
  }

  function read(storeId: string, body: unknown): Request {
    return new Request(`http://localhost/stores/${storeId}/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('requires a user when an object filter omits the object id', async () => {
    const { app, storeId } = await setup()
    const res = await app.fetch(read(storeId, { tuple_key: { object: 'doc:' } }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'validation_error' })
  })

  it('returns the exact tuple for a full "type:id" filter (regression)', async () => {
    const { app, storeId } = await setup()
    const res = await app.fetch(read(storeId, { tuple_key: { object: 'doc:1' } }))
    expect(res.status).toBe(200)
    const json = await res.json() as ReadResponse
    expect(json.tuples).toHaveLength(1)
    expect(json.tuples[0]?.key.object).toBe('doc:1')
  })

  it('combines "type:" filter with relation/user constraints', async () => {
    const { app, storeId } = await setup()
    const res = await app.fetch(
      read(storeId, { tuple_key: { object: 'doc:', user: 'user:alice', relation: 'viewer' } }),
    )
    expect(res.status).toBe(200)
    const json = await res.json() as ReadResponse
    const objects = json.tuples.map((t) => t.key.object).sort()
    expect(objects).toEqual(['doc:1', 'doc:2'])
  })

  it('returns 400 for an object reference without a colon', async () => {
    const { app, storeId } = await setup()
    const res = await app.fetch(read(storeId, { tuple_key: { object: 'broken' } }))
    expect(res.status).toBe(400)
    const json = await res.json() as { code: string }
    expect(json.code).toBe('invalid_argument')
  })
})
