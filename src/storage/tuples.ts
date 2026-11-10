/**
 * Repository for `openfga.tuple` rows.
 *
 * Routes through Kysely via `getDb()` (openfga-6tv). The dialect-
 * specific row-tuple cursor casts go through helpers in
 * `./dialect.ts`. The transactional changelog invariant (every
 * successful write/delete records a corresponding `tuple_change`
 * row in the SAME transaction) is preserved via Kysely's
 * `transaction().execute()` block.
 *
 * Object references on the wire have the form `<type>:<id>`. We split
 * them at the boundary so the table schema stays normalized — that way
 * indexes on (object_type, relation, …) are useful for lookup.
 *
 * `user_str` is stored verbatim — it can be a direct user reference
 * (`user:<id>`), a userset reference (`<type>:<id>#<relation>`), or a
 * typed wildcard (`<type>:*`). The evaluator parses it on read.
 */
import { DEFAULT_READ_CONTEXT, type ReadContext } from './read-context'
import { sql, type RawBuilder, type Transaction } from 'kysely'
import type { TupleKey, TupleKeyWithoutCondition } from '@openfga/sdk'
import { getDb, getDialect, getNamespace } from './db'
import type { Database } from './db-schema'
import { dialectBigintParam, dialectTimestampParam, isPostgres } from './dialect'
import { generateId } from './ids'
import { traced } from '../observability/otel'
import { assertWriteDeadline, lockWriteFence, type WriteDeadline, type WriteFence } from './write-fences'

export interface TupleRow {
  condition_name?: string | null
  condition_context?: Record<string, unknown> | null
  store_id: string
  object_type: string
  object_id: string
  relation: string
  user_str: string
  inserted_at: string
}

export interface ObjectRef {
  type: string
  id: string
}

export class InvalidObjectReferenceError extends Error {
  constructor(public readonly value: string) {
    super(`invalid object reference (expected "type:id" or "type:" for type-only filters): "${value}"`)
    this.name = 'InvalidObjectReferenceError'
  }
}

export function parseObject(s: string): ObjectRef {
  const idx = s.indexOf(':')
  if (idx < 0) {
    throw new InvalidObjectReferenceError(s)
  }
  return { type: s.slice(0, idx), id: s.slice(idx + 1) }
}

export interface ReadFilter {
  /** `<type>:<id>` exact match. */
  object?: string
  /** Object type when listing across all ids. Used with optional `relation`. */
  objectType?: string
  relation?: string
  /** Direct or userset user reference. */
  user?: string
  pageSize?: number
}

/**
 * Cursor for /read pagination. The 5-field row-tuple is the smallest
 * stable total order on `openfga.tuple` since the table has no
 * synthetic id column — (object_type, object_id, relation, user_str)
 * is the natural unique key, and `inserted_at` provides the chrono
 * ordering. ASC pagination uses `(inserted_at, ...) > $cursor`.
 */
export interface ReadTupleCursor {
  inserted_at: string
  object_type: string
  object_id: string
  relation: string
  user_str: string
}

export interface ReadTuplesPage {
  rows: TupleRow[]
  /** Cursor for the next page; null when there are no more rows. */
  nextCursor: ReadTupleCursor | null
}

export type TupleConflictMode = 'error' | 'ignore'

export interface TupleMutations {
  deadline?: WriteDeadline
  fence?: WriteFence
  writes: TupleKey[] | TupleKeyWithoutCondition[]
  deletes: TupleKeyWithoutCondition[] | TupleKey[]
  onDuplicate: TupleConflictMode
  onMissing: TupleConflictMode
}

export class DuplicateTupleError extends Error {
  constructor(readonly tuple: TupleKey | TupleKeyWithoutCondition) {
    super(`tuple already exists: ${tuple.user} ${tuple.relation} ${tuple.object}`)
  }
}

export class MissingTupleError extends Error {
  constructor(readonly tuple: TupleKey | TupleKeyWithoutCondition) {
    super(`tuple does not exist: ${tuple.user} ${tuple.relation} ${tuple.object}`)
  }
}

export async function applyTupleMutations(
  storeId: string,
  mutations: TupleMutations,
): Promise<void> {
  return traced(
    'storage',
    'openfga.storage.apply_tuple_mutations',
    () => ({
      'openfga.store_id': storeId,
      'openfga.write_count': mutations.writes.length,
      'openfga.delete_count': mutations.deletes.length,
    }),
    async () => applyTupleMutationsImpl(storeId, mutations),
  )
}

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
 * domain errors thrown for duplicates, missing tuples, and deleted
 * stores) propagates immediately.
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

interface PlannedMutation<T> {
  /** Position in the caller's array; errors and changelog order use it. */
  index: number
  tuple: T
  obj: ObjectRef
}

function plan<T extends { object: string }>(tuples: readonly T[]): PlannedMutation<T>[] {
  return tuples.map((tuple, index) => ({ index, tuple, obj: parseObject(tuple.object) }))
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Stable sort by the tuple's natural key. Every transaction acquires
 * row and unique-index locks in this one global order, so two
 * overlapping mutation sets can never wait on each other in a cycle.
 * Stability keeps repeated keys in request order, so the second copy
 * of a key is still the one reported as the duplicate/missing tuple.
 */
function inKeyOrder<T extends { relation: string, user: string }>(items: PlannedMutation<T>[]): PlannedMutation<T>[] {
  return [...items].sort((a, b) =>
    compareText(a.obj.type, b.obj.type)
    || compareText(a.obj.id, b.obj.id)
    || compareText(a.tuple.relation, b.tuple.relation)
    || compareText(a.tuple.user, b.tuple.user))
}

async function applyTupleMutationsImpl(
  storeId: string,
  mutations: TupleMutations,
): Promise<void> {
  const writes = plan<TupleKey | TupleKeyWithoutCondition>(mutations.writes)
  const deletes = plan<TupleKey | TupleKeyWithoutCondition>(mutations.deletes)
  assertWriteDeadline(mutations.deadline)
  await retryOnTransactionConflict(() => runMutationTransaction(storeId, mutations, writes, deletes))
}

/**
 * One mutation transaction. Order of operations:
 *
 * 1. Postgres: take the per-store transaction-scoped advisory lock
 *    BEFORE anything else. Mutation transactions of one store are
 *    therefore serialized: the next one cannot pass this point until
 *    the previous one has committed or rolled back (the lock is
 *    released only after commit is visible to new snapshots).
 * 2. Re-verify the store is live, holding a share lock on its row on
 *    Postgres so a concurrent `deleteStore` UPDATE waits for us — or,
 *    if it committed first, we observe `deleted_at` and fail with
 *    StoreNotFoundError instead of writing into a deleted store.
 * 3. Apply tuple mutations in key order (deadlock avoidance), writes
 *    before deletes as before. In `error` mode all mutations of a
 *    phase are attempted and the failure with the lowest request index
 *    is reported, so the reported tuple matches request-order
 *    processing. Failed attempts are side-effect free inside the
 *    transaction (ON CONFLICT DO NOTHING / zero-row DELETE), and the
 *    thrown error rolls everything back.
 * 4. Record changelog rows in request order (writes, then deletes) so
 *    ReadChanges ordering within one request is unchanged. On Postgres
 *    each row is stamped with `changelogTimestamp`, evaluated after the
 *    lock in step 1.
 */
async function runMutationTransaction(
  storeId: string,
  mutations: TupleMutations,
  writes: PlannedMutation<TupleKey | TupleKeyWithoutCondition>[],
  deletes: PlannedMutation<TupleKey | TupleKeyWithoutCondition>[],
): Promise<void> {
  const postgres = isPostgres(getDialect())
  const builder = postgres ? getDb().transaction().setIsolationLevel('read committed') : getDb().transaction()
  await builder.execute(async (trx) => {
    if (postgres) {
      await sql`select pg_advisory_xact_lock(hashtext(${`${getNamespace()}.tuple_write`}), hashtext(${storeId}))`.execute(trx)
    }

    const liveStore = trx.selectFrom('store').select('id')
      .where('id', '=', storeId).where('deleted_at', 'is', null)
    if (!(await (postgres ? liveStore.forShare() : liveStore).executeTakeFirst())) {
      throw new StoreNotFoundError(storeId)
    }

    let deadline = mutations.deadline
    if (mutations.fence) {
      if (!deadline) throw new Error('A fenced write requires a deadline')
      deadline = await lockWriteFence(trx, storeId, mutations.fence, deadline)
    }
    assertWriteDeadline(deadline)

    const insertedWrites = new Set<number>()
    let firstDuplicate: number | null = null
    for (const w of inKeyOrder(writes)) {
      const condition = (w.tuple as TupleKey).condition
      const insertResult = await trx
        .insertInto('tuple')
        .values({
          ...conditionColumns(condition),
          store_id: storeId,
          object_type: w.obj.type,
          object_id: w.obj.id,
          relation: w.tuple.relation,
          user_str: w.tuple.user,
        })
        .onConflict(oc => oc.doNothing())
        .executeTakeFirst()
      if ((insertResult.numInsertedOrUpdatedRows ?? 0n) > 0n) insertedWrites.add(w.index)
      else if (firstDuplicate === null || w.index < firstDuplicate) firstDuplicate = w.index
    }
    if (firstDuplicate !== null && mutations.onDuplicate === 'error') {
      throw new DuplicateTupleError(writes[firstDuplicate]!.tuple)
    }

    const removedDeletes = new Set<number>()
    let firstMissing: number | null = null
    for (const d of inKeyOrder(deletes)) {
      const deleteResult = await trx
        .deleteFrom('tuple')
        .where('store_id', '=', storeId)
        .where('object_type', '=', d.obj.type)
        .where('object_id', '=', d.obj.id)
        .where('relation', '=', d.tuple.relation)
        .where('user_str', '=', d.tuple.user)
        .executeTakeFirst()
      if ((deleteResult.numDeletedRows ?? 0n) > 0n) removedDeletes.add(d.index)
      else if (firstMissing === null || d.index < firstMissing) firstMissing = d.index
    }
    if (firstMissing !== null && mutations.onMissing === 'error') {
      throw new MissingTupleError(deletes[firstMissing]!.tuple)
    }

    // Record each change in the same transaction as the mutation so a
    // crash between the two cannot leave the changelog out of sync
    // with tuple state. Only mutations that changed a row are logged:
    // ignored duplicates and missing deletes are at-most-once no-ops.
    const changes = [
      ...writes.filter(w => insertedWrites.has(w.index)).map(w => ({
        mutation: w,
        operation: 'TUPLE_OPERATION_WRITE' as const,
        ...conditionColumns((w.tuple as TupleKey).condition),
      })),
      ...deletes.filter(d => removedDeletes.has(d.index)).map(d => ({
        mutation: d,
        operation: 'TUPLE_OPERATION_DELETE' as const,
      })),
    ]
    for (const { mutation, ...change } of changes) {
      await trx
        .insertInto('tuple_change')
        .values({
          ...change,
          id: generateId(),
          store_id: storeId,
          object_type: mutation.obj.type,
          object_id: mutation.obj.id,
          relation: mutation.tuple.relation,
          user_str: mutation.tuple.user,
          // SQLite keeps the column default: a single writer commits
          // in statement order already.
          ...(postgres ? { inserted_at: changelogTimestamp(trx, storeId) } : {}),
        })
        .execute()
    }
    assertWriteDeadline(deadline)
  })
}

function conditionColumns(condition: TupleKey['condition']) {
  return {
    condition_name: condition?.name ?? null,
    condition_context: condition?.context ? JSON.stringify(condition.context) : null,
  }
}

/**
 * Postgres changelog timestamp, evaluated per row while the per-store
 * advisory lock is held:
 *
 *   greatest(clock_timestamp(), max(inserted_at of this store) + 1µs)
 *
 * The column default `now()` is the transaction START time, which can
 * precede the commit of transactions that started later; with it a
 * slow writer could commit a row behind a poller's cursor. The
 * statement runs after the lock (READ COMMITTED snapshot per
 * statement), so `max` covers every previously committed row of the
 * store plus this transaction's earlier rows. The result is therefore
 * strictly greater than every visible changelog timestamp of the
 * store, independent of clock resolution or a wall clock stepping
 * backwards. Index-backed by idx_tuple_change_store_inserted_seq.
 */
function changelogTimestamp(trx: Transaction<Database>, storeId: string): RawBuilder<string> {
  const latest = trx.selectFrom('tuple_change')
    .select(sql<string>`max(inserted_at) + interval '1 microsecond'`.as('next'))
    .where('store_id', '=', storeId)
  return sql<string>`greatest(clock_timestamp(), (${latest}))`
}

export async function writeTuples(
  storeId: string,
  tuples: TupleKey[] | TupleKeyWithoutCondition[],
): Promise<void> {
  if (tuples.length === 0) return
  await applyTupleMutations(storeId, {
    writes: tuples,
    deletes: [],
    onDuplicate: 'ignore',
    onMissing: 'ignore',
  })
}

export async function deleteTuples(
  storeId: string,
  tuples: TupleKeyWithoutCondition[] | TupleKey[],
): Promise<void> {
  if (tuples.length === 0) return
  await applyTupleMutations(storeId, {
    writes: [],
    deletes: tuples,
    onDuplicate: 'ignore',
    onMissing: 'ignore',
  })
}

export async function readTuples(
  storeId: string,
  filter: ReadFilter,
): Promise<TupleRow[]> {
  // Backwards-compatible non-paginated wrapper. New callers that need
  // continuation tokens should use readTuplesPage directly.
  const page = await readTuplesPage(storeId, filter, null)
  return page.rows
}

const TUPLE_COLUMNS = ['store_id', 'object_type', 'object_id', 'relation', 'user_str', 'inserted_at', 'condition_name', 'condition_context'] as const

/**
 * Cursor-paginated read of tuples for a store. Same filter surface as
 * readTuples plus an optional `cursor` arg; returns a page of rows
 * plus a next-cursor (null when exhausted). The +1 fetch trick lets
 * us decide "is there a next page" without a separate COUNT query.
 *
 * Ordering is ASC by (inserted_at, object_type, object_id, relation,
 * user_str). The natural unique key (the latter four fields)
 * provides total order so pagination is stable under inserts at the
 * head of the timeline.
 */
export async function readTuplesPage(
  storeId: string,
  filter: ReadFilter,
  cursor: ReadTupleCursor | null,
  _readContext: ReadContext = DEFAULT_READ_CONTEXT,
): Promise<ReadTuplesPage> {
  return traced(
    'storage',
    'openfga.storage.read_tuples',
    () => ({
      'openfga.store_id': storeId,
      'openfga.page_size': filter.pageSize ?? 0,
    }),
    async (span) => {
      const result = await readTuplesPageImpl(storeId, filter, cursor)
      span.setAttribute('openfga.result_count', result.rows.length)
      return result
    },
  )
}

async function readTuplesPageImpl(
  storeId: string,
  filter: ReadFilter,
  cursor: ReadTupleCursor | null,
): Promise<ReadTuplesPage> {
  let query = getDb()
    .selectFrom('tuple')
    .select(TUPLE_COLUMNS)
    .where('store_id', '=', storeId)

  if (filter.object) {
    const obj = parseObject(filter.object)
    query = query.where('object_type', '=', obj.type)
    // OpenFGA wire format admits type-only filters of the form
    // "type:" — distinguish those from full references "type:id" and
    // skip the object_id predicate so the query returns every tuple
    // for the requested type. Adding `object_id = ''` would silently
    // return zero rows.
    if (obj.id !== '') {
      query = query.where('object_id', '=', obj.id)
    }
  }
  else if (filter.objectType) {
    query = query.where('object_type', '=', filter.objectType)
  }
  if (filter.relation) {
    query = query.where('relation', '=', filter.relation)
  }
  if (filter.user) {
    query = query.where('user_str', '=', filter.user)
  }

  if (cursor) {
    // 5-field row-tuple comparison gives a stable total order on the
    // page boundary. Postgres compares row tuples lexicographically.
    // Only the leading timestamp parameter needs an explicit dialect
    // cast — the trailing four are text both sides, which Postgres
    // resolves from the column types.
    const ts = dialectTimestampParam(getDialect(), cursor.inserted_at)
    query = query.where(sql<boolean>`(inserted_at, object_type, object_id, relation, user_str) > (${ts}, ${cursor.object_type}, ${cursor.object_id}, ${cursor.relation}, ${cursor.user_str})`)
  }

  const pageSize = filter.pageSize ?? 100
  const rows = await query
    .orderBy('inserted_at', 'asc')
    .orderBy('object_type', 'asc')
    .orderBy('object_id', 'asc')
    .orderBy('relation', 'asc')
    .orderBy('user_str', 'asc')
    .limit(pageSize + 1)
    .execute()

  if (rows.length <= pageSize) {
    return { rows, nextCursor: null }
  }
  const page = rows.slice(0, pageSize)
  const last = page[page.length - 1]!
  return {
    rows: page,
    nextCursor: {
      inserted_at: last.inserted_at,
      object_type: last.object_type,
      object_id: last.object_id,
      relation: last.relation,
      user_str: last.user_str,
    },
  }
}

export interface TupleChangeRow {
  condition_name?: string | null
  condition_context?: Record<string, unknown> | null
  id: string
  seq: string
  object_type: string
  object_id: string
  relation: string
  user_str: string
  operation: 'TUPLE_OPERATION_WRITE' | 'TUPLE_OPERATION_DELETE'
  inserted_at: string
}

export interface ListChangesPage {
  rows: TupleChangeRow[]
  /**
   * Cursor for the next page; null when there are no more rows.
   * The cursor uses (inserted_at, seq) — `seq` is a Postgres-side
   * bigserial column that breaks same-millisecond ties
   * deterministically, in insertion order. See openfga-ra9.
   */
  nextCursor: { inserted_at: string, seq: string } | null
}

/**
 * Oldest-first (ASCENDING) paginated read of the changelog for a
 * store. This matches the OpenFGA ReadChanges API which sequences
 * tuple changes chronologically so polling-tail consumers can
 * advance through history without missing or reordering events.
 *
 * Optional filters narrow by `objectType` (the OpenFGA `?type=`
 * query) and `startTime` (only changes recorded at or after the
 * timestamp).
 *
 * Pagination uses (inserted_at, seq) row-tuple comparison with a
 * strictly-greater-than predicate so a change recorded at the
 * tail while a client is paging surfaces on the next call rather
 * than shifting previously-seen pages. The +1 fetch trick lets us
 * decide "is there a next page" without a separate COUNT query.
 *
 * The `seq` column is bigserial on Postgres (returned as text by
 * pg) and INTEGER PRIMARY KEY AUTOINCREMENT or equivalent on SQLite
 * (returned as number by better-sqlite3). The SELECT casts seq to
 * text so the application sees a string regardless of dialect.
 *
 * See openfga-ra9 for the ordering inversion from the prior
 * newest-first implementation.
 */
export async function listChangesPage(
  storeId: string,
  pageSize: number,
  cursor: { inserted_at: string, seq: string } | null,
  opts: { objectType?: string, startTime?: string } = {},
): Promise<ListChangesPage> {
  return traced(
    'storage',
    'openfga.storage.list_changes',
    () => ({ 'openfga.store_id': storeId, 'openfga.page_size': pageSize }),
    async (span) => {
      const result = await listChangesPageImpl(storeId, pageSize, cursor, opts)
      span.setAttribute('openfga.result_count', result.rows.length)
      return result
    },
  )
}

async function listChangesPageImpl(
  storeId: string,
  pageSize: number,
  cursor: { inserted_at: string, seq: string } | null,
  opts: { objectType?: string, startTime?: string } = {},
): Promise<ListChangesPage> {
  const dialect = getDialect()
  let query = getDb()
    .selectFrom('tuple_change')
    .select([
      'id',
      // Cast seq to text so SQLite doesn't return it as a JS number.
      // Postgres bigserial already comes back as text via pg's default
      // int8 parser; the cast is a no-op there. Aliased as `seq_str`
      // (not `seq`) so the alias does NOT shadow the underlying
      // integer column in `ORDER BY seq` below — referencing the
      // text alias would produce lexicographic ordering ("10" before
      // "7"), which silently breaks pagination once the seq counter
      // crosses a digit boundary on SQLite (openfga-sp5).
      sql<string>`cast(seq as text)`.as('seq_str'),
      'object_type',
      'object_id',
      'relation',
      'user_str',
      'operation',
      'condition_name',
      'condition_context',
      'inserted_at',
    ])
    .where('store_id', '=', storeId)

  if (opts.objectType) {
    query = query.where('object_type', '=', opts.objectType)
  }
  if (opts.startTime) {
    const ts = dialectTimestampParam(dialect, opts.startTime)
    query = query.where(sql<boolean>`inserted_at >= ${ts}`)
  }
  if (cursor) {
    const ts = dialectTimestampParam(dialect, cursor.inserted_at)
    const seq = dialectBigintParam(dialect, cursor.seq)
    query = query.where(sql<boolean>`(inserted_at, seq) > (${ts}, ${seq})`)
  }

  const rawRows = await query
    .orderBy('inserted_at', 'asc')
    .orderBy('seq', 'asc')
    .limit(pageSize + 1)
    .execute()

  // Re-shape the alias to satisfy the public TupleChangeRow contract
  // (`seq: string`). The query returns rows with `seq_str` as the
  // text-cast cursor value; downstream callers expect the field to be
  // named `seq`.
  const rows: TupleChangeRow[] = rawRows.map(({ seq_str, ...rest }) => ({ ...rest, seq: seq_str }))

  if (rows.length <= pageSize) {
    return { rows, nextCursor: null }
  }
  const page = rows.slice(0, pageSize)
  const last = page[page.length - 1]!
  return { rows: page, nextCursor: { inserted_at: last.inserted_at, seq: last.seq } }
}

/**
 * Evaluator helper: list all `user_str` values directly assigned to
 * (objectType:objectId, relation). Used during `check` to enumerate
 * candidate users including direct refs, wildcards, and usersets.
 */
export async function listUsersForRelation(
  storeId: string,
  objectType: string,
  objectId: string,
  relation: string,
  _readContext: ReadContext = DEFAULT_READ_CONTEXT,
): Promise<string[]> {
  const rows = await getDb()
    .selectFrom('tuple')
    .select('user_str')
    .where('store_id', '=', storeId)
    .where('object_type', '=', objectType)
    .where('object_id', '=', objectId)
    .where('relation', '=', relation)
    .execute()
  return rows.map(r => r.user_str)
}

/**
 * Evaluator helper: list all `object_id`s of `objectType` directly
 * assigned to a user via `relation`. Used during `list-objects` to seed
 * the candidate set for `this` rewrites.
 *
 * Also returns objects where the user is reachable via a typed wildcard
 * (`user:*`) — the evaluator caller is responsible for passing those as
 * additional `userStr` values when relevant.
 */
export async function listObjectIdsForUser(
  storeId: string,
  objectType: string,
  relation: string,
  userStr: string,
  _readContext: ReadContext = DEFAULT_READ_CONTEXT,
): Promise<string[]> {
  const rows = await getDb()
    .selectFrom('tuple')
    .select('object_id')
    .distinct()
    .where('store_id', '=', storeId)
    .where('object_type', '=', objectType)
    .where('relation', '=', relation)
    .where('user_str', '=', userStr)
    .execute()
  return rows.map(r => r.object_id)
}

/**
 * Evaluator helper: list every (object_id, user_str) pair for a given
 * (objectType, relation). Used by `list-objects` when walking
 * `tupleToUserset` rewrites — we need to discover related objects
 * regardless of which user reaches them.
 */
export async function listAllForRelation(
  storeId: string,
  objectType: string,
  relation: string,
  _readContext: ReadContext = DEFAULT_READ_CONTEXT,
): Promise<Array<{ object_id: string, user_str: string }>> {
  return getDb()
    .selectFrom('tuple')
    .select(['object_id', 'user_str'])
    .where('store_id', '=', storeId)
    .where('object_type', '=', objectType)
    .where('relation', '=', relation)
    .execute()
}

/** Full edge data for condition-aware evaluation; legacy lookup helpers remain unchanged. */
export async function listTuplesForRelation(
  storeId: string, objectType: string, objectId: string, relation: string,
  _readContext: ReadContext = DEFAULT_READ_CONTEXT,
): Promise<Array<{ user: string, condition?: TupleKey['condition'] }>> {
  const rows = await getDb().selectFrom('tuple')
    .select(['user_str', 'condition_name', 'condition_context'])
    .where('store_id', '=', storeId).where('object_type', '=', objectType)
    .where('object_id', '=', objectId).where('relation', '=', relation).execute()
  return rows.map(row => ({ user: row.user_str, ...conditionOnWire(row) }))
}

export function conditionOnWire(row: {
  condition_name?: string | null, condition_context?: Record<string, unknown> | null,
}): { condition?: TupleKey['condition'] } {
  return row.condition_name
    ? { condition: { name: row.condition_name, context: row.condition_context ?? {} } }
    : {}
}
