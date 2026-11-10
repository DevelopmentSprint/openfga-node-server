/**
 * Durable write fences (optional extension, docs/features/write-fences.md).
 *
 * A fence is one row per (store, key) holding the latest acquired
 * generation and its lease expiry. Fenced tuple writes lock and
 * validate the row inside the SAME transaction as their tuple and
 * changelog mutations; acquisition of a newer generation locks the
 * same row, so it waits for every older in-flight fenced write and,
 * once it commits, no older generation can commit a mutation.
 *
 * Lock order (shared with tuple writes, see ./store-mutation.ts):
 * Postgres per-store advisory lock, store row, fence row.
 *
 * Generations are canonical positive decimal strings up to
 * 9223372036854775807, stored as text so both engines preserve them
 * exactly; ordering is always computed numerically with BigInt, never
 * by text comparison.
 *
 * Wall-clock deadlines are admission and cooperative-cancellation
 * guards only. They cannot prove a commit cutoff: a pause between the
 * last check and COMMIT can still produce a late commit. Ordering
 * safety comes from the generation fence alone.
 */
import type { Transaction } from 'kysely'
import { getDb } from './db'
import type { Database } from './db-schema'
import { inStoreMutationTransaction, lockStoreForMutation, retryOnTransactionConflict } from './store-mutation'

export interface WriteDeadline {
  /** Absolute deadline, epoch milliseconds. */
  notAfter: number
  /** Clock override for tests. */
  now?: () => number
}

export interface WriteFence {
  key: string
  generation: string
}

export interface AcquiredWriteFence {
  key: string
  generation: string
  not_after: string
}

export type WriteFenceErrorCode = 'write_deadline_exceeded' | 'write_fence_rejected'

export class WriteFenceError extends Error {
  constructor(public readonly code: WriteFenceErrorCode) {
    super(code === 'write_deadline_exceeded' ? 'the write deadline has passed' : 'the write fence generation is not current')
    this.name = 'WriteFenceError'
  }
}

/** Placeholder generation of a row inserted by an acquisition attempt. Never valid on the wire. */
const UNACQUIRED_GENERATION = '0'

export function assertWriteDeadline(deadline?: WriteDeadline): void {
  if (deadline && (!Number.isFinite(deadline.notAfter) || (deadline.now ?? Date.now)() >= deadline.notAfter)) {
    throw new WriteFenceError('write_deadline_exceeded')
  }
}

/** Numeric comparison of two canonical decimal generations. */
export function compareGenerations(a: string, b: string): number {
  const x = BigInt(a)
  const y = BigInt(b)
  return x < y ? -1 : x > y ? 1 : 0
}

/**
 * Lock the fence row for the rest of the transaction. The no-op UPDATE
 * takes the Postgres row lock (waiting for any holder) and SQLite's
 * database write lock before the row is read. If it matched no row, the
 * transaction holds no lock on a fence that may be inserted
 * concurrently, so the caller must not read and accept that row later:
 * the affected-row-count check is what closes that race.
 */
async function lockFenceRow(trx: Transaction<Database>, storeId: string, key: string): Promise<boolean> {
  const result = await trx.updateTable('write_fence')
    .set(eb => ({ generation: eb.ref('generation') }))
    .where('store_id', '=', storeId)
    .where('key', '=', key)
    .executeTakeFirst()
  return result.numUpdatedRows === 1n
}

async function readFenceRow(db: Pick<Transaction<Database>, 'selectFrom'>, storeId: string, key: string) {
  return db.selectFrom('write_fence').select(['generation', 'not_after'])
    .where('store_id', '=', storeId).where('key', '=', key)
    .executeTakeFirst()
}

/** Effective deadline: the caller's deadline capped by the stored lease expiry. */
function capDeadline(deadline: WriteDeadline, storedNotAfter: string): WriteDeadline {
  return { ...deadline, notAfter: Math.min(deadline.notAfter, Date.parse(storedNotAfter)) }
}

/**
 * Acquire (or idempotently re-acquire) `fence.generation` for
 * `(storeId, fence.key)` with lease expiry `notAfter` (RFC 3339).
 *
 * - lower generation than stored: write_fence_rejected
 * - same generation, same expiry: success, no change
 * - same generation, different expiry: write_fence_rejected
 * - higher generation: stored generation and expiry advance
 * - expiry already passed (before or after lock wait): write_deadline_exceeded
 */
export async function acquireWriteFence(
  storeId: string,
  fence: WriteFence,
  notAfter: string,
  now: () => number = Date.now,
): Promise<AcquiredWriteFence> {
  const deadline: WriteDeadline = { notAfter: Date.parse(notAfter), now }
  const normalized = new Date(deadline.notAfter).toISOString()
  return retryOnTransactionConflict(async () => {
    assertWriteDeadline(deadline)
    return inStoreMutationTransaction(async (trx) => {
      await lockStoreForMutation(trx, storeId)
      await trx.insertInto('write_fence')
        .values({ store_id: storeId, key: fence.key, generation: UNACQUIRED_GENERATION, not_after: new Date(0).toISOString() })
        .onConflict(oc => oc.columns(['store_id', 'key']).doNothing())
        .execute()
      // Waits here for any older fenced write still holding the row.
      if (!(await lockFenceRow(trx, storeId, fence.key))) throw new WriteFenceError('write_fence_rejected')
      assertWriteDeadline(deadline)
      const current = (await readFenceRow(trx, storeId, fence.key))!
      const order = compareGenerations(current.generation, fence.generation)
      if (order > 0 || (order === 0 && current.not_after !== normalized)) {
        throw new WriteFenceError('write_fence_rejected')
      }
      if (order < 0) {
        await trx.updateTable('write_fence')
          .set({ generation: fence.generation, not_after: normalized })
          .where('store_id', '=', storeId).where('key', '=', fence.key)
          .execute()
      }
      return { key: fence.key, generation: fence.generation, not_after: normalized }
    })
  })
}

/**
 * Lock and validate `fence` inside a tuple-mutation transaction. Must
 * run after `lockStoreForMutation` (lock order). Returns the effective
 * deadline (caller's deadline capped by the stored lease expiry) after
 * checking it.
 */
export async function lockWriteFence(
  trx: Transaction<Database>,
  storeId: string,
  fence: WriteFence,
  deadline: WriteDeadline,
): Promise<WriteDeadline> {
  assertWriteDeadline(deadline)
  if (!(await lockFenceRow(trx, storeId, fence.key))) throw new WriteFenceError('write_fence_rejected')
  const current = await readFenceRow(trx, storeId, fence.key)
  if (!current || current.generation !== fence.generation) throw new WriteFenceError('write_fence_rejected')
  const effective = capDeadline(deadline, current.not_after)
  assertWriteDeadline(effective)
  return effective
}

/**
 * Lock-free pre-check used before idempotent replay: rejects an
 * expired deadline or a generation that is not current. It never
 * authorizes a mutation by itself; the mutation transaction validates
 * the fence again under its lock.
 */
export async function precheckWriteFence(storeId: string, fence: WriteFence | undefined, deadline: WriteDeadline | undefined): Promise<void> {
  assertWriteDeadline(deadline)
  if (!fence || !deadline) return
  const current = await readFenceRow(getDb(), storeId, fence.key)
  if (!current || current.generation !== fence.generation) throw new WriteFenceError('write_fence_rejected')
  assertWriteDeadline(capDeadline(deadline, current.not_after))
}
