/**
 * Concurrency semantics of the tuple write transaction (openfga-k2a.4).
 *
 * - ReadChanges must never permanently skip a change. A poller that
 *   advances its (inserted_at, seq) cursor past a committed change
 *   must still observe every change that commits afterwards. On
 *   Postgres this requires changelog rows of one store to become
 *   visible in cursor order, which the write path guarantees by
 *   serializing mutation transactions per store and stamping
 *   changelog rows after the serialization point.
 * - Overlapping writes issued in opposite orders must not deadlock.
 * - A write that races (or follows) store deletion fails with
 *   StoreNotFoundError instead of inserting into a deleted store.
 *
 * The race scenarios need real concurrent connections, so they run
 * only in the `integration-pg` project; the deterministic cases run on
 * both dialects.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { getDb } from '../../src/storage/db'
import { createStore, deleteStore } from '../../src/storage/stores'
import {
  DuplicateTupleError,
  MissingTupleError,
  StoreNotFoundError,
  applyTupleMutations,
  listChangesPage,
  writeTuples,
  type TupleChangeRow,
} from '../../src/storage/tuples'
import { bootstrapIntegrationDb } from '../_helpers/integration-bootstrap'

const bootstrap = await bootstrapIntegrationDb()

afterAll(async () => {
  await bootstrap.teardown()
})

const describeIfDb = bootstrap.ready ? describe : describe.skip
const describeIfPg = bootstrap.ready && bootstrap.dialect === 'postgres' ? describe : describe.skip

class Rollback extends Error {}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Count lock requests currently waiting in the database. */
async function waitingLockCount(): Promise<number> {
  const result = await sql<{ n: number }>`select count(*)::int as n from pg_locks where not granted`.execute(getDb())
  return result.rows[0]?.n ?? 0
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(20)
  }
  throw new Error('condition not reached before timeout')
}

/**
 * Open a transaction that inserts `tuple` without committing, so any
 * other transaction that writes the same key blocks on the unique
 * index until `release()` rolls this one back.
 */
function holdTupleKey(storeId: string, tuple: { object: string, relation: string, user: string }) {
  let release!: () => void
  const released = new Promise<void>((resolve) => { release = resolve })
  let ready!: () => void
  const held = new Promise<void>((resolve) => { ready = resolve })
  const [type, id] = tuple.object.split(':') as [string, string]
  const done = getDb().transaction().execute(async (trx) => {
    await trx.insertInto('tuple').values({
      store_id: storeId,
      object_type: type,
      object_id: id,
      relation: tuple.relation,
      user_str: tuple.user,
    }).execute()
    ready()
    await released
    throw new Rollback()
  }).catch((err: unknown) => {
    if (!(err instanceof Rollback)) throw err
  })
  return { held, release, done }
}

async function readAllChanges(storeId: string, cursor: { inserted_at: string, seq: string } | null) {
  const rows: TupleChangeRow[] = []
  let next = cursor
  for (;;) {
    const page = await listChangesPage(storeId, 100, next)
    rows.push(...page.rows)
    if (page.rows.length > 0) next = { inserted_at: page.rows.at(-1)!.inserted_at, seq: page.rows.at(-1)!.seq }
    if (!page.nextCursor) return { rows, cursor: next }
  }
}

describeIfPg('tuple write concurrency (postgres)', () => {
  it('ReadChanges does not skip a change whose transaction started first but committed last', async () => {
    const store = await createStore(`k2a4-changes-${Date.now()}`)
    const slow = { user: 'user:slow', relation: 'viewer', object: 'doc:1' }
    const fast = { user: 'user:fast', relation: 'viewer', object: 'doc:2' }

    // Block the slow writer mid-transaction on a competing uncommitted
    // insert of the same key.
    const blocker = holdTupleKey(store.id, slow)
    await blocker.held
    const before = await waitingLockCount()
    const slowWrite = applyTupleMutations(store.id, { writes: [slow], deletes: [], onDuplicate: 'error', onMissing: 'error' })
    await waitFor(async () => (await waitingLockCount()) > before)

    // The fast writer starts after the slow one. Give it time to
    // commit if nothing forces it to wait behind the slow writer.
    const fastWrite = applyTupleMutations(store.id, { writes: [fast], deletes: [], onDuplicate: 'error', onMissing: 'error' })
    await Promise.race([fastWrite, delay(1_000)])

    // A tailing poller reads whatever is visible now and keeps its cursor.
    const first = await readAllChanges(store.id, null)

    // Let the slow writer finish, then let everything settle.
    blocker.release()
    await blocker.done
    await Promise.all([slowWrite, fastWrite])

    // Resuming from the saved cursor must surface every change that
    // was not already delivered.
    const second = await readAllChanges(store.id, first.cursor)
    const seen = [...first.rows, ...second.rows].map(r => r.user_str)
    expect(seen.sort()).toEqual(['user:fast', 'user:slow'])

    // And the full log is in strictly increasing cursor order.
    const all = (await readAllChanges(store.id, null)).rows
    for (let i = 1; i < all.length; i++) {
      const prev = all[i - 1]!
      const cur = all[i]!
      expect(Date.parse(cur.inserted_at) >= Date.parse(prev.inserted_at)).toBe(true)
      expect(BigInt(cur.seq) > BigInt(prev.seq)).toBe(true)
    }
  })

  it('overlapping writes in opposite orders do not deadlock', async () => {
    const store = await createStore(`k2a4-deadlock-${Date.now()}`)
    const keys = Array.from({ length: 8 }, (_, i) => ({ user: `user:u${i}`, relation: 'viewer', object: `doc:${i}` }))
    const reversed = [...keys].reverse()
    const rounds = 10
    for (let r = 0; r < rounds; r++) {
      const results = await Promise.allSettled([
        applyTupleMutations(store.id, { writes: keys, deletes: [], onDuplicate: 'ignore', onMissing: 'ignore' }),
        applyTupleMutations(store.id, { writes: reversed, deletes: [], onDuplicate: 'ignore', onMissing: 'ignore' }),
        applyTupleMutations(store.id, { writes: [], deletes: keys, onDuplicate: 'ignore', onMissing: 'ignore' }),
        applyTupleMutations(store.id, { writes: [], deletes: reversed, onDuplicate: 'ignore', onMissing: 'ignore' }),
      ])
      for (const res of results) {
        expect(res.status, res.status === 'rejected' ? String(res.reason) : '').toBe('fulfilled')
      }
    }
  })

  it('a write racing deleteStore fails with StoreNotFoundError and inserts nothing', async () => {
    const store = await createStore(`k2a4-delete-race-${Date.now()}`)
    // Hold the store row locked by an uncommitted soft delete.
    let release!: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    let ready!: () => void
    const held = new Promise<void>((resolve) => { ready = resolve })
    const deleting = getDb().transaction().execute(async (trx) => {
      await trx.updateTable('store').set({ deleted_at: new Date().toISOString() }).where('id', '=', store.id).execute()
      ready()
      await released
    })
    await held
    const before = await waitingLockCount()
    const write = applyTupleMutations(store.id, {
      writes: [{ user: 'user:late', relation: 'viewer', object: 'doc:1' }],
      deletes: [],
      onDuplicate: 'error',
      onMissing: 'error',
    })
    const outcome = write.then(() => 'committed', (err: unknown) => err)
    await waitFor(async () => (await waitingLockCount()) > before)
    release()
    await deleting

    expect(await outcome).toBeInstanceOf(StoreNotFoundError)
    const tuples = await getDb().selectFrom('tuple').select('user_str').where('store_id', '=', store.id).execute()
    expect(tuples).toEqual([])
    expect((await readAllChanges(store.id, null)).rows).toEqual([])
  })
})

describeIfDb('tuple write transaction semantics', () => {
  it('rejects writes to a deleted store with StoreNotFoundError', async () => {
    const store = await createStore(`k2a4-deleted-${Date.now()}`)
    await deleteStore(store.id)
    await expect(writeTuples(store.id, [{ user: 'user:a', relation: 'viewer', object: 'doc:1' }]))
      .rejects.toBeInstanceOf(StoreNotFoundError)
  })

  it('rejects writes to an unknown store with StoreNotFoundError', async () => {
    await expect(writeTuples('01ZZZZZZZZZZZZZZZZZZZZZZZZ', [{ user: 'user:a', relation: 'viewer', object: 'doc:1' }]))
      .rejects.toBeInstanceOf(StoreNotFoundError)
  })

  it('reports the first duplicate in request order regardless of internal ordering', async () => {
    const store = await createStore(`k2a4-dup-${Date.now()}`)
    const z = { user: 'user:z', relation: 'viewer', object: 'doc:z' }
    const a = { user: 'user:a', relation: 'viewer', object: 'doc:a' }
    await writeTuples(store.id, [z, a])
    const err = await applyTupleMutations(store.id, {
      writes: [{ user: 'user:new', relation: 'viewer', object: 'doc:m' }, z, a],
      deletes: [],
      onDuplicate: 'error',
      onMissing: 'error',
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DuplicateTupleError)
    expect((err as DuplicateTupleError).tuple).toEqual(z)
    // The failed transaction changed nothing.
    const rows = await getDb().selectFrom('tuple').select('user_str').where('store_id', '=', store.id).execute()
    expect(rows.map(r => r.user_str).sort()).toEqual(['user:a', 'user:z'])
  })

  it('reports the first missing delete in request order', async () => {
    const store = await createStore(`k2a4-missing-${Date.now()}`)
    const present = { user: 'user:p', relation: 'viewer', object: 'doc:p' }
    await writeTuples(store.id, [present])
    const missingZ = { user: 'user:z', relation: 'viewer', object: 'doc:z' }
    const missingA = { user: 'user:a', relation: 'viewer', object: 'doc:a' }
    const err = await applyTupleMutations(store.id, {
      writes: [],
      deletes: [present, missingZ, missingA],
      onDuplicate: 'error',
      onMissing: 'error',
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MissingTupleError)
    expect((err as MissingTupleError).tuple).toEqual(missingZ)
    const rows = await getDb().selectFrom('tuple').select('user_str').where('store_id', '=', store.id).execute()
    expect(rows.map(r => r.user_str)).toEqual(['user:p'])
  })

  it('records changelog entries in request order even though mutations apply in key order', async () => {
    const store = await createStore(`k2a4-order-${Date.now()}`)
    const writes = ['user:c', 'user:a', 'user:b'].map(user => ({ user, relation: 'viewer', object: 'doc:1' }))
    await applyTupleMutations(store.id, {
      writes,
      deletes: [{ user: 'user:a', relation: 'viewer', object: 'doc:1' }],
      onDuplicate: 'error',
      onMissing: 'error',
    })
    const rows = (await readAllChanges(store.id, null)).rows
    expect(rows.map(r => `${r.operation}:${r.user_str}`)).toEqual([
      'TUPLE_OPERATION_WRITE:user:c',
      'TUPLE_OPERATION_WRITE:user:a',
      'TUPLE_OPERATION_WRITE:user:b',
      'TUPLE_OPERATION_DELETE:user:a',
    ])
  })
})
