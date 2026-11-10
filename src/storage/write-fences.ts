import type { Transaction } from 'kysely'
import { getDb } from './db'
import type { Database } from './db-schema'

export interface WriteDeadline {
  notAfter: number
  now?: () => number
}
export interface WriteFence {
  key: string
  generation: string
}
export class WriteFenceError extends Error {
  constructor(public readonly code: 'write_deadline_exceeded' | 'write_fence_rejected') {
    super(code === 'write_deadline_exceeded' ? 'The write deadline has expired' : 'The write fence is no longer current')
  }
}
export function assertWriteDeadline(deadline?: WriteDeadline): void {
  if (deadline && (!Number.isFinite(deadline.notAfter) || (deadline.now ?? Date.now)() >= deadline.notAfter)) {
    throw new WriteFenceError('write_deadline_exceeded')
  }
}
async function lock(trx: Transaction<Database>, storeId: string, key: string): Promise<void> {
  // UPDATE locks the row until COMMIT on PostgreSQL and acquires SQLite's
  // write lock before reading it. No in-memory mutex or clock proves takeover.
  const locked = await trx.updateTable('write_fence').set(eb => ({ generation: eb.ref('generation') }))
    .where('store_id', '=', storeId).where('key', '=', key).executeTakeFirst()
  // A missing row can appear before the following SELECT. It must never be
  // accepted without having been locked by this transaction.
  if (locked.numUpdatedRows !== 1n) throw new WriteFenceError('write_fence_rejected')
}
export async function acquireWriteFence(storeId: string, fence: WriteFence, notAfter: string, now: () => number = Date.now) {
  const deadline = { notAfter: Date.parse(notAfter), now }
  assertWriteDeadline(deadline)
  return getDb().transaction().execute(async (trx) => {
    await trx.insertInto('write_fence').values({ store_id: storeId, key: fence.key, generation: '0', not_after: new Date(0).toISOString() })
      .onConflict(conflict => conflict.columns(['store_id', 'key']).doNothing()).execute()
    await lock(trx, storeId, fence.key)
    assertWriteDeadline(deadline)
    const current = await trx.selectFrom('write_fence').selectAll().where('store_id', '=', storeId).where('key', '=', fence.key).executeTakeFirstOrThrow()
    const normalized = new Date(deadline.notAfter).toISOString()
    if (BigInt(current.generation) > BigInt(fence.generation)
      || (current.generation === fence.generation && current.not_after !== normalized)) throw new WriteFenceError('write_fence_rejected')
    if (current.generation !== fence.generation) {
      await trx.updateTable('write_fence').set({ generation: fence.generation, not_after: normalized })
        .where('store_id', '=', storeId).where('key', '=', fence.key).execute()
    }
    assertWriteDeadline(deadline)
    return { key: fence.key, generation: fence.generation, not_after: normalized }
  })
}
/** Hold this fence in the SAME transaction as all tuple and changelog mutations. */
export async function lockWriteFence(trx: Transaction<Database>, storeId: string, fence: WriteFence, deadline: WriteDeadline): Promise<WriteDeadline> {
  assertWriteDeadline(deadline)
  await lock(trx, storeId, fence.key)
  const current = await trx.selectFrom('write_fence').selectAll().where('store_id', '=', storeId).where('key', '=', fence.key).executeTakeFirst()
  if (!current || current.generation !== fence.generation) throw new WriteFenceError('write_fence_rejected')
  const effective = { ...deadline, notAfter: Math.min(deadline.notAfter, Date.parse(current.not_after)) }
  assertWriteDeadline(effective)
  return effective
}
