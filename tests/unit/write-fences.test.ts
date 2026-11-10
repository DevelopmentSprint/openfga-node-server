/**
 * Pure helpers of the optional write-fence extension (openfga-pzm.4).
 */
import { describe, expect, it } from 'vitest'
import { parseWriteContext } from '../../src/routes/write-fences'
import { assertWriteDeadline, compareGenerations, WriteFenceError } from '../../src/storage/write-fences'

const FUTURE = '2999-01-01T00:00:00Z'

function headers(values: Record<string, string>): Headers {
  return new Headers(values)
}

describe('parseWriteContext', () => {
  it('returns an empty context without fence headers', () => {
    expect(parseWriteContext(headers({}))).toEqual({ deadline: undefined, fence: undefined })
  })

  it('accepts a standalone deadline and a complete fence', () => {
    expect(parseWriteContext(headers({ 'X-Not-After': FUTURE }))).toEqual({ deadline: { notAfter: Date.parse(FUTURE) }, fence: undefined })
    expect(parseWriteContext(headers({ 'X-Not-After': FUTURE, 'X-Write-Fence-Key': 'a.b_c:d-1', 'X-Write-Fence-Generation': '9223372036854775807' })))
      .toEqual({ deadline: { notAfter: Date.parse(FUTURE) }, fence: { key: 'a.b_c:d-1', generation: '9223372036854775807' } })
  })

  it.each<Record<string, string>>([
    { 'X-Not-After': 'later' },
    { 'X-Not-After': '2999-01-01T00:00:00+02:00' },
    { 'X-Write-Fence-Key': 'q', 'X-Write-Fence-Generation': '1' },
    { 'X-Not-After': FUTURE, 'X-Write-Fence-Key': 'q' },
    { 'X-Not-After': FUTURE, 'X-Write-Fence-Generation': '1' },
    { 'X-Not-After': FUTURE, 'X-Write-Fence-Key': '_q', 'X-Write-Fence-Generation': '1' },
    { 'X-Not-After': FUTURE, 'X-Write-Fence-Key': 'q', 'X-Write-Fence-Generation': '0' },
    { 'X-Not-After': FUTURE, 'X-Write-Fence-Key': 'q', 'X-Write-Fence-Generation': '1e3' },
    { 'X-Not-After': FUTURE, 'X-Write-Fence-Key': 'q', 'X-Write-Fence-Generation': '9223372036854775808' },
  ])('rejects malformed or incomplete headers %#', (values) => {
    expect(parseWriteContext(headers(values))).toBeNull()
  })
})

describe('compareGenerations', () => {
  it('compares numerically, not as text', () => {
    expect(compareGenerations('10', '9')).toBe(1)
    expect(compareGenerations('9', '10')).toBe(-1)
    expect(compareGenerations('9223372036854775807', '9223372036854775806')).toBe(1)
    expect(compareGenerations('42', '42')).toBe(0)
  })
})

describe('assertWriteDeadline', () => {
  it('passes without a deadline or before it, and fails at or after it', () => {
    expect(() => assertWriteDeadline(undefined)).not.toThrow()
    expect(() => assertWriteDeadline({ notAfter: 10, now: () => 9 })).not.toThrow()
    expect(() => assertWriteDeadline({ notAfter: 10, now: () => 10 })).toThrow(WriteFenceError)
    expect(() => assertWriteDeadline({ notAfter: Number.NaN })).toThrow(WriteFenceError)
  })
})
