import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/routes/index'
import { bootstrapIntegrationDb } from '../_helpers/integration-bootstrap'
import { basicModel, modelCases } from '../_helpers/parity-models'

const bootstrap = await bootstrapIntegrationDb()
afterAll(() => bootstrap.teardown())
const app = buildApp()
const reference = process.env['OPENFGA_REFERENCE_URL']
const targets = reference ? ['local', reference] : ['local']

for (const target of targets) {
  async function request(path: string, body?: unknown, method = 'POST') {
    const init = { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }
    const response = target === 'local' ? await app.request(path, init) : await fetch(`${target}${path}`, init)
    const text = await response.text()
    return { status: response.status, text, json: () => JSON.parse(text) }
  }
  async function setup() {
    const store = await request('/stores', { name: 'rest-parity' })
    expect(store.status).toBe(201)
    return `/stores/${store.json().id}`
  }
  describe.skipIf(!bootstrap.ready)(`REST compatibility (${target})`, () => {
    it.each(modelCases)('model: $name', async ({ model, valid }) => {
      const base = await setup()
      const res = await request(`${base}/authorization-models`, model)
      expect(res.status, res.text).toBe(valid ? 201 : 400)
      const listed = await request(`${base}/authorization-models`, undefined, 'GET')
      expect(listed.json().authorization_models).toHaveLength(valid ? 1 : 0)
    })
    it('reads and idempotently soft-deletes stores and hides all scoped resources', async () => {
      const base = await setup()
      expect((await request('/stores/invalid', undefined, 'DELETE')).status).toBe(400)
      expect((await request(`${base}/authorization-models`, basicModel())).status).toBe(201)
      const store = await request(base, undefined, 'GET')
      expect(store.status).toBe(200)
      expect(store.json()).toMatchObject({ name: 'rest-parity', deleted_at: null })
      for (let n = 0; n < 2; n++) expect((await request(base, undefined, 'DELETE')).status).toBe(204)
      expect((await request(base, undefined, 'GET')).status).toBe(404)
      // The local middleware additionally rejects deleted-store tuple/model reads.
      if (target === 'local') {
        expect((await request(`${base}/read`, {})).status).toBe(404)
        expect((await request(`${base}/authorization-models`, undefined, 'GET')).status).toBe(404)
      }
    })
    it('pages immutable models in descending ID order without duplicates', async () => {
      const base = await setup()
      const ids: string[] = []
      for (let n = 0; n < 5; n++) ids.push((await request(`${base}/authorization-models`, basicModel())).json().authorization_model_id)
      const found: string[] = []
      let token = ''
      do {
        const page = await request(`${base}/authorization-models?page_size=2&continuation_token=${encodeURIComponent(token)}`, undefined, 'GET')
        expect(page.status, page.text).toBe(200)
        found.push(...page.json().authorization_models.map((m: { id: string }) => m.id))
        token = page.json().continuation_token
      } while (token && found.length < 10)
      expect(found).toEqual(ids.reverse())
      expect((await request(`${base}/authorization-models?continuation_token=invalid`, undefined, 'GET')).status).toBe(400)
    })
    it('matches Check validation, duplicate-write errors, and streamed result framing', async () => {
      const base = await setup()
      await request(`${base}/authorization-models`, basicModel())
      const tuple = { user: 'user:anne', relation: 'reader', object: 'document:one' }
      expect((await request(`${base}/write`, { writes: { tuple_keys: [tuple] } })).status).toBe(200)
      const duplicate = await request(`${base}/write`, { writes: { tuple_keys: [tuple] } })
      expect(duplicate.status).toBe(400)
      expect(duplicate.json().code).toBe('write_failed_due_to_invalid_input')
      expect((await request(`${base}/check`, { tuple_key: tuple })).json()).toEqual({ allowed: true, resolution: '' })
      for (const key of [{ ...tuple, relation: 'missing' }, { ...tuple, user: 'missing:anne' }]) {
        const invalid = await request(`${base}/check`, { tuple_key: key })
        expect(invalid.status).toBe(400)
        expect(invalid.json().code).toBe('validation_error')
      }
      const stream = await request(`${base}/streamed-list-objects`, { type: 'document', relation: 'reader', user: 'user:anne' })
      expect(stream.status, stream.text).toBe(200)
      expect(stream.text.trim().split('\n').map(line => JSON.parse(line))).toEqual([{ result: { object: 'document:one' } }])
      expect((await request(`${base}/read`, { tuple_key: { relation: 'reader' } })).status).toBe(400)
    })
    it('preserves userset self-membership and ignores tuples invalid under a newer model', async () => {
      const base = await setup()
      const model = {
        schema_version: '1.1', type_definitions: [
          { type: 'user' }, { type: 'other' },
          { type: 'group', relations: { member: { this: {} } }, metadata: { relations: { member: { directly_related_user_types: [{ type: 'user' }] } } } },
          { type: 'document', relations: { reader: { this: {} } }, metadata: { relations: { reader: { directly_related_user_types: [{ type: 'user' }] } } } },
        ],
      }
      expect((await request(`${base}/authorization-models`, model)).status).toBe(201)
      const self = { object: 'group:eng', relation: 'member', user: 'group:eng#member' }
      expect((await request(`${base}/check`, { tuple_key: self })).json().allowed).toBe(true)
      const users = await request(`${base}/list-users`, { object: { type: 'group', id: 'eng' }, relation: 'member', user_filters: [{ type: 'group', relation: 'member' }] })
      expect(users.json().users).toEqual([{ userset: { type: 'group', id: 'eng', relation: 'member' } }])
      expect((await request(`${base}/list-objects`, { type: 'group', relation: 'member', user: self.user })).json().objects).toEqual(['group:eng'])
      const tuple = { object: 'document:one', relation: 'reader', user: 'user:anne' }
      await request(`${base}/write`, { writes: { tuple_keys: [tuple] } })
      model.type_definitions[3]!.metadata!.relations.reader!.directly_related_user_types = [{ type: 'other' }]
      const changed = await request(`${base}/authorization-models`, model)
      expect(changed.status).toBe(201)
      expect((await request(`${base}/check`, { tuple_key: tuple, authorization_model_id: changed.json().authorization_model_id })).json().allowed).toBe(false)
    })
    it('handles wildcard intersections and nested exclusions', async () => {
      const base = await setup()
      const c = (relation: string) => ({ computedUserset: { relation } })
      const relations = {
        all: { this: {} }, some: { this: {} },
        both: { intersection: { child: [c('all'), c('some')] } },
        either: { union: { child: [c('all'), c('some')] } },
        except: { difference: { base: c('all'), subtract: c('some') } },
        double: { difference: { base: c('all'), subtract: c('except') } },
        empty: { intersection: { child: [c('except'), c('some')] } },
      }
      const model = await request(`${base}/authorization-models`, {
        schema_version: '1.1', type_definitions: [{ type: 'user' }, { type: 'doc', relations, metadata: { relations: Object.fromEntries(['all', 'some'].map(r => [r, { directly_related_user_types: [{ type: 'user' }, { type: 'user', wildcard: {} }] }])) } }],
      })
      expect(model.status, model.text).toBe(201)
      await request(`${base}/write`, { writes: { tuple_keys: [{ user: 'user:*', relation: 'all', object: 'doc:1' }, { user: 'user:anne', relation: 'some', object: 'doc:1' }] } })
      const anne = { object: { type: 'user', id: 'anne' } }
      const wildcard = { wildcard: { type: 'user' } }
      for (const [relation, expected] of Object.entries({ all: [wildcard], some: [anne], both: [anne], either: [wildcard, anne], except: [wildcard], double: [anne], empty: [] })) {
        const result = await request(`${base}/list-users`, { object: { type: 'doc', id: '1' }, relation, user_filters: [{ type: 'user' }] })
        expect(result.status, result.text).toBe(200)
        expect(result.json().users.map((u: unknown) => JSON.stringify(u)).sort(), relation).toEqual(expected.map(u => JSON.stringify(u)).sort())
      }
    })
  })
}
