/**
 * Integration tests for the assertions routes.
 *
 * Pinned by openfga-hqr: GET returns the persisted set (or empty
 * array on a model that has never had assertions written), PUT
 * upserts the whole array per (store, model), the routes 404 on a
 * model id that doesn't belong to the store, and validation rejects
 * malformed bodies before they reach storage.
 *
 * Runs against SQLite by default via the `integration` vitest project;
 * the `integration-pg` project re-runs the same specs against Postgres
 * for a dialect-portability check.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/routes/index'
import { createStore } from '../../src/storage/stores'
import { writeAuthorizationModel } from '../../src/storage/authorization-models'
import { bootstrapIntegrationDb } from '../_helpers/integration-bootstrap'

const bootstrap = await bootstrapIntegrationDb()

afterAll(async () => {
  await bootstrap.teardown()
})

const describeIfDb = bootstrap.ready ? describe : describe.skip

interface ReadAssertionsResponse {
  authorization_model_id: string
  assertions: Array<{
    tuple_key: { user: string, relation: string, object: string }
    expectation: boolean
  }>
}

describeIfDb('GET/PUT /stores/:storeId/assertions/:authorizationModelId', () => {
  async function setup() {
    const app = buildApp()
    const store = await createStore(`assertions-${Date.now()}-${Math.random()}`)
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

  function getReq(storeId: string, modelId: string): Request {
    return new Request(`http://localhost/stores/${storeId}/assertions/${modelId}`)
  }

  function putReq(storeId: string, modelId: string, body: unknown): Request {
    return new Request(`http://localhost/stores/${storeId}/assertions/${modelId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('GET returns an empty assertions array for a model that has never had assertions written', async () => {
    const { app, storeId, modelId } = await setup()
    const res = await app.fetch(getReq(storeId, modelId))
    expect(res.status).toBe(200)
    const json = await res.json() as ReadAssertionsResponse
    expect(json).toEqual({ authorization_model_id: modelId, assertions: [] })
  })

  it('PUT followed by GET round-trips the assertion set', async () => {
    const { app, storeId, modelId } = await setup()
    const assertions = [
      {
        tuple_key: { user: 'user:alice', relation: 'viewer', object: 'doc:1' },
        expectation: true,
      },
      {
        tuple_key: { user: 'user:bob', relation: 'viewer', object: 'doc:1' },
        expectation: false,
      },
    ]

    const putRes = await app.fetch(putReq(storeId, modelId, { assertions }))
    expect(putRes.status).toBe(204)

    const getRes = await app.fetch(getReq(storeId, modelId))
    expect(getRes.status).toBe(200)
    const json = await getRes.json() as ReadAssertionsResponse
    expect(json.authorization_model_id).toBe(modelId)
    expect(json.assertions).toEqual(assertions)
  })

  it('PUT overwrites the existing assertions array (upsert semantics)', async () => {
    const { app, storeId, modelId } = await setup()
    const initial = [
      { tuple_key: { user: 'user:alice', relation: 'viewer', object: 'doc:1' }, expectation: true },
    ]
    const replacement = [
      { tuple_key: { user: 'user:bob', relation: 'viewer', object: 'doc:2' }, expectation: false },
      { tuple_key: { user: 'user:carol', relation: 'viewer', object: 'doc:3' }, expectation: true },
    ]

    await app.fetch(putReq(storeId, modelId, { assertions: initial }))
    await app.fetch(putReq(storeId, modelId, { assertions: replacement }))

    const json = await (await app.fetch(getReq(storeId, modelId))).json() as ReadAssertionsResponse
    expect(json.assertions).toEqual(replacement)
  })

  it('PUT preserves contextual_tuples and context on a written assertion', async () => {
    const { app, storeId, modelId } = await setup()
    const assertions = [
      {
        tuple_key: { user: 'user:alice', relation: 'viewer', object: 'doc:1' },
        expectation: true,
        contextual_tuples: [{ user: 'user:alice', relation: 'viewer', object: 'doc:1' }],
        context: { ip: '127.0.0.1' },
      },
    ]
    await app.fetch(putReq(storeId, modelId, { assertions }))
    const json = await (await app.fetch(getReq(storeId, modelId))).json() as ReadAssertionsResponse
    expect(json.assertions).toEqual(assertions)
  })

  it('GET returns 404 when the requested authorization_model_id does not exist on the store', async () => {
    const { app, storeId } = await setup()
    const res = await app.fetch(getReq(storeId, '01ZZZZZZZZZZZZZZZZZZZZZZZZ'))
    expect(res.status).toBe(404)
  })

  it('PUT returns 400 when the requested authorization_model_id does not exist on the store', async () => {
    const { app, storeId } = await setup()
    const res = await app.fetch(putReq(storeId, '01ZZZZZZZZZZZZZZZZZZZZZZZZ', { assertions: [] }))
    expect(res.status).toBe(400)
  })

  it('PUT rejects assertions with malformed object reference at the validation boundary', async () => {
    const { app, storeId, modelId } = await setup()
    const res = await app.fetch(putReq(storeId, modelId, {
      assertions: [
        {
          tuple_key: { user: 'user:alice', relation: 'viewer', object: 'no-colon' },
          expectation: true,
        },
      ],
    }))
    expect(res.status).toBe(400)
    const body = await res.json() as { code: string }
    expect(body.code).toBe('validation_error')
  })

  it('PUT rejects bodies missing the assertions field', async () => {
    const { app, storeId, modelId } = await setup()
    const res = await app.fetch(putReq(storeId, modelId, {}))
    expect(res.status).toBe(400)
    const body = await res.json() as { code: string }
    expect(body.code).toBe('validation_error')
  })
})
