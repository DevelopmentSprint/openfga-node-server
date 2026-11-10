/**
 * Integration tests for POST /stores/:storeId/list-users.
 *
 * Per-rewrite-shape coverage lives in the unit tests for the
 * evaluator. These integration tests confirm the route boundary —
 * envelope, contextual_tuples flat-array shape, model lookup error,
 * undefined-relation, and the user_filters length=1 enforcement.
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

interface ListUsersResponse {
  users: Array<{ object?: { type: string, id: string }, userset?: { type: string, id: string, relation: string }, wildcard?: { type: string } }>
}

describeIfDb('POST /stores/:storeId/list-users', () => {
  async function setup() {
    const app = buildApp()
    const store = await createStore(`list-users-${Date.now()}-${Math.random()}`)
    const model = await writeAuthorizationModel(store.id, {
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
    return { app, storeId: store.id, modelId: model.id }
  }

  function listUsersReq(storeId: string, body: unknown): Request {
    return new Request(`http://localhost/stores/${storeId}/list-users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('returns persisted users matching the filter', async () => {
    const { app, storeId, modelId } = await setup()
    await writeTuples(storeId, [
      { user: 'user:alice', relation: 'viewer', object: 'doc:1' },
      { user: 'user:bob', relation: 'viewer', object: 'doc:1' },
    ])

    const res = await app.fetch(listUsersReq(storeId, {
      authorization_model_id: modelId,
      object: { type: 'doc', id: '1' },
      relation: 'viewer',
      user_filters: [{ type: 'user' }],
    }))
    expect(res.status).toBe(200)
    const json = await res.json() as ListUsersResponse
    const ids = json.users.map((u) => u.object?.id).sort()
    expect(ids).toEqual(['alice', 'bob'])
  })

  it('flows contextual_tuples (flat array) into the result without persisting', async () => {
    const { app, storeId, modelId } = await setup()

    const res = await app.fetch(listUsersReq(storeId, {
      authorization_model_id: modelId,
      object: { type: 'doc', id: '1' },
      relation: 'viewer',
      user_filters: [{ type: 'user' }],
      contextual_tuples: [{ user: 'user:carol', relation: 'viewer', object: 'doc:1' }],
    }))
    expect(res.status).toBe(200)
    const json = await res.json() as ListUsersResponse
    expect(json.users).toEqual([{ object: { type: 'user', id: 'carol' } }])
  })

  it('returns 400 when the requested authorization_model_id does not exist', async () => {
    const { app, storeId } = await setup()
    const res = await app.fetch(listUsersReq(storeId, {
      authorization_model_id: '01ZZZZZZZZZZZZZZZZZZZZZZZZ',
      object: { type: 'doc', id: '1' },
      relation: 'viewer',
      user_filters: [{ type: 'user' }],
    }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when the requested relation is not defined on the type', async () => {
    const { app, storeId, modelId } = await setup()
    const res = await app.fetch(listUsersReq(storeId, {
      authorization_model_id: modelId,
      object: { type: 'doc', id: '1' },
      relation: 'editor',
      user_filters: [{ type: 'user' }],
    }))
    expect(res.status).toBe(400)
  })

  it('rejects user_filters with length != 1 at the validation boundary', async () => {
    const { app, storeId, modelId } = await setup()
    const empty = await app.fetch(listUsersReq(storeId, {
      authorization_model_id: modelId,
      object: { type: 'doc', id: '1' },
      relation: 'viewer',
      user_filters: [],
    }))
    expect(empty.status).toBe(400)

    const two = await app.fetch(listUsersReq(storeId, {
      authorization_model_id: modelId,
      object: { type: 'doc', id: '1' },
      relation: 'viewer',
      user_filters: [{ type: 'user' }, { type: 'group', relation: 'member' }],
    }))
    expect(two.status).toBe(400)
  })
})
