import type { User, Tuple, TupleChange, UsersetTree } from '@openfga/sdk'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/routes/index'
import { bootstrapIntegrationDb } from '../_helpers/integration-bootstrap'

const bootstrap = await bootstrapIntegrationDb()
afterAll(() => bootstrap.teardown())
const describeDb = bootstrap.ready ? describe : describe.skip
const app = buildApp()
const conditional = { type: 'user', condition: 'eligible' }
const definition = {
  schema_version: '1.1',
  type_definitions: [
    { type: 'user' },
    { type: 'group', relations: { member: { this: {} } }, metadata: { relations: { member: { directly_related_user_types: [conditional] } } } },
    { type: 'document', relations: {
      reader: { this: {} }, blocked: { this: {} }, public: { this: {} },
      viewer: { union: { child: [{ computedUserset: { relation: 'reader' } }, { computedUserset: { relation: 'public' } }] } },
      restricted: { intersection: { child: [{ computedUserset: { relation: 'reader' } }, { computedUserset: { relation: 'public' } }] } },
      permitted: { difference: { base: { computedUserset: { relation: 'reader' } }, subtract: { computedUserset: { relation: 'blocked' } } } },
      parent: { this: {} }, inherited: { tupleToUserset: { tupleset: { relation: 'parent' }, computedUserset: { relation: 'viewer' } } },
    }, metadata: { relations: {
      reader: { directly_related_user_types: [conditional, { type: 'group', relation: 'member', condition: 'eligible' }, { type: 'user', wildcard: {}, condition: 'eligible' }] },
      blocked: { directly_related_user_types: [conditional] }, public: { directly_related_user_types: [{ type: 'user' }] },
      parent: { directly_related_user_types: [{ type: 'document', condition: 'eligible' }] },
    } } },
  ],
  conditions: { eligible: { name: 'eligible', expression: 'enabled', parameters: { enabled: { type_name: 'TYPE_NAME_BOOL' } } } },
}
async function request(path: string, body?: unknown, method = 'POST') {
  const init = { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }
  const response = process.env['OPENFGA_REFERENCE_URL']
    ? await fetch(`${process.env['OPENFGA_REFERENCE_URL']}${path}`, init)
    : await app.request(path, init)
  return { status: response.status, body: await response.json() as { id: string, tree: UsersetTree, allowed: boolean, objects: string[], users: User[], tuples: Tuple[], changes: TupleChange[], result: Record<string, { allowed?: boolean, error: { input_error?: string } }> } }
}
async function setup() {
  const store = await request('/stores', { name: 'conditional-tuples' })
  const base = `/stores/${store.body.id}`
  const model = await request(`${base}/authorization-models`, definition)
  // Existing creation-status difference is tracked in the parity inventory.
  expect(model.status).toBe(process.env['OPENFGA_REFERENCE_URL'] ? 201 : 200)
  return base
}
const tk = (object = 'document:one', relation = 'reader', user = 'user:anne', context?: Record<string, unknown>) => ({
  object, relation, user, condition: { name: 'eligible', ...(context ? { context } : {}) },
})

describeDb('conditional tuples over HTTP and portable storage', () => {
  it('round-trips conditions in Read and Changes and evaluates four query APIs', async () => {
    const base = await setup()
    expect((await request(`${base}/write`, { writes: { tuple_keys: [tk()] } })).status).toBe(200)
    const read = await request(`${base}/read`, {})
    expect(read.body.tuples[0]!.key.condition).toEqual({ name: 'eligible', context: {} })
    const changes = await request(`${base}/changes`, undefined, 'GET')
    expect(changes.body.changes[0]!.tuple_key.condition).toEqual({ name: 'eligible', context: {} })
    for (const enabled of [false, true]) {
      expect((await request(`${base}/check`, { tuple_key: tk(), context: { enabled } })).body.allowed).toBe(enabled)
      expect((await request(`${base}/list-objects`, { type: 'document', relation: 'reader', user: 'user:anne', context: { enabled } })).body.objects).toEqual(enabled ? ['document:one'] : [])
      expect((await request(`${base}/list-users`, { object: { type: 'document', id: 'one' }, relation: 'reader', user_filters: [{ type: 'user' }], context: { enabled } })).body.users).toEqual(enabled ? [{ object: { type: 'user', id: 'anne' } }] : [])
    }
    expect((await request(`${base}/check`, { tuple_key: tk() })).status).toBe(400)
    const batch = await request(`${base}/batch-check`, { checks: [
      { tuple_key: tk(), correlation_id: 'yes', context: { enabled: true } },
      { tuple_key: tk(), correlation_id: 'no', context: { enabled: false } },
      { tuple_key: tk(), correlation_id: 'missing' },
    ] })
    expect(batch.body.result.yes).toEqual({ allowed: true })
    expect(batch.body.result.no).toEqual({ allowed: false })
    expect(batch.body.result.missing!.error.input_error).toBe('validation_error')
  })
  it('validates exact facets, context types and conditional-only restrictions', async () => {
    const base = await setup()
    const { condition: _, ...plain } = tk()
    expect((await request(`${base}/write`, { writes: { tuple_keys: [plain] } })).status).toBe(400)
    expect((await request(`${base}/write`, { writes: { tuple_keys: [tk('document:one', 'public')] } })).status).toBe(400)
    expect((await request(`${base}/write`, { writes: { tuple_keys: [tk('document:one', 'reader', 'user:anne', { enabled: 'yes' })] } })).status).toBe(400)
    const bad = await request(`${base}/check`, { tuple_key: plain, contextual_tuples: { tuple_keys: [plain] } })
    expect(bad.status).toBe(400)
    expect((await request(`${base}/authorization-models`, { ...definition, conditions: { eligible: { ...definition.conditions.eligible, expression: 'undeclared' } } })).status).toBe(400)
    expect((await request(`${base}/authorization-models`, { ...definition, conditions: {} })).status).toBe(400)
  })
  it('overrides stored tuples with contextual tuples, then discards the overlay', async () => {
    const base = await setup()
    await request(`${base}/write`, { writes: { tuple_keys: [tk('document:one', 'reader', 'user:anne', { enabled: false })] } })
    expect((await request(`${base}/check`, { tuple_key: tk(), context: { enabled: true } })).body.allowed).toBe(false)
    const contextual = [tk('document:one', 'reader', 'user:anne', { enabled: true })]
    expect((await request(`${base}/check`, { tuple_key: tk(), context: { enabled: false }, contextual_tuples: { tuple_keys: contextual } })).body.allowed).toBe(true)
    expect((await request(`${base}/check`, { tuple_key: tk(), context: { enabled: true } })).body.allowed).toBe(false)
    expect((await request(`${base}/read`, {})).body.tuples[0]!.key.condition!.context).toEqual({ enabled: false })
    expect((await request(`${base}/changes`, undefined, 'GET')).body.changes[0]!.tuple_key.condition!.context).toEqual({ enabled: false })
  })
  it('evaluates usersets and parent edges and preserves decisive error algebra', async () => {
    const base = await setup()
    const writes = [
      tk('group:eng', 'member'), tk('document:one', 'reader', 'group:eng#member'),
      tk('document:child', 'parent', 'document:one'),
      { user: 'user:anne', relation: 'public', object: 'document:one' },
      tk('document:one', 'blocked', 'user:anne', { enabled: true }),
    ]
    expect((await request(`${base}/write`, { writes: { tuple_keys: writes } })).status).toBe(200)
    const query = (relation: string, context?: unknown, object = 'document:one') => request(`${base}/check`, { tuple_key: { user: 'user:anne', relation, object }, context })
    expect((await query('viewer')).body.allowed).toBe(true) // true OR missing
    expect((await query('permitted')).body.allowed).toBe(false) // missing AND NOT true
    expect((await query('inherited', { enabled: true }, 'document:child')).body.allowed).toBe(true)
    expect((await query('inherited', { enabled: false }, 'document:child')).body.allowed).toBe(false)
    expect((await request(`${base}/list-objects`, { user: 'user:anne', relation: 'reader', type: 'document', context: { enabled: true } })).body.objects).toContain('document:one')
    expect((await request(`${base}/list-users`, { object: { type: 'document', id: 'one' }, relation: 'reader', user_filters: [{ type: 'user' }], context: { enabled: true } })).body.users).toContainEqual({ object: { type: 'user', id: 'anne' } })
  })
  it('expands conditional edges without evaluating them', async () => {
    const base = await setup()
    await request(`${base}/write`, { writes: { tuple_keys: [tk('document:one', 'reader', 'user:anne', { enabled: false })] } })
    const expanded = await request(`${base}/expand`, { tuple_key: { object: 'document:one', relation: 'reader' } })
    expect(expanded.status).toBe(200)
    expect(expanded.body.tree.root?.leaf?.users?.users).toContain('user:anne')
  })
  it('keeps condition changes out of tuple identity and permits deletion without condition', async () => {
    const base = await setup()
    await request(`${base}/write`, { writes: { tuple_keys: [tk()] } })
    expect((await request(`${base}/write`, { writes: { tuple_keys: [tk('document:one', 'reader', 'user:anne', { enabled: true })] } })).status).toBe(process.env['OPENFGA_REFERENCE_URL'] ? 400 : 409)
    const { condition: _, ...plain } = tk()
    expect((await request(`${base}/write`, { deletes: { tuple_keys: [plain] } })).status).toBe(200)
    expect((await request(`${base}/read`, {})).body.tuples).toEqual([])
  })
})
