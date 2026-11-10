/**
 * OpenFGA-Node-Server: additive indexes for /read ordering and
 * latest-model lookup (openfga-k2a.5).
 *
 *   - tuple (store_id, inserted_at, object_type, object_id, relation,
 *     user_str): matches the ORDER BY used by paginated /read in
 *     src/storage/tuples.ts so the planner can walk the index instead
 *     of sorting every matching row.
 *   - authorization_model (store_id, id desc): matches the "latest
 *     model" lookup (ORDER BY id DESC LIMIT 1) in
 *     src/storage/authorization-models.ts.
 *
 * Purely additive: no existing object is altered. down() drops only the
 * two indexes created here.
 *
 * Naming: Postgres indexes live in the namespace schema, so plain names
 * suffice and are created through the schema-qualified table. SQLite
 * index names share one global namespace per database file, so they are
 * prefixed with the namespace (same approach as
 * 1778083200000_tuple-change-seq.ts).
 */
import { sql, type Kysely } from 'kysely'
import { getDialect, getNamespace } from '../src/storage/db'
import { isPostgres } from '../src/storage/dialect'

function names() {
  const dialect = getDialect()
  const ns = getNamespace()
  const pg = isPostgres(dialect)
  const table = (t: string) => pg ? `${ns}.${t}` : `${ns}_${t}`
  const index = (n: string) => pg ? n : `${ns}_${n}`
  const dropTarget = (n: string) => pg ? `${ns}.${n}` : `${ns}_${n}`
  return { table, index, dropTarget }
}

const TUPLE_INDEX = 'idx_tuple_store_read_order'
const MODEL_INDEX = 'idx_authorization_model_store_id_desc'

export async function up(db: Kysely<unknown>): Promise<void> {
  const { table, index } = names()
  await sql.raw(
    `create index ${index(TUPLE_INDEX)} on ${table('tuple')} `
    + '(store_id, inserted_at, object_type, object_id, relation, user_str)',
  ).execute(db)
  await sql.raw(
    `create index ${index(MODEL_INDEX)} on ${table('authorization_model')} (store_id, id desc)`,
  ).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const { dropTarget } = names()
  await sql.raw(`drop index ${dropTarget(MODEL_INDEX)}`).execute(db)
  await sql.raw(`drop index ${dropTarget(TUPLE_INDEX)}`).execute(db)
}
