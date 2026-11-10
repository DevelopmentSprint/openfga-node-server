/**
 * Integration tests for resolution limits on the evaluation routes
 * (openfga-k2a.1): authorization_model_resolution_too_complex maps to
 * HTTP 400 like upstream, other errors keep the application envelope,
 * and recursive list-objects agrees with check over HTTP.
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

const TOO_COMPLEX = 'authorization_model_resolution_too_complex'

describeIfDb('resolution limits over HTTP', () => {
  async function setup() {
    const app = buildApp()
    const store = await createStore(`resolution-limits-${Date.now()}-${Math.random()}`)
    const model = await writeAuthorizationModel(store.id, {
      schema_version: '1.1',
      type_definitions: [
        { type: 'user' },
        {
          type: 'group',
          relations: { member: { this: {} } },
          metadata: { relations: { member: { directly_related_user_types: [{ type: 'user' }, { type: 'group', relation: 'member' }] } } },
        },
        {
          type: 'folder',
          relations: {
            parent: { this: {} },
            viewer: { union: { child: [{ this: {} }, { tupleToUserset: { tupleset: { relation: 'parent' }, computedUserset: { relation: 'viewer' } } }] } },
          },
          metadata: { relations: { parent: { directly_related_user_types: [{ type: 'folder' }] }, viewer: { directly_related_user_types: [{ type: 'user' }] } } },
        },
      ],
    })
    const chain = Array.from({ length: 29 }, (_, i) => ({ user: `group:g${i}#member`, relation: 'member', object: `group:g${i + 1}` }))
    await writeTuples(store.id, [{ user: 'user:alice', relation: 'member', object: 'group:g0' }, ...chain])
    return { app, storeId: store.id, modelId: model.id }
  }

  function post(storeId: string, path: string, body: unknown): Request {
    return new Request(`http://localhost/stores/${storeId}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('returns 400 authorization_model_resolution_too_complex from check', async () => {
    const { app, storeId, modelId } = await setup()
    const res = await app.fetch(post(storeId, 'check', {
      authorization_model_id: modelId,
      tuple_key: { user: 'user:alice', relation: 'member', object: 'group:g29' },
    }))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe(TOO_COMPLEX)
  })

  it('reports the limit per item in batch-check', async () => {
    const { app, storeId, modelId } = await setup()
    const res = await app.fetch(post(storeId, 'batch-check', {
      authorization_model_id: modelId,
      checks: [
        { tuple_key: { user: 'user:alice', relation: 'member', object: 'group:g29' }, correlation_id: 'deep' },
        { tuple_key: { user: 'user:alice', relation: 'member', object: 'group:g3' }, correlation_id: 'shallow' },
      ],
    }))
    expect(res.status).toBe(200)
    const json = await res.json() as { result: Record<string, { allowed?: boolean, error?: { input_error?: string } }> }
    expect(json.result.deep?.error?.input_error).toBe(TOO_COMPLEX)
    expect(json.result.shallow).toEqual({ allowed: true })
  })

  it('keeps the application envelope for other evaluation errors', async () => {
    const { app, storeId, modelId } = await setup()
    const res = await app.fetch(post(storeId, 'check', {
      authorization_model_id: modelId,
      tuple_key: { user: 'user:alice', relation: 'missing', object: 'group:g1' },
    }))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { code: string }).code).toBe('validation_error')
  })

  it('lists every folder in a recursive chain', async () => {
    const { app, storeId, modelId } = await setup()
    await writeTuples(storeId, [
      { user: 'user:alice', relation: 'viewer', object: 'folder:root' },
      { user: 'folder:root', relation: 'parent', object: 'folder:a' },
      { user: 'folder:a', relation: 'parent', object: 'folder:b' },
      { user: 'folder:b', relation: 'parent', object: 'folder:c' },
    ])
    const res = await app.fetch(post(storeId, 'list-objects', {
      authorization_model_id: modelId, user: 'user:alice', relation: 'viewer', type: 'folder',
    }))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { objects: string[] }).objects.sort()).toEqual(['folder:a', 'folder:b', 'folder:c', 'folder:root'])
  })
})
