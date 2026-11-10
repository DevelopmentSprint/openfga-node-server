/**
 * OpenFGA-Node-Server: operational table for the optional durable
 * write-fence extension (openfga-pzm.4, docs/features/write-fences.md).
 *
 * One row per (store, fence key): the latest acquired generation and
 * its lease expiry. Rows are operational metadata, not part of the
 * upstream OpenFGA model/tuple contract, and are never exported. They
 * live as long as the store row and are removed only with it (foreign
 * key ON DELETE CASCADE); deleting or resetting them would let an old
 * generation be reused.
 *
 *   store_id    text not null, FK -> store.id on delete cascade
 *   key         text not null           (fence key, 1-128 chars)
 *   generation  text not null           (canonical positive decimal,
 *                                        <= 9223372036854775807; '0'
 *                                        marks an unacquired row)
 *   not_after   text not null           (ISO-8601 UTC lease expiry)
 *   primary key (store_id, key)
 *
 * `generation` is text on both engines so values up to 2^63-1 survive
 * exactly (better-sqlite3 returns INTEGER as a JS number by default).
 * Ordering is always computed numerically in application code
 * (BigInt), never by text comparison.
 *
 * The table is created whether or not the extension is enabled, so
 * enabling it later needs no schema change.
 *
 * Naming follows 1794400000000_idempotency-claim-token.ts and
 * 1794400100000_authorization-model-seq.ts: the namespace is spelled
 * out explicitly (Postgres `<ns>.write_fence`, SQLite
 * `<ns>_write_fence`). The FK target is the PHYSICAL qualified store
 * table, because the SQLite prefix plugin does not rewrite
 * `references` targets in raw SQL. No secondary index is created; the
 * primary key serves every lookup. Postgres enables row level security
 * to match the schema-wide posture.
 */
import { sql, type Kysely } from 'kysely'
import { getDialect, getNamespace } from '../src/storage/db'
import { isPostgres } from '../src/storage/dialect'

function names() {
  const ns = getNamespace()
  const pg = isPostgres(getDialect())
  return {
    pg,
    table: pg ? `${ns}.write_fence` : `${ns}_write_fence`,
    store: pg ? `${ns}.store` : `${ns}_store`,
    pkey: pg ? 'write_fence_pkey' : `${ns}_write_fence_pkey`,
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const n = names()
  await sql.raw(
    `create table ${n.table} (
       store_id text not null references ${n.store} (id) on delete cascade,
       key text not null,
       generation text not null,
       not_after text not null,
       constraint ${n.pkey} primary key (store_id, key)
     )`,
  ).execute(db)
  if (n.pg) {
    await sql.raw(`alter table ${n.table} enable row level security`).execute(db)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`drop table if exists ${names().table}`).execute(db)
}
