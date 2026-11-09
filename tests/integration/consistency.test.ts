import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../src/routes/index'
import { createStore } from '../../src/storage/stores'
import { writeAuthorizationModel } from '../../src/storage/authorization-models'
import * as tuples from '../../src/storage/tuples'
import { bootstrapIntegrationDb } from '../_helpers/integration-bootstrap'

const bootstrap = await bootstrapIntegrationDb()
afterAll(() => bootstrap.teardown())
afterEach(() => vi.restoreAllMocks())
const describeIfDb = bootstrap.ready ? describe : describe.skip
const tuple = { user: 'user:alice', relation: 'viewer', object: 'doc:1' }

const requests = [
  { endpoint: 'check', body: { tuple_key: tuple }, result: (present: boolean) => ({ allowed: present, resolution: '' }) },
  { endpoint: 'batch-check', body: { checks: [{ tuple_key: tuple, correlation_id: 'a' }] }, result: (present: boolean) => ({ result: { a: { allowed: present } } }) },
  { endpoint: 'list-objects', body: { type: 'doc', relation: 'viewer', user: 'user:alice' }, result: (present: boolean) => ({ objects: present ? ['doc:1'] : [] }) },
  { endpoint: 'streamed-list-objects', body: { type: 'doc', relation: 'viewer', user: 'user:alice' }, result: (present: boolean) => present ? [{ result: { object: 'doc:1' } }] : [] },
  { endpoint: 'list-users', body: { object: { type: 'doc', id: '1' }, relation: 'viewer', user_filters: [{ type: 'user' }] }, result: (present: boolean) => ({ users: present ? [{ object: { type: 'user', id: 'alice' } }] : [] }) },
  { endpoint: 'expand', body: { tuple_key: { object: 'doc:1', relation: 'viewer' } }, result: (present: boolean) => ({ tree: { root: { name: 'doc:1#viewer', leaf: { users: { users: present ? ['user:alice'] : [] } } } } }) },
  { endpoint: 'read', body: {}, result: (present: boolean) => ({ tuples: present ? [{ key: tuple, timestamp: expect.any(String) }] : [], continuation_token: '' }) },
]

async function setup() {
  const app = buildApp()
  const store = await createStore('consistency')
  await writeAuthorizationModel(store.id, {
    schema_version: '1.1',
    type_definitions: [
      { type: 'user' },
      { type: 'doc', relations: { viewer: { this: {} } }, metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'user' }] } } } },
    ],
  })
  function post(endpoint: string, body: unknown) {
    return app.request(`/stores/${store.id}/${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
  }
  return { storeId: store.id, post }
}

async function responseBody(response: Response, endpoint: string) {
  if (endpoint !== 'streamed-list-objects') return response.json()
  const text = await response.text()
  return text.trim() ? text.trim().split('\n').map(line => JSON.parse(line)) : []
}

describeIfDb('request consistency', () => {
  for (const request of requests) {
    describe(request.endpoint, () => {
      it.each([undefined, null, 'UNSPECIFIED', 'MINIMIZE_LATENCY', 'HIGHER_CONSISTENCY'])(
        'accepts %s and observes committed writes and deletions', async (consistency) => {
          const { post } = await setup()
          const body = { ...request.body, consistency }
          const initial = await post(request.endpoint, body)
          expect(initial.status).toBe(200)
          expect(await responseBody(initial, request.endpoint)).toEqual(request.result(false))
          expect((await post('write', { writes: { tuple_keys: [tuple] } })).status).toBe(200)
          const added = await post(request.endpoint, body)
          expect(added.status).toBe(200)
          expect(await responseBody(added, request.endpoint)).toEqual(request.result(true))
          expect((await post('write', { deletes: { tuple_keys: [tuple] } })).status).toBe(200)
          const removed = await post(request.endpoint, body)
          expect(removed.status).toBe(200)
          expect(await responseBody(removed, request.endpoint)).toEqual(request.result(false))
        },
      )

      it.each(['invalid', '', 'higher_consistency', 99, false, {}])('rejects invalid preference %j', async (consistency) => {
        const { post } = await setup()
        const response = await post(request.endpoint, { ...request.body, consistency })
        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({ code: 'invalid_argument', message: expect.any(String) })
      })

      it.each(['MINIMIZE_LATENCY', 'HIGHER_CONSISTENCY', 'UNSPECIFIED', null, undefined])('threads %s to real storage reads', async (consistency) => {
        const { post } = await setup()
        const spies = [
          vi.spyOn(tuples, 'listTuplesForRelation'),
          vi.spyOn(tuples, 'listUsersForRelation'),
          vi.spyOn(tuples, 'listObjectIdsForUser'),
          vi.spyOn(tuples, 'listAllForRelation'),
          vi.spyOn(tuples, 'readTuplesPage'),
        ]
        const response = await post(request.endpoint, { ...request.body, consistency })
        expect(response.status).toBe(200)
        const calls = spies.flatMap<unknown[]>(spy => spy.mock.calls)
        expect(calls.length).toBeGreaterThan(0)
        for (const call of calls) {
          expect(call.at(-1)).toEqual({ consistency: consistency === 'HIGHER_CONSISTENCY' ? consistency : 'MINIMIZE_LATENCY' })
        }
      })
    })
  }
})
