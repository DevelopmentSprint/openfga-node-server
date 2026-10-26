/**
 * Integration test — DSL acceptance on POST /stores/:storeId/authorization-models.
 *
 * Verifies the four wire cases the feature spec calls out
 * (docs/features/dsl-write-model.md §"Wire Behavior"):
 *
 *   1. application/x-openfga-dsl + valid DSL  → 201 + retrievable model
 *   2. text/plain + valid DSL                  → 201 + retrievable model
 *   3. application/json + JSON model           → 201 (regression — unchanged)
 *   4. application/x-openfga-dsl + invalid DSL → 400 invalid_argument
 *
 * Runs against SQLite by default via the `integration` vitest project;
 * the `integration-pg` project re-runs the same specs against Postgres.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { transformer } from '@openfga/syntax-transformer'
import { buildApp } from '../../src/routes/index'
import { createStore } from '../../src/storage/stores'
import { bootstrapIntegrationDb } from '../_helpers/integration-bootstrap'

const MODEL_PATH = resolve(import.meta.dirname ?? '.', '..', 'fixtures', 'github.fga')

const bootstrap = await bootstrapIntegrationDb()

afterAll(async () => {
  await bootstrap.teardown()
})

const describeIfDb = bootstrap.ready ? describe : describe.skip

describeIfDb('POST /stores/:storeId/authorization-models — content-type negotiation', () => {
  it('accepts a DSL body with Content-Type: application/x-openfga-dsl and the model is retrievable', async () => {
    const app = buildApp()
    const store = await createStore(`dsl-${Date.now()}`)
    const dsl = readFileSync(MODEL_PATH, 'utf8')

    const writeRes = await app.fetch(new Request(`http://localhost/stores/${store.id}/authorization-models`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-openfga-dsl' },
      body: dsl,
    }))
    expect(writeRes.status).toBe(201)
    const writeJson = await writeRes.json() as { authorization_model_id: string }
    expect(writeJson.authorization_model_id).toBeTruthy()

    const getRes = await app.fetch(new Request(`http://localhost/stores/${store.id}/authorization-models/${writeJson.authorization_model_id}`))
    expect(getRes.status).toBe(200)
    const getJson = await getRes.json() as { authorization_model: { type_definitions: { type: string }[] } }
    const expectedTypeNames = transformer.transformDSLToJSONObject(dsl).type_definitions.map(t => t.type)
    const actualTypeNames = getJson.authorization_model.type_definitions.map(t => t.type)
    expect(actualTypeNames).toEqual(expectedTypeNames)
  })

  it('accepts a DSL body with Content-Type: application/x-openfga-dsl; charset=utf-8 (parameter tolerance)', async () => {
    const app = buildApp()
    const store = await createStore(`dsl-charset-${Date.now()}`)
    const dsl = readFileSync(MODEL_PATH, 'utf8')

    const res = await app.fetch(new Request(`http://localhost/stores/${store.id}/authorization-models`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-openfga-dsl; charset=utf-8' },
      body: dsl,
    }))
    expect(res.status).toBe(201)
    const json = await res.json() as { authorization_model_id: string }
    expect(json.authorization_model_id).toBeTruthy()
  })

  it('accepts a DSL body with Content-Type: text/plain', async () => {
    const app = buildApp()
    const store = await createStore(`dsl-textplain-${Date.now()}`)
    const dsl = readFileSync(MODEL_PATH, 'utf8')

    const res = await app.fetch(new Request(`http://localhost/stores/${store.id}/authorization-models`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: dsl,
    }))
    expect(res.status).toBe(201)
    const json = await res.json() as { authorization_model_id: string }
    expect(json.authorization_model_id).toBeTruthy()
  })

  it('preserves the existing JSON path with Content-Type: application/json (regression)', async () => {
    const app = buildApp()
    const store = await createStore(`dsl-json-${Date.now()}`)
    const dsl = readFileSync(MODEL_PATH, 'utf8')
    const modelJson = transformer.transformDSLToJSONObject(dsl)

    const res = await app.fetch(new Request(`http://localhost/stores/${store.id}/authorization-models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(modelJson),
    }))
    expect(res.status).toBe(201)
    const json = await res.json() as { authorization_model_id: string }
    expect(json.authorization_model_id).toBeTruthy()
  })

  it('treats unrelated content types (e.g. application/octet-stream) as the JSON path (regression for "anything else → JSON")', async () => {
    const app = buildApp()
    const store = await createStore(`dsl-octet-${Date.now()}`)
    const dsl = readFileSync(MODEL_PATH, 'utf8')
    const modelJson = transformer.transformDSLToJSONObject(dsl)

    // The Fetch API auto-fills Content-Type to text/plain when the
    // body is a string, so a truly absent header is hard to construct;
    // an unrelated explicit type exercises the same fall-through.
    const res = await app.fetch(new Request(`http://localhost/stores/${store.id}/authorization-models`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: JSON.stringify(modelJson),
    }))
    expect(res.status).toBe(201)
    const json = await res.json() as { authorization_model_id: string }
    expect(json.authorization_model_id).toBeTruthy()
  })

  it('returns 400 invalid_argument when the DSL is malformed', async () => {
    const app = buildApp()
    const store = await createStore(`dsl-bad-${Date.now()}`)

    const res = await app.fetch(new Request(`http://localhost/stores/${store.id}/authorization-models`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-openfga-dsl' },
      body: 'this is definitely not valid OpenFGA DSL <<<',
    }))
    expect(res.status).toBe(400)
    const body = await res.json() as { code: string; message: string }
    expect(body.code).toBe('invalid_argument')
    expect(body.message).toMatch(/dsl|parse|syntax/i)
  })

  it('returns 400 with the JSON path error when an empty body is sent as JSON (regression)', async () => {
    const app = buildApp()
    const store = await createStore(`dsl-emptyjson-${Date.now()}`)

    const res = await app.fetch(new Request(`http://localhost/stores/${store.id}/authorization-models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }))
    expect(res.status).toBe(400)
    // The request-validation boundary rejects this body before it
    // reaches the inline type_definitions check; the public contract
    // is the OpenFGA invalid_argument envelope, not any specific
    // message text.
    const body = await res.json() as { code: string; message: string }
    expect(body.code).toBe('invalid_argument')
  })
})
