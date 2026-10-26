import { describe, it, expect } from 'vitest'
import type { Condition, ConditionParamTypeRef, TypeName } from '@openfga/sdk'
import { Conditions } from '../../src/evaluator/conditions'

function condition(expression: string, parameters: Record<string, string | ConditionParamTypeRef> = {}): Conditions {
  const c: Condition = { name: 'test', expression, parameters: Object.fromEntries(Object.entries(parameters).map(([key, ref]) => [key, typeof ref === 'string' ? { type_name: `TYPE_NAME_${ref}` as TypeName } : ref])) }
  return new Conditions({ test: c })
}
const edge = { name: 'test' }

describe('standard condition semantics', () => {
  it('preserves nanosecond timestamp comparisons and duration arithmetic', () => {
    const c = condition('now < start + ttl', { now: 'TIMESTAMP', start: 'TIMESTAMP', ttl: 'DURATION' })
    const context = { start: '2026-01-01T00:00:00.000000001Z', ttl: '1ns' }
    expect(c.evaluate({ ...edge, context }, { now: '2026-01-01T00:00:00.000000001Z' })).toBe(true)
    expect(c.evaluate({ ...edge, context }, { now: '2026-01-01T00:00:00.000000002Z' })).toBe(false)
  })
  it('uses persisted context over caller context', () => {
    const c = condition('value == 1', { value: 'INT' })
    expect(c.evaluate({ ...edge, context: { value: 1 } }, { value: 2 })).toBe(true)
    expect(() => c.evaluate(edge)).toThrow()
    expect(() => c.evaluate(edge, { value: 1.5 })).toThrow()
  })
  it('preserves signed precision and upstream saturating numeric conversion', () => {
    const c = condition('value == 9223372036854775807', { value: 'INT' })
    expect(c.evaluate(edge, { value: '9223372036854775807' })).toBe(true)
    expect(c.evaluate(edge, { value: '9223372036854775808' })).toBe(true)
    expect(condition('value == 18446744073709551615u', { value: 'UINT' }).evaluate(edge, { value: '18446744073709551615' })).toBe(false)
  })
  it('validates condition definitions and typed contexts', () => {
    expect(() => condition('unknown == 1')).toThrow()
    expect(() => condition('1 + 2')).toThrow()
    expect(() => condition('n + "bad" == 1', { n: 'INT' })).toThrow()
    expect(() => condition('true').validateContext({ ...edge, context: { unknown: 1 } })).toThrow()
  })
  it('supports typed collections and CEL macros', () => {
    const c = condition('items.all(x, x > 0)', { items: { type_name: 'TYPE_NAME_LIST' as TypeName, generic_types: [{ type_name: 'TYPE_NAME_INT' as TypeName }] } })
    expect(c.evaluate(edge, { items: [1, 2] })).toBe(true)
    expect(c.evaluate(edge, { items: [1, 0] })).toBe(false)
    expect(() => c.evaluate(edge, { items: [true] })).toThrow()
  })
  it('supports IPv4, IPv6, mapped addresses, and CIDR validation', () => {
    const c = condition('ip.in_cidr(network)', { ip: 'IPADDRESS', network: 'STRING' })
    expect(c.evaluate(edge, { ip: '10.1.2.3', network: '10.0.0.0/8' })).toBe(true)
    expect(c.evaluate(edge, { ip: '::ffff:10.1.2.3', network: '10.0.0.0/8' })).toBe(true)
    expect(c.evaluate(edge, { ip: '2001:db8::1', network: '2001:db8::/32' })).toBe(true)
    expect(c.evaluate(edge, { ip: '10.1.2.3', network: '192.168.0.0/16' })).toBe(false)
    expect(() => c.evaluate(edge, { ip: '10.1.2.3', network: 'bad' })).toThrow()
    expect(condition('ipaddress("10.1.2.3").in_cidr("10.0.0.0/8")').evaluate(edge)).toBe(true)
  })
  it('handles maps, dynamic values, doubles, and IP string conversion', () => {
    expect(condition('values["n"] == 3', { values: { type_name: 'TYPE_NAME_MAP' as TypeName, generic_types: [{ type_name: 'TYPE_NAME_INT' as TypeName }] } }).evaluate(edge, { values: { n: '3' } })).toBe(true)
    expect(condition('value.a[0] == 1.0', { value: 'ANY' }).evaluate(edge, { value: { a: [1] } })).toBe(true)
    expect(condition('value > 1.0', { value: 'DOUBLE' }).evaluate(edge, { value: 1.5 })).toBe(true)
    expect(condition('string(ip) == "10.1.2.3"', { ip: 'IPADDRESS' }).evaluate(edge, { ip: '10.1.2.3' })).toBe(true)
    expect(condition('ip == ipaddress("10.1.2.3")', { ip: 'IPADDRESS' }).evaluate(edge, { ip: '::ffff:10.1.2.3' })).toBe(true)
    expect(() => condition('true', { unused: 'BOOL' }).evaluate(edge)).toThrow('missing')
  })
  it('matches upstream decimal-to-binary conversion and integer notation', () => {
    expect(condition('n == 100', { n: 'INT' }).evaluate(edge, { n: '1e2' })).toBe(true)
    expect(condition('n == 3', { n: 'INT' }).evaluate(edge, { n: '3.0' })).toBe(true)
    expect(condition('n == 1', { n: 'INT' }).evaluate(edge, { n: '1.00000000000000000000001' })).toBe(true)
    expect(condition('n == 0.5', { n: 'DOUBLE' }).evaluate(edge, { n: '0.5' })).toBe(true)
    expect(() => condition('n > 0.0', { n: 'DOUBLE' }).evaluate(edge, { n: '0.1' })).toThrow('exactly')
    expect(() => condition('n == 0u', { n: 'UINT' }).evaluate(edge, { n: -1 })).toThrow()
  })
  it('uses RE2 matching and rejects unsupported backreferences', () => {
    expect(condition('s.matches("^a+$")', { s: 'STRING' }).evaluate(edge, { s: 'aaa' })).toBe(true)
    expect(() => condition('s.matches(pattern)', { s: 'STRING', pattern: 'STRING' }).evaluate(edge, { s: 'aa', pattern: '(a)\\1' })).toThrow()
  })
  it('rejects excessive nested comprehension work before evaluation', () => {
    const c = condition('xs.all(x, xs.all(y, x == y))', { xs: { type_name: 'TYPE_NAME_LIST' as TypeName, generic_types: [{ type_name: 'TYPE_NAME_INT' as TypeName }] } })
    expect(() => c.evaluate(edge, { xs: Array(1000).fill(1) })).toThrow('budget')
  })
})
