/**
 * Project-owned OpenFGA SDK integration tests.
 * This is not the upstream OpenFGA conformance suite and does not establish
 * complete OpenFGA feature parity.
 *
 * Spins up the Hono app on a real socket and exercises every
 * implemented endpoint via @openfga/sdk's high-level OpenFgaClient.
 * The SDK uses axios for HTTP, so this verifies end-to-end wire
 * compatibility — request serialization, response shape, status
 * codes, and error envelope — rather than just unit-level evaluator
 * behavior.
 *
 * Per openfga-don, this test must fail loudly if any in-scope
 * endpoint regresses from "implemented" to "501". Runs against SQLite
 * by default via the `integration` vitest project; the
 * `integration-pg` project re-runs the same specs against Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serve, type ServerType } from '@hono/node-server'
import { OpenFgaClient } from '@openfga/sdk'
import { buildApp } from '../../src/routes/index'
import { bootstrapIntegrationDb } from '../_helpers/integration-bootstrap'

const bootstrap = await bootstrapIntegrationDb()

afterAll(async () => {
  await bootstrap.teardown()
})

const describeIfDb = bootstrap.ready ? describe : describe.skip

describeIfDb('@openfga/sdk conformance — OpenFgaClient against a live server', () => {
  let server: ServerType
  let apiUrl: string

  beforeAll(async () => {
    const app = buildApp()
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0 }, (info) => {
        apiUrl = `http://localhost:${info.port}`
        resolve()
      })
    })
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
    // DB teardown is handled by the top-level bootstrap.teardown afterAll.
  })

  function clientForStore(storeId?: string, authorizationModelId?: string): OpenFgaClient {
    return new OpenFgaClient({ apiUrl, storeId: storeId ?? '', authorizationModelId })
  }

  async function setupStoreAndModel() {
    const bootstrap = clientForStore()
    const store = await bootstrap.createStore({
      name: `sdk-conformance-${Date.now()}-${Math.random()}`,
    })
    const client = clientForStore(store.id)
    const model = await client.writeAuthorizationModel({
      schema_version: '1.1',
      type_definitions: [
        { type: 'user' },
        {
          type: 'group',
          relations: { member: { this: {} } },
          metadata: { relations: { member: { directly_related_user_types: [{ type: 'user' }] } } },
        },
        {
          type: 'doc',
          relations: { viewer: { this: {} } },
          metadata: {
            relations: {
              viewer: {
                directly_related_user_types: [
                  { type: 'user' },
                  { type: 'group', relation: 'member' },
                ],
              },
            },
          },
        },
      ],
    })
    return {
      client: clientForStore(store.id, model.authorization_model_id),
      storeId: store.id,
      modelId: model.authorization_model_id,
    }
  }

  it('createStore + listStores: a created store is enumerable via listStores', async () => {
    const bootstrap = clientForStore()
    const created = await bootstrap.createStore({ name: `sdk-list-${Date.now()}` })
    const list = await bootstrap.listStores()
    const ids = list.stores.map((s) => s.id)
    expect(ids).toContain(created.id)
  })

  it('writeAuthorizationModel + readAuthorizationModel: round-trips the model', async () => {
    const { client, modelId } = await setupStoreAndModel()
    const read = await client.readAuthorizationModel()
    expect(read.authorization_model?.id).toBe(modelId)
    expect(read.authorization_model?.type_definitions?.map((t) => t.type)).toEqual([
      'user',
      'group',
      'doc',
    ])
  })

  it('readAuthorizationModels: returns the latest model in the store', async () => {
    const { client, modelId } = await setupStoreAndModel()
    const list = await client.readAuthorizationModels()
    expect(list.authorization_models?.[0]?.id).toBe(modelId)
  })

  it('writeTuples + read: tuples round-trip through the persistence layer', async () => {
    const { client } = await setupStoreAndModel()
    await client.writeTuples([
      { user: 'user:alice', relation: 'viewer', object: 'doc:1' },
      { user: 'user:bob', relation: 'viewer', object: 'doc:1' },
    ])
    const read = await client.read({
      object: 'doc:1',
      relation: 'viewer',
    })
    const users = read.tuples.map((t) => t.key.user).sort()
    expect(users).toEqual(['user:alice', 'user:bob'])
  })

  it('check: returns allowed=true for a directly-granted tuple', async () => {
    const { client } = await setupStoreAndModel()
    await client.writeTuples([
      { user: 'user:alice', relation: 'viewer', object: 'doc:1' },
    ])
    const res = await client.check({ user: 'user:alice', relation: 'viewer', object: 'doc:1' })
    expect(res.allowed).toBe(true)
  })

  it('check: contextual_tuples flow into the evaluator without persistence', async () => {
    const { client } = await setupStoreAndModel()
    const res = await client.check({
      user: 'user:carol',
      relation: 'viewer',
      object: 'doc:1',
      contextualTuples: [{ user: 'user:carol', relation: 'viewer', object: 'doc:1' }],
    })
    expect(res.allowed).toBe(true)
  })

  it('listObjects: returns persisted object ids matching the user', async () => {
    const { client } = await setupStoreAndModel()
    await client.writeTuples([
      { user: 'user:alice', relation: 'viewer', object: 'doc:1' },
      { user: 'user:alice', relation: 'viewer', object: 'doc:2' },
    ])
    const res = await client.listObjects({ user: 'user:alice', relation: 'viewer', type: 'doc' })
    expect(res.objects.sort()).toEqual(['doc:1', 'doc:2'])
  })

  it('expand: returns a UsersetTree with direct grants in the leaf', async () => {
    const { client } = await setupStoreAndModel()
    await client.writeTuples([
      { user: 'user:alice', relation: 'viewer', object: 'doc:1' },
    ])
    const res = await client.expand({ relation: 'viewer', object: 'doc:1' })
    expect(res.tree?.root?.name).toBe('doc:1#viewer')
    expect(res.tree?.root?.leaf?.users?.users).toEqual(['user:alice'])
  })

  it('batchCheck: returns per-correlation-id allowed flags', async () => {
    const { client } = await setupStoreAndModel()
    await client.writeTuples([
      { user: 'user:alice', relation: 'viewer', object: 'doc:1' },
    ])
    const res = await client.batchCheck({
      checks: [
        {
          user: 'user:alice',
          relation: 'viewer',
          object: 'doc:1',
          correlationId: 'a-1',
        },
        {
          user: 'user:bob',
          relation: 'viewer',
          object: 'doc:1',
          correlationId: 'b-2',
        },
      ],
    })
    const a = res.result.find((r) => r.correlationId === 'a-1')
    const b = res.result.find((r) => r.correlationId === 'b-2')
    expect(a?.allowed).toBe(true)
    expect(b?.allowed).toBe(false)
  })

  it('listUsers: returns concrete user objects matching the filter', async () => {
    const { client } = await setupStoreAndModel()
    await client.writeTuples([
      { user: 'user:alice', relation: 'viewer', object: 'doc:1' },
      { user: 'user:bob', relation: 'viewer', object: 'doc:1' },
    ])
    const res = await client.listUsers({
      object: { type: 'doc', id: '1' },
      relation: 'viewer',
      user_filters: [{ type: 'user' }],
    })
    const ids = res.users.map((u) => u.object?.id).sort()
    expect(ids).toEqual(['alice', 'bob'])
  })

  it('writeAssertions + readAssertions: assertion sets round-trip', async () => {
    const { client, modelId } = await setupStoreAndModel()
    // The SDK's high-level writeAssertions takes the flat shape
    // {user, relation, object, expectation}[]. The wire format is
    // {assertions: {tuple_key, expectation}[]}; the SDK does the
    // conversion. readAssertions returns the wire shape.
    await client.writeAssertions([
      { user: 'user:alice', relation: 'viewer', object: 'doc:1', expectation: true },
      { user: 'user:bob', relation: 'viewer', object: 'doc:1', expectation: false },
    ])
    const read = await client.readAssertions()
    expect(read.authorization_model_id).toBe(modelId)
    expect(read.assertions).toEqual([
      { tuple_key: { user: 'user:alice', relation: 'viewer', object: 'doc:1' }, expectation: true },
      { tuple_key: { user: 'user:bob', relation: 'viewer', object: 'doc:1' }, expectation: false },
    ])
  })

  it('readChanges: returns a TUPLE_OPERATION_WRITE entry after writeTuples', async () => {
    const { client } = await setupStoreAndModel()
    await client.writeTuples([
      { user: 'user:alice', relation: 'viewer', object: 'doc:1' },
    ])
    const res = await client.readChanges({ type: 'doc' }, { pageSize: 100 })
    const found = res.changes.find(
      (c) =>
        c.tuple_key.user === 'user:alice'
        && c.tuple_key.relation === 'viewer'
        && c.tuple_key.object === 'doc:1',
    )
    expect(found?.operation).toBe('TUPLE_OPERATION_WRITE')
  })

  it('no in-scope endpoint returns 501', async () => {
    // The SDK calls above already fail loudly on a 501, but assert
    // explicitly for the canonical endpoints so this test fails
    // loudly if any of them regresses to a placeholder.
    const { storeId, modelId } = await setupStoreAndModel()
    const probes: Array<[string, string]> = [
      ['GET', `/stores`],
      ['POST', `/stores/${storeId}/check`],
      ['POST', `/stores/${storeId}/write`],
      ['POST', `/stores/${storeId}/read`],
      ['POST', `/stores/${storeId}/list-objects`],
      ['POST', `/stores/${storeId}/list-users`],
      ['POST', `/stores/${storeId}/expand`],
      ['POST', `/stores/${storeId}/batch-check`],
      ['GET', `/stores/${storeId}/changes`],
      ['GET', `/stores/${storeId}/assertions/${modelId}`],
    ]
    for (const [method, path] of probes) {
      const res = await fetch(`${apiUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'POST' ? '{}' : undefined,
      })
      expect(res.status, `${method} ${path}`).not.toBe(501)
    }
  })
})
