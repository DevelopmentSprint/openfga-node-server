/**
 * Unit tests for `tuples.ts` and `idempotency.ts` against in-memory
 * SQLite. Bootstraps the schema via the Kysely Migrator (the same
 * migration files the production CLI applies under
 * `pnpm migrate up`).
 *
 * Originally introduced as smoke tests under openfga-6tv (after the
 * openfga-8ys hang investigation). Promoted to migrator-backed unit
 * tests under openfga-yg9.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { getDb, resetDb } from '../../src/storage/db'
import {
  applyTupleMutations,
  DuplicateTupleError,
  listAllForRelation,
  listChangesPage,
  listObjectIdsForUser,
  listUsersForRelation,
  MissingTupleError,
  readTuplesPage,
  writeTuples,
} from '../../src/storage/tuples'
import {
  claimKey,
  completeKey,
  releaseKey,
} from '../../src/storage/idempotency'
import { migrateToLatest } from '../_helpers/sqlite-bootstrap'

const ENV_KEYS = ['OPENFGA_DB_URL', 'OPENFGA_DB_NAMESPACE'] as const
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

async function makeStore(id = 's1'): Promise<string> {
  await sql`insert into openfga_store (id, name) values (${id}, ${id})`.execute(getDb())
  return id
}

beforeEach(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  await resetDb()
  delete process.env['OPENFGA_DB_NAMESPACE']
  await migrateToLatest()
})

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  await resetDb()
})

describe('tuples (Kysely port)', () => {
  it('writes a tuple and records a changelog entry transactionally', async () => {
    const storeId = await makeStore()
    await writeTuples(storeId, [
      { user: 'user:alice', relation: 'viewer', object: 'doc:1' },
    ])
    const tuples = await getDb().selectFrom('tuple').selectAll().where('store_id', '=', storeId).execute()
    expect(tuples).toHaveLength(1)
    const changes = await getDb().selectFrom('tuple_change').selectAll().where('store_id', '=', storeId).execute()
    expect(changes).toHaveLength(1)
    expect(changes[0]?.operation).toBe('TUPLE_OPERATION_WRITE')
  })

  it('skips changelog when ON CONFLICT DO NOTHING ignores a duplicate', async () => {
    const storeId = await makeStore()
    const t = { user: 'user:alice', relation: 'viewer', object: 'doc:1' }
    await writeTuples(storeId, [t])
    await writeTuples(storeId, [t])
    const tuples = await getDb().selectFrom('tuple').selectAll().where('store_id', '=', storeId).execute()
    const changes = await getDb().selectFrom('tuple_change').selectAll().where('store_id', '=', storeId).execute()
    expect(tuples).toHaveLength(1)
    expect(changes).toHaveLength(1)
  })

  it('throws DuplicateTupleError when onDuplicate=error and tuple already exists', async () => {
    const storeId = await makeStore()
    const t = { user: 'user:alice', relation: 'viewer', object: 'doc:1' }
    await writeTuples(storeId, [t])
    await expect(applyTupleMutations(storeId, {
      writes: [t], deletes: [], onDuplicate: 'error', onMissing: 'ignore',
    })).rejects.toThrow(DuplicateTupleError)
  })

  it('throws MissingTupleError when onMissing=error and tuple does not exist', async () => {
    const storeId = await makeStore()
    await expect(applyTupleMutations(storeId, {
      writes: [],
      deletes: [{ user: 'user:bob', relation: 'viewer', object: 'doc:1' }],
      onDuplicate: 'ignore', onMissing: 'error',
    })).rejects.toThrow(MissingTupleError)
  })

  it('rolls back the entire transaction when one operation fails', async () => {
    const storeId = await makeStore()
    const ok = { user: 'user:a', relation: 'viewer', object: 'doc:1' }
    const dupe = { user: 'user:b', relation: 'viewer', object: 'doc:2' }
    await writeTuples(storeId, [dupe])
    await expect(applyTupleMutations(storeId, {
      writes: [ok, dupe], deletes: [], onDuplicate: 'error', onMissing: 'ignore',
    })).rejects.toThrow(DuplicateTupleError)
    const tuples = await getDb().selectFrom('tuple').select('user_str').where('store_id', '=', storeId).execute()
    expect(tuples.map(r => r.user_str)).toEqual(['user:b'])
    const changes = await getDb().selectFrom('tuple_change').selectAll().where('store_id', '=', storeId).execute()
    expect(changes).toHaveLength(1)
    expect(changes[0]?.user_str).toBe('user:b')
  })

  describe('evaluator helpers', () => {
    it('listUsersForRelation returns user_strs for (object, relation)', async () => {
      const storeId = await makeStore()
      await writeTuples(storeId, [
        { user: 'user:alice', relation: 'viewer', object: 'doc:1' },
        { user: 'user:bob', relation: 'viewer', object: 'doc:1' },
        { user: 'user:carol', relation: 'editor', object: 'doc:1' },
      ])
      const users = await listUsersForRelation(storeId, 'doc', '1', 'viewer')
      expect(users.sort()).toEqual(['user:alice', 'user:bob'])
    })

    it('listObjectIdsForUser returns DISTINCT object_ids', async () => {
      const storeId = await makeStore()
      await writeTuples(storeId, [
        { user: 'user:alice', relation: 'viewer', object: 'doc:1' },
        { user: 'user:alice', relation: 'viewer', object: 'doc:2' },
        { user: 'user:bob', relation: 'viewer', object: 'doc:3' },
      ])
      const ids = await listObjectIdsForUser(storeId, 'doc', 'viewer', 'user:alice')
      expect(ids.sort()).toEqual(['1', '2'])
    })

    it('listAllForRelation returns (object_id, user_str) pairs', async () => {
      const storeId = await makeStore()
      await writeTuples(storeId, [
        { user: 'user:alice', relation: 'viewer', object: 'doc:1' },
        { user: 'user:bob', relation: 'viewer', object: 'doc:2' },
      ])
      const pairs = await listAllForRelation(storeId, 'doc', 'viewer')
      expect(pairs.map(p => `${p.object_id}/${p.user_str}`).sort())
        .toEqual(['1/user:alice', '2/user:bob'])
    })
  })

  it('readTuplesPage cursor-walks ASC to terminal page', async () => {
    const storeId = await makeStore()
    const tuples = Array.from({ length: 5 }, (_, i) => ({
      user: `user:u${i}`, relation: 'viewer', object: `doc:${i}`,
    }))
    for (const t of tuples) {
      await writeTuples(storeId, [t])
    }
    const seen: string[] = []
    let cursor: Awaited<ReturnType<typeof readTuplesPage>>['nextCursor'] = null
    let safety = 50
    while (safety-- > 0) {
      const page = await readTuplesPage(storeId, { pageSize: 2 }, cursor)
      seen.push(...page.rows.map(r => `${r.object_type}:${r.object_id}#${r.user_str}`))
      if (page.nextCursor === null) break
      cursor = page.nextCursor
    }
    expect(safety).toBeGreaterThan(0)
    expect(seen).toHaveLength(5)
    expect(new Set(seen).size).toBe(5)
  })

  it('listChangesPage emits seq as a string and walks the cursor in insertion order', async () => {
    const storeId = await makeStore()
    await applyTupleMutations(storeId, {
      writes: [
        { user: 'user:a', relation: 'viewer', object: 'doc:1' },
        { user: 'user:b', relation: 'viewer', object: 'doc:2' },
        { user: 'user:c', relation: 'viewer', object: 'doc:3' },
      ],
      deletes: [], onDuplicate: 'ignore', onMissing: 'ignore',
    })
    const seen: string[] = []
    const seqs: string[] = []
    let cursor: { inserted_at: string, seq: string } | null = null
    let safety = 20
    while (safety-- > 0) {
      const page = await listChangesPage(storeId, 1, cursor)
      for (const r of page.rows) {
        seen.push(`${r.object_id}:${r.user_str}`)
        expect(typeof r.seq).toBe('string')
        seqs.push(r.seq)
      }
      if (page.nextCursor === null) break
      cursor = page.nextCursor
    }
    expect(safety).toBeGreaterThan(0)
    expect(seen).toEqual(['1:user:a', '2:user:b', '3:user:c'])
    expect(new Set(seqs).size).toBe(3)
  })
})

describe('idempotency (Kysely port)', () => {
  const KEY = 'idem-key-1'
  const FP = 'fingerprint-A'
  const TTL = 60_000

  async function claimToken(key = KEY, fp = FP, opts?: { inFlightLeaseMs?: number }): Promise<number> {
    const result = await claimKey(key, fp, TTL, opts)
    if (result.kind !== 'claimed') throw new Error(`expected claimed, got ${result.kind}`)
    return result.token
  }

  it('claimKey returns claimed with a claim token for a fresh key', async () => {
    const result = await claimKey(KEY, FP, TTL)
    expect(result.kind).toBe('claimed')
    if (result.kind === 'claimed') expect(typeof result.token).toBe('number')
  })

  it('claimKey returns in_flight when an earlier claim is still in flight', async () => {
    await claimToken()
    expect(await claimKey(KEY, FP, TTL)).toEqual({ kind: 'in_flight' })
  })

  it('claimKey returns mismatch when the same key is reclaimed with a different fingerprint', async () => {
    await claimToken()
    expect(await claimKey(KEY, 'different-fp', TTL)).toEqual({ kind: 'mismatch' })
  })

  it('claimKey returns replay after completeKey', async () => {
    const token = await claimToken()
    expect(await completeKey(KEY, token, 200, { ok: true })).toBe(true)
    const result = await claimKey(KEY, FP, TTL)
    expect(result.kind).toBe('replay')
    if (result.kind === 'replay') {
      expect(result.status).toBe(200)
      expect(result.body).toEqual({ ok: true })
    }
  })

  it('releaseKey removes an in-flight slot so a retry can claim again', async () => {
    const token = await claimToken()
    expect(await releaseKey(KEY, token)).toBe(true)
    expect((await claimKey(KEY, FP, TTL)).kind).toBe('claimed')
  })

  it('TTL cutoff is computed in SQL — expired rows are deleted before claim', async () => {
    const token = await claimToken()
    await completeKey(KEY, token, 200, { ok: true })
    await sql`update openfga_idempotency_keys set created_at = '2000-01-01T00:00:00.000Z' where key = ${KEY}`.execute(getDb())
    expect((await claimKey(KEY, 'different-fp', TTL)).kind).toBe('claimed')
  })

  it('completeKey serializes JSON response bodies for read-back via replay', async () => {
    const token = await claimToken()
    const body = { stores: [{ id: 's1', name: 'first' }], next: 'cursor-abc' }
    await completeKey(KEY, token, 201, body)
    const result = await claimKey(KEY, FP, TTL)
    expect(result.kind).toBe('replay')
    if (result.kind === 'replay') {
      expect(result.body).toEqual(body)
    }
  })

  // openfga-k2a.3 — in-flight lease and claim ownership.
  it('an in-flight row older than the default lease is reclaimable within the TTL', async () => {
    await claimToken()
    // Age the abandoned in-flight row past the lease (minutes) but
    // keep it inside a 24h TTL.
    await sql`update openfga_idempotency_keys set created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hours') where key = ${KEY}`.execute(getDb())
    const result = await claimKey(KEY, FP, 86_400_000)
    expect(result.kind).toBe('claimed')
  })

  it('an in-flight row younger than the default lease still returns in_flight', async () => {
    await claimToken()
    await sql`update openfga_idempotency_keys set created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 seconds') where key = ${KEY}`.execute(getDb())
    expect(await claimKey(KEY, FP, 86_400_000)).toEqual({ kind: 'in_flight' })
  })

  it('a stale owner cannot complete over or release the new owner\'s claim', async () => {
    const stale = await claimToken()
    const current = await claimToken(KEY, FP, { inFlightLeaseMs: 0 })
    expect(current).not.toBe(stale)

    expect(await completeKey(KEY, stale, 200, { from: 'stale' })).toBe(false)
    expect(await releaseKey(KEY, stale)).toBe(false)
    expect(await claimKey(KEY, FP, TTL)).toEqual({ kind: 'in_flight' })

    expect(await completeKey(KEY, current, 200, { from: 'current' })).toBe(true)
    expect(await claimKey(KEY, FP, TTL)).toEqual({ kind: 'replay', status: 200, body: { from: 'current' } })
  })
})
