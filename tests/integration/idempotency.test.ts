/**
 * Integration test — Idempotency-Key storage layer.
 *
 * Runs against SQLite by default via the `integration` vitest project;
 * the `integration-pg` project re-runs the same specs against Postgres.
 * Exercises:
 *
 *   - first claim succeeds with kind='claimed' and a claim token
 *   - second claim with same fingerprint while in-flight returns
 *     kind='in_flight' (409 territory)
 *   - second claim with a different fingerprint returns kind='mismatch'
 *     (422 territory)
 *   - completed key replays the cached response
 *   - expired keys are deleted on a fresh claim
 *   - releaseKey clears in-flight state for retry
 *   - an in-flight row older than the lease is reclaimable
 *     (openfga-k2a.3)
 *   - a stale owner cannot complete or release over the new owner's
 *     claim (openfga-k2a.3)
 */
import { describe, it, expect, afterAll } from 'vitest'
import { claimKey, completeKey, releaseKey, type ClaimResult } from '../../src/storage/idempotency'
import { bootstrapIntegrationDb } from '../_helpers/integration-bootstrap'

const bootstrap = await bootstrapIntegrationDb()

afterAll(async () => {
  await bootstrap.teardown()
})

const describeIfDb = bootstrap.ready ? describe : describe.skip

function uniqueKey(label: string): string {
  return `idem-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function tokenOf(result: ClaimResult): string {
  if (result.kind !== 'claimed') throw new Error(`expected claimed, got ${result.kind}`)
  return result.token
}

describeIfDb('idempotency storage', () => {
  it('first claim returns kind=claimed with a claim token', async () => {
    const key = uniqueKey('claim')
    const result = await claimKey(key, 'fingerprint-a', 60_000)
    expect(result.kind).toBe('claimed')
    expect(await releaseKey(key, tokenOf(result))).toBe(true)
  })

  it('second claim with same fingerprint while in-flight returns kind=in_flight', async () => {
    const key = uniqueKey('inflight')
    const first = await claimKey(key, 'fp-a', 60_000)
    expect(first.kind).toBe('claimed')

    const second = await claimKey(key, 'fp-a', 60_000)
    expect(second.kind).toBe('in_flight')

    await releaseKey(key, tokenOf(first))
  })

  it('second claim with different fingerprint returns kind=mismatch', async () => {
    const key = uniqueKey('mismatch')
    const first = await claimKey(key, 'fp-original', 60_000)

    const second = await claimKey(key, 'fp-different', 60_000)
    expect(second.kind).toBe('mismatch')

    await releaseKey(key, tokenOf(first))
  })

  it('completed key replays the cached response on next claim', async () => {
    const key = uniqueKey('replay')
    const first = await claimKey(key, 'fp-a', 60_000)
    expect(await completeKey(key, tokenOf(first), 200, { id: 'cached-store' })).toBe(true)

    const replayed = await claimKey(key, 'fp-a', 60_000)
    expect(replayed.kind).toBe('replay')
    if (replayed.kind === 'replay') {
      expect(replayed.status).toBe(200)
      expect(replayed.body).toEqual({ id: 'cached-store' })
    }
  })

  it('mismatch detection still applies after the original is completed', async () => {
    const key = uniqueKey('completed-mismatch')
    const first = await claimKey(key, 'fp-original', 60_000)
    await completeKey(key, tokenOf(first), 200, { id: 'cached-store' })

    const second = await claimKey(key, 'fp-different', 60_000)
    expect(second.kind).toBe('mismatch')
  })

  it('expired keys are deleted and the new claim wins', async () => {
    const key = uniqueKey('expired')
    const first = await claimKey(key, 'fp-old', 60_000)
    expect(first.kind).toBe('claimed')

    // Pretend the previous row aged past the TTL by claiming again
    // with ttlMs = 0 — every existing row is older than now()-0ms.
    const fresh = await claimKey(key, 'fp-new', 0)
    expect(fresh.kind).toBe('claimed')

    await releaseKey(key, tokenOf(fresh))
  })

  it('releaseKey clears in-flight state so a retry can claim cleanly', async () => {
    const key = uniqueKey('release')
    const first = await claimKey(key, 'fp-a', 60_000)
    await releaseKey(key, tokenOf(first))

    const retried = await claimKey(key, 'fp-a', 60_000)
    expect(retried.kind).toBe('claimed')

    await releaseKey(key, tokenOf(retried))
  })

  it('an in-flight row older than the lease is reclaimable (crashed owner does not block for the TTL)', async () => {
    const key = uniqueKey('lease')
    const crashed = await claimKey(key, 'fp-a', 60_000)
    expect(crashed.kind).toBe('claimed')

    // Inside the lease: still in flight.
    expect((await claimKey(key, 'fp-a', 60_000)).kind).toBe('in_flight')

    // Lease of 0 ms: the abandoned in-flight row is past its lease
    // while still well inside the 60s TTL.
    const reclaimed = await claimKey(key, 'fp-a', 60_000, { inFlightLeaseMs: 0 })
    expect(reclaimed.kind).toBe('claimed')

    await releaseKey(key, tokenOf(reclaimed))
  })

  it('a completed record is not affected by the in-flight lease', async () => {
    const key = uniqueKey('lease-completed')
    const first = await claimKey(key, 'fp-a', 60_000)
    await completeKey(key, tokenOf(first), 201, { id: 'kept' })

    const again = await claimKey(key, 'fp-a', 60_000, { inFlightLeaseMs: 0 })
    expect(again.kind).toBe('replay')
  })

  it('a stale owner cannot complete over, or release, the new owner\'s claim', async () => {
    const key = uniqueKey('ownership')
    const stale = await claimKey(key, 'fp-a', 60_000)
    const current = await claimKey(key, 'fp-a', 60_000, { inFlightLeaseMs: 0 })
    expect(current.kind).toBe('claimed')

    // The stale owner's handler finishes late. Neither of its writes
    // may touch the row the new owner holds.
    expect(await completeKey(key, tokenOf(stale), 200, { from: 'stale' })).toBe(false)
    expect(await releaseKey(key, tokenOf(stale))).toBe(false)
    expect((await claimKey(key, 'fp-a', 60_000)).kind).toBe('in_flight')

    // The rightful owner completes; replay carries its response.
    expect(await completeKey(key, tokenOf(current), 200, { from: 'current' })).toBe(true)
    const replay = await claimKey(key, 'fp-a', 60_000)
    expect(replay).toMatchObject({ kind: 'replay', status: 200, body: { from: 'current' } })

    // A late release from the stale owner still cannot delete it.
    expect(await releaseKey(key, tokenOf(stale))).toBe(false)
    expect((await claimKey(key, 'fp-a', 60_000)).kind).toBe('replay')
  })
})
