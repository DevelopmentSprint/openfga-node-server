/**
 * Integration tests for OpenFGA write semantics.
 *
 * Runs against SQLite by default via the `integration` vitest project;
 * the `integration-pg` project re-runs the same specs against Postgres.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/routes/index'
import { createStore } from '../../src/storage/stores'
import { writeAuthorizationModel } from '../../src/storage/authorization-models'
import { readTuples } from '../../src/storage/tuples'
import { bootstrapIntegrationDb } from '../_helpers/integration-bootstrap'

const bootstrap = await bootstrapIntegrationDb()

afterAll(async () => {
  await bootstrap.teardown()
})

const describeIfDb = bootstrap.ready ? describe : describe.skip

describeIfDb('write endpoint semantics', () => {
  async function setup() {
    const app = buildApp()
    const store = await createStore(`write-semantics-${Date.now()}-${Math.random()}`)
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

  function request(storeId: string, body: unknown): Request {
    return new Request(`http://localhost/stores/${storeId}/write`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('rejects duplicates by default but ignores them when requested', async () => {
    const { app, storeId, modelId } = await setup()
    const tuple = { user: 'user:alice', relation: 'viewer', object: 'doc:1' }

    expect((await app.fetch(request(storeId, {
      authorization_model_id: modelId,
      writes: { tuple_keys: [tuple] },
    }))).status).toBe(200)

    expect((await app.fetch(request(storeId, {
      authorization_model_id: modelId,
      writes: { tuple_keys: [tuple] },
    }))).status).toBe(400)

    expect((await app.fetch(request(storeId, {
      authorization_model_id: modelId,
      writes: { tuple_keys: [tuple], on_duplicate: 'ignore' },
    }))).status).toBe(200)
  })

  it('rejects invalid tuples against the selected authorization model', async () => {
    const { app, storeId, modelId } = await setup()

    const res = await app.fetch(request(storeId, {
      authorization_model_id: modelId,
      writes: {
        tuple_keys: [{ user: 'user:alice', relation: 'editor', object: 'doc:1' }],
      },
    }))

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      code: 'invalid_argument',
      message: 'relation "editor" is not defined for type "doc"',
    })
  })

  it('rolls back mixed writes when a missing delete fails', async () => {
    const { app, storeId, modelId } = await setup()
    const createdBeforeFailure = { user: 'user:bob', relation: 'viewer', object: 'doc:rollback' }

    const res = await app.fetch(request(storeId, {
      authorization_model_id: modelId,
      writes: { tuple_keys: [createdBeforeFailure] },
      deletes: {
        tuple_keys: [{ user: 'user:missing', relation: 'viewer', object: 'doc:rollback' }],
      },
    }))

    expect(res.status).toBe(400)
    const rows = await readTuples(storeId, createdBeforeFailure)
    expect(rows).toEqual([])
  })
})
