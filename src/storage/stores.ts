/**
 * Repository for `openfga.store` rows.
 *
 * Stores are namespaces for tuples and authorization-model versions.
 * One store per environment is the typical shape.
 *
 * Routes through Kysely via `getDb()` (openfga-n0m). The namespace
 * `OPENFGA_DB_NAMESPACE` is applied at the Kysely-instance level —
 * Postgres queries emit as `<namespace>.store`, SQLite as
 * `<namespace>_store` — so the table reference here stays logical.
 */
import { sql } from 'kysely'
import { getDb, getDialect } from './db'
import { dialectTimestampParam } from './dialect'
import { generateId } from './ids'

export interface StoreRow {
  id: string
  name: string
  created_at: string
  updated_at: string
  deleted_at: string | null
}

const STORE_COLUMNS = ['id', 'name', 'created_at', 'updated_at', 'deleted_at'] as const

export async function createStore(name: string): Promise<StoreRow> {
  const id = generateId()
  return await getDb()
    .insertInto('store')
    .values({ id, name })
    .returning(STORE_COLUMNS)
    .executeTakeFirstOrThrow()
}

export async function getStore(id: string): Promise<StoreRow | null> {
  const row = await getDb()
    .selectFrom('store')
    .select(STORE_COLUMNS)
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
  return row ?? null
}

export async function findStoreByName(name: string): Promise<StoreRow | null> {
  const row = await getDb()
    .selectFrom('store')
    .select(STORE_COLUMNS)
    .where('name', '=', name)
    .where('deleted_at', 'is', null)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  return row ?? null
}

export async function listStores(): Promise<StoreRow[]> {
  return getDb()
    .selectFrom('store')
    .select(STORE_COLUMNS)
    .where('deleted_at', 'is', null)
    .orderBy('created_at', 'asc')
    .execute()
}

export interface ListStoresPage {
  rows: StoreRow[]
  /**
   * Cursor for the next page. `null` when there are no more rows.
   * The cursor is the (created_at, id) of the last row this page
   * returned; a follow-up call with this cursor returns rows strictly
   * older than it under the DESC ordering.
   */
  nextCursor: { created_at: string, id: string } | null
}

/**
 * Newest-first paginated listing of non-deleted stores. Pagination is
 * cursor-based on (created_at, id) so a row inserted at the head of
 * the table while a client is paging does not shift previously-seen
 * pages. The +1 fetch trick lets us decide "is there a next page"
 * without a separate COUNT query.
 *
 * The cursor parameter's `::timestamptz` cast (Postgres only) is
 * provided by `dialectTimestampParam` so the row-tuple comparison
 * resolves unambiguously on Postgres (matches the openfga-7ct
 * original) while SQLite emits the bare parameter (strings compare
 * lexicographically in our fixed-width ISO-8601 format).
 */
export async function listStoresPage(
  pageSize: number,
  cursor: { created_at: string, id: string } | null,
): Promise<ListStoresPage> {
  let query = getDb()
    .selectFrom('store')
    .select(STORE_COLUMNS)
    .where('deleted_at', 'is', null)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(pageSize + 1)

  if (cursor) {
    const ts = dialectTimestampParam(getDialect(), cursor.created_at)
    query = query.where(sql<boolean>`(created_at, id) < (${ts}, ${cursor.id})`)
  }

  const rows = await query.execute()
  if (rows.length <= pageSize) {
    return { rows, nextCursor: null }
  }
  const page = rows.slice(0, pageSize)
  const last = page[page.length - 1]!
  return { rows: page, nextCursor: { created_at: last.created_at, id: last.id } }
}

/** Soft deletion keeps authorization history while hiding all store-scoped APIs. */
export async function deleteStore(id: string): Promise<void> {
  await getDb().updateTable('store')
    .set({ deleted_at: new Date().toISOString() })
    .where('id', '=', id).where('deleted_at', 'is', null).execute()
}
