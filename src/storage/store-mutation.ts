/**
 * Shared transaction scaffolding for every per-store mutation that must
 * serialize with tuple writes: the tuple write path itself
 * (`./tuples.ts`) and write-fence acquisition (`./write-fences.ts`).
 *
 * Both take their locks in the same global order, so neither can
 * deadlock against the other:
 *
 *   1. Postgres: the per-store transaction-scoped advisory lock.
 *   2. The store row (share lock on Postgres), re-verifying liveness.
 *   3. Optional write-fence row (`./write-fences.ts`).
 *   4. Tuple rows / changelog rows (tuple writes only).
 *
 * SQLite has a single database write lock; the first write statement of
 * a transaction acquires it, and in-process transactions are already
 * serialized by Kysely's connection mutex.
 */
import { sql, type Transaction } from 'kysely'
import { getDb, getDialect, getNamespace } from './db'
import type { Database } from './db-schema'
import { isPostgres } from './dialect'

export class StoreNotFoundError extends Error {
  constructor(readonly storeId: string) {
    super(`store ${storeId} not found`)
    this.name = 'StoreNotFoundError'
  }
}

/**
 * Postgres SQLSTATEs for which the whole mutation transaction is
 * safely retryable: `40P01` deadlock_detected and `40001`
 * serialization_failure. The transaction rolled back, so re-running
 * it from the start cannot double-apply anything.
 */
const RETRYABLE_SQLSTATES = new Set(['40P01', '40001'])
export const MAX_WRITE_ATTEMPTS = 3

function isRetryableTransactionError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' && RETRYABLE_SQLSTATES.has(code)
}

/**
 * Run `attempt` up to `maxAttempts` times, retrying only on a
 * deadlock or serialization failure. Any other error (including the
 * domain errors thrown for duplicates, missing tuples, deleted stores
 * and write fences) propagates immediately.
 */
export async function retryOnTransactionConflict<T>(
  attempt: () => Promise<T>,
  maxAttempts: number = MAX_WRITE_ATTEMPTS,
  backoffMs: (attemptNumber: number) => number = n => n * (5 + Math.random() * 20),
): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await attempt()
    }
    catch (err) {
      if (n >= maxAttempts || !isRetryableTransactionError(err)) throw err
      await new Promise(resolve => setTimeout(resolve, backoffMs(n)))
    }
  }
}

/** Run `fn` in a store-mutation transaction (READ COMMITTED on Postgres). */
export async function inStoreMutationTransaction<T>(fn: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
  const builder = isPostgres(getDialect()) ? getDb().transaction().setIsolationLevel('read committed') : getDb().transaction()
  return builder.execute(fn)
}

/**
 * Steps 1 and 2 of the lock order above. Must be the first statements
 * of the transaction.
 *
 * 1. Postgres: per-store advisory lock. Mutation transactions of one
 *    store are serialized: the next one cannot pass this point until
 *    the previous one has committed or rolled back.
 * 2. Re-verify the store is live, holding a share lock on its row on
 *    Postgres so a concurrent `deleteStore` UPDATE waits for us, or,
 *    if it committed first, we observe `deleted_at` and fail with
 *    StoreNotFoundError.
 */
export async function lockStoreForMutation(trx: Transaction<Database>, storeId: string): Promise<void> {
  const postgres = isPostgres(getDialect())
  if (postgres) {
    await sql`select pg_advisory_xact_lock(hashtext(${`${getNamespace()}.tuple_write`}), hashtext(${storeId}))`.execute(trx)
  }
  const liveStore = trx.selectFrom('store').select('id')
    .where('id', '=', storeId).where('deleted_at', 'is', null)
  if (!(await (postgres ? liveStore.forShare() : liveStore).executeTakeFirst())) {
    throw new StoreNotFoundError(storeId)
  }
}
