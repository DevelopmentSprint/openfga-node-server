import { describe, expect, it } from 'vitest'
import type { Condition, ConditionParamTypeRef, TypeName } from '@openfga/sdk'
import { Conditions } from '../../src/evaluator/conditions'

const url = process.env['OPENFGA_REFERENCE_URL']
const cases: Array<{ name: string, expression: string, parameters: Record<string, string | ConditionParamTypeRef>, context: Record<string, unknown> }> = [
  { name: 'nanoseconds', expression: 'a < b', parameters: { a: 'TIMESTAMP', b: 'TIMESTAMP' }, context: { a: '2026-01-01T00:00:00.000000001Z', b: '2026-01-01T00:00:00.000000002Z' } },
  { name: 'expiry boundary', expression: 'now < start + ttl', parameters: { now: 'TIMESTAMP', start: 'TIMESTAMP', ttl: 'DURATION' }, context: { now: '2026-01-01T00:00:00.000000002Z', start: '2026-01-01T00:00:00.000000001Z', ttl: '1ns' } },
  { name: 'signed integer precision', expression: 'n == 9223372036854775807', parameters: { n: 'INT' }, context: { n: '9223372036854775807' } },
  { name: 'unsigned integer precision', expression: 'n == 18446744073709551615u', parameters: { n: 'UINT' }, context: { n: '18446744073709551615' } },
  { name: 'invalid numeric value', expression: 'n > 1', parameters: { n: 'INT' }, context: { n: 1.5 } },
  { name: 'scientific integer string', expression: 'n == 100', parameters: { n: 'INT' }, context: { n: '1e2' } },
  { name: 'integral decimal string', expression: 'n == 3', parameters: { n: 'INT' }, context: { n: '3.0' } },
  { name: 'rounded decimal string', expression: 'n == 1', parameters: { n: 'INT' }, context: { n: '1.00000000000000000000001' } },
  { name: 'inexact double string', expression: 'n > 0.0', parameters: { n: 'DOUBLE' }, context: { n: '0.1' } },
  { name: 'exact double string', expression: 'n == 0.5', parameters: { n: 'DOUBLE' }, context: { n: '0.5' } },
  { name: 'IP network membership', expression: 'ip.in_cidr("10.0.0.0/8")', parameters: { ip: 'IPADDRESS' }, context: { ip: '::ffff:10.2.3.4' } },
  { name: 'IP equality', expression: 'ip == ipaddress("10.2.3.4")', parameters: { ip: 'IPADDRESS' }, context: { ip: '::ffff:10.2.3.4' } },
  { name: 'map parameters', expression: 'values["count"] == 3', parameters: { values: { type_name: 'TYPE_NAME_MAP' as TypeName, generic_types: [{ type_name: 'TYPE_NAME_INT' as TypeName }] } }, context: { values: { count: '3' } } },
  { name: 'list parameters', expression: 'values.exists(x, x == 3)', parameters: { values: { type_name: 'TYPE_NAME_LIST' as TypeName, generic_types: [{ type_name: 'TYPE_NAME_INT' as TypeName }] } }, context: { values: [1, 3] } },
  { name: 'missing unused parameter', expression: 'true', parameters: { unused: 'BOOL' }, context: {} },
  { name: 'missing parameter in short circuit', expression: 'true || enabled', parameters: { enabled: 'BOOL' }, context: {} },
  { name: 'CEL error suppression', expression: 'true || (1 / 0 > 0)', parameters: {}, context: {} },
  { name: 'regex search', expression: 'text.matches("a+")', parameters: { text: 'STRING' }, context: { text: 'baa' } },
]

describe.skipIf(!url)('condition decisions against pinned OpenFGA reference', () => {
  it.each(cases)('$name', async ({ expression, parameters, context }) => {
    const definition: Condition = { name: 'test', expression, parameters: Object.fromEntries(Object.entries(parameters).map(([name, ref]) => [name, typeof ref === 'string' ? { type_name: `TYPE_NAME_${ref}` as TypeName } : ref])) }
    async function post(path: string, body: unknown) {
      const response = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: response.status, body: await response.json() as { id: string, allowed: boolean, message?: string } }
    }
    const store = await post('/stores', { name: 'condition-differential' })
    const base = `/stores/${store.body.id}`
    const model = await post(`${base}/authorization-models`, {
      schema_version: '1.1', conditions: { test: definition }, type_definitions: [
        { type: 'user' }, { type: 'document', relations: { reader: { this: {} } }, metadata: { relations: { reader: { directly_related_user_types: [{ type: 'user', condition: 'test' }] } } } },
      ],
    })
    expect(model.status, model.body.message).toBe(201)
    const tuple = { user: 'user:anne', relation: 'reader', object: 'document:one' }
    const reference = await post(`${base}/check`, { tuple_key: tuple, context, contextual_tuples: { tuple_keys: [{ ...tuple, condition: { name: 'test' } }] } })
    let local: boolean | 'error'
    try { local = new Conditions({ test: definition }).evaluate({ name: 'test' }, context) }
    catch { local = 'error' }
    expect(local, reference.body.message).toEqual(reference.status === 200 ? reference.body.allowed : 'error')
  })
})
