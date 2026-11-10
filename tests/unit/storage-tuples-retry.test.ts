/**
 * Bounded retry of the tuple mutation transaction (openfga-k2a.4):
 * only Postgres deadlock (40P01) and serialization (40001) failures
 * are retried, at most MAX_WRITE_ATTEMPTS times in total.
 */
import { describe, expect, it } from 'vitest'
import {
  DuplicateTupleError,
  MAX_WRITE_ATTEMPTS,
  retryOnTransactionConflict,
} from '../../src/storage/tuples'

function pgError(code: string): Error {
  return Object.assign(new Error(`pg ${code}`), { code })
}

const noDelay = () => 0

describe('retryOnTransactionConflict', () => {
  it.each(['40P01', '40001'])('retries %s and returns the eventual result', async (code) => {
    let calls = 0
    const result = await retryOnTransactionConflict(async () => {
      calls++
      if (calls < MAX_WRITE_ATTEMPTS) throw pgError(code)
      return 'ok'
    }, MAX_WRITE_ATTEMPTS, noDelay)
    expect(result).toBe('ok')
    expect(calls).toBe(MAX_WRITE_ATTEMPTS)
  })

  it('gives up after the attempt limit and rethrows the last error', async () => {
    let calls = 0
    await expect(retryOnTransactionConflict(async () => {
      calls++
      throw pgError('40P01')
    }, MAX_WRITE_ATTEMPTS, noDelay)).rejects.toMatchObject({ code: '40P01' })
    expect(calls).toBe(MAX_WRITE_ATTEMPTS)
  })

  it('does not retry other database errors', async () => {
    let calls = 0
    await expect(retryOnTransactionConflict(async () => {
      calls++
      throw pgError('23505')
    }, MAX_WRITE_ATTEMPTS, noDelay)).rejects.toMatchObject({ code: '23505' })
    expect(calls).toBe(1)
  })

  it('does not retry domain errors', async () => {
    let calls = 0
    const tuple = { user: 'user:a', relation: 'viewer', object: 'doc:1' }
    await expect(retryOnTransactionConflict(async () => {
      calls++
      throw new DuplicateTupleError(tuple)
    }, MAX_WRITE_ATTEMPTS, noDelay)).rejects.toBeInstanceOf(DuplicateTupleError)
    expect(calls).toBe(1)
  })
})
