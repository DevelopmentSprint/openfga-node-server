/**
 * Integration tests for POST /stores/:storeId/batch-check.
 *
 * Pinned by openfga-rvz: per-item correlation_id mapping, contextual
 * tuples on a per-item basis, mixed allowed/denied, model lookup
 * errors, and validation rejection paths (duplicate correlation_id,
 * malformed correlation_id, batch limits).
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

interface BatchCheckResponse {
  result: Record<string, { allowed?: boolean, error?: { internal_error?: string } }>
}

describeIfDb('POST /stores/:storeId/batch-check', () => {
  async function setup() {
    const app = buildApp()
    const store = await createStore(`batch-check-${Date.now()}-${Math.random()}`)
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

  function batchCheck(storeId: string, body: unknown): Request {
    return new Request(`http://localhost/stores/${storeId}/batch-check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('returns per-correlation-id allowed=true for tuples that exist', async () => {
    const { app, storeId, modelId } = await setup()
    await writeTuples(storeId, [
      { user: 'user:alice', relation: 'viewer', object: 'doc:1' },
      { user: 'user:bob', relation: 'viewer', object: 'doc:2' },
    ])

    const res = await app.fetch(batchCheck(storeId, {
      authorization_model_id: modelId,
      checks: [
        { tuple_key: { user: 'user:alice', relation: 'viewer', object: 'doc:1' }, correlation_id: 'a-1' },
        { tuple_key: { user: 'user:bob', relation: 'viewer', object: 'doc:2' }, correlation_id: 'b-2' },
      ],
    }))
    expect(res.status).toBe(200)
    const json = await res.json() as BatchCheckResponse
    expect(json.result['a-1']).toEqual({ allowed: true })
    expect(json.result['b-2']).toEqual({ allowed: true })
  })

  it('returns mixed allowed=true/false based on per-item tuple existence', async () => {
    const { app, storeId, modelId } = await setup()
    await writeTuples(storeId, [
      { user: 'user:alice', relation: 'viewer', object: 'doc:1' },
    ])

    const res = await app.fetch(batchCheck(storeId, {
      authorization_model_id: modelId,
      checks: [
        { tuple_key: { user: 'user:alice', relation: 'viewer', object: 'doc:1' }, correlation_id: 'yes' },
        { tuple_key: { user: 'user:alice', relation: 'viewer', object: 'doc:nope' }, correlation_id: 'no' },
      ],
    }))
    expect(res.status).toBe(200)
    const json = await res.json() as BatchCheckResponse
    expect(json.result['yes']).toEqual({ allowed: true })
    expect(json.result['no']).toEqual({ allowed: false })
  })

  it('honors per-item contextual_tuples without persisting them', async () => {
    const { app, storeId, modelId } = await setup()
    // No persisted tuples — both decisions must come from contextual.

    const res = await app.fetch(batchCheck(storeId, {
      authorization_model_id: modelId,
      checks: [
        {
          tuple_key: { user: 'user:alice', relation: 'viewer', object: 'doc:ctx' },
          contextual_tuples: { tuple_keys: [{ user: 'user:alice', relation: 'viewer', object: 'doc:ctx' }] },
          correlation_id: 'ctx-yes',
        },
        {
          tuple_key: { user: 'user:carol', relation: 'viewer', object: 'doc:ctx' },
          correlation_id: 'ctx-no',
        },
      ],
    }))
    expect(res.status).toBe(200)
    const json = await res.json() as BatchCheckResponse
    expect(json.result['ctx-yes']).toEqual({ allowed: true })
    expect(json.result['ctx-no']).toEqual({ allowed: false })
  })

  it('returns 404 when the requested authorization_model_id does not exist', async () => {
    const { app, storeId } = await setup()
    const res = await app.fetch(batchCheck(storeId, {
      authorization_model_id: '01ZZZZZZZZZZZZZZZZZZZZZZZZ',
      checks: [
        { tuple_key: { user: 'user:alice', relation: 'viewer', object: 'doc:1' }, correlation_id: 'x' },
      ],
    }))
    expect(res.status).toBe(404)
    const body = await res.json() as { code: string }
    expect(body.code).toBe('authorization_model_not_found')
  })

  it('rejects duplicate correlation_id at the validation boundary', async () => {
    const { app, storeId, modelId } = await setup()
    const res = await app.fetch(batchCheck(storeId, {
      authorization_model_id: modelId,
      checks: [
        { tuple_key: { user: 'user:alice', relation: 'viewer', object: 'doc:1' }, correlation_id: 'dup' },
        { tuple_key: { user: 'user:bob', relation: 'viewer', object: 'doc:2' }, correlation_id: 'dup' },
      ],
    }))
    expect(res.status).toBe(400)
    const body = await res.json() as { code: string }
    expect(body.code).toBe('validation_error')
  })

  it('rejects malformed correlation_id (chars outside [A-Za-z0-9-]) at the validation boundary', async () => {
    const { app, storeId, modelId } = await setup()
    const res = await app.fetch(batchCheck(storeId, {
      authorization_model_id: modelId,
      checks: [
        { tuple_key: { user: 'user:alice', relation: 'viewer', object: 'doc:1' }, correlation_id: 'has space' },
      ],
    }))
    expect(res.status).toBe(400)
    const body = await res.json() as { code: string }
    expect(body.code).toBe('validation_error')
  })

  it('rejects empty checks array at the validation boundary', async () => {
    const { app, storeId } = await setup()
    const res = await app.fetch(batchCheck(storeId, { checks: [] }))
    expect(res.status).toBe(400)
    const body = await res.json() as { code: string }
    expect(body.code).toBe('validation_error')
  })
})
