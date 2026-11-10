/**
 * OpenFGA-Node-Server: write-order sequence on authorization_model
 * (openfga-k2a.12 decision, implemented by openfga-k2a.16).
 *
 * "Latest model" used to be max(id) by ULID. ULID monotonicity only
 * holds inside one process, so with several replicas and clock skew a
 * later write can sort earlier and checks silently use an older model.
 * This adds a database-assigned, monotonically increasing integer
 * `seq`; the latest model is the row with the highest `seq` per store.
 *
 * Backfill: existing rows get seq = row_number() over (order by id), i.e.
 * ULID order, which is the order the old behaviour already used, so
 * existing deployments see no change in which model is latest.
 *
 * Postgres: a dedicated sequence is created, the column is backfilled,
 * then given `default nextval(...)` and NOT NULL, and the sequence is
 * owned by the column (dropped with it). The sequence is advanced past
 * the backfilled maximum. Note a sequence value is taken at INSERT, not
 * at commit, so two concurrent uncommitted writers may commit in the
 * opposite order of their seq values; that is the accepted granularity.
 *
 * SQLite: `seq integer not null default 0`, backfilled, then an AFTER
 * INSERT trigger assigns max(seq)+1. SQLite serialises writers, so the
 * assignment is race-free inside the writing transaction.
 *
 * Index (store_id, seq desc) serves the latest-model lookup and the
 * newest-first listing. Naming follows 1778083200000_tuple-change-seq.ts
 * and 1794300100000_read-and-model-indexes.ts: schema-qualified on
 * Postgres, namespace-prefixed on SQLite (one global index namespace).
 */
import { sql, type Kysely } from 'kysely'
import { getDialect, getNamespace } from '../src/storage/db'
import { isPostgres } from '../src/storage/dialect'

function names() {
  const ns = getNamespace()
  const pg = isPostgres(getDialect())
  return {
    pg,
    ns,
    table: pg ? `${ns}.authorization_model` : `${ns}_authorization_model`,
    sequence: `${ns}.authorization_model_seq_seq`,
    storeIndex: pg ? 'idx_authorization_model_store_seq_desc' : `${ns}_idx_authorization_model_store_seq_desc`,
    storeIndexDrop: pg ? `${ns}.idx_authorization_model_store_seq_desc` : `${ns}_idx_authorization_model_store_seq_desc`,
    uniqueIndex: `${ns}_idx_authorization_model_seq`,
    trigger: `${ns}_authorization_model_seq_assign`,
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const n = names()
  if (n.pg) {
    await sql.raw(`create sequence ${n.sequence}`).execute(db)
    await sql.raw(`alter table ${n.table} add column seq bigint`).execute(db)
    await sql.raw(
      `update ${n.table} t set seq = r.rn
         from (select id, row_number() over (order by id) as rn from ${n.table}) r
         where t.id = r.id`,
    ).execute(db)
    await sql.raw(
      `select setval('${n.sequence}', coalesce((select max(seq) from ${n.table}), 0) + 1, false)`,
    ).execute(db)
    await sql.raw(`alter table ${n.table} alter column seq set default nextval('${n.sequence}')`).execute(db)
    await sql.raw(`alter table ${n.table} alter column seq set not null`).execute(db)
    await sql.raw(`alter sequence ${n.sequence} owned by ${n.table}.seq`).execute(db)
  }
  else {
    await sql.raw(`alter table ${n.table} add column seq integer not null default 0`).execute(db)
    await sql.raw(
      `update ${n.table} set seq = (
         select rn from (select id, row_number() over (order by id) as rn from ${n.table}) r
         where r.id = ${n.table}.id)`,
    ).execute(db)
    await sql.raw(`create unique index ${n.uniqueIndex} on ${n.table} (seq)`).execute(db)
    await sql.raw(
      `create trigger ${n.trigger}
         after insert on ${n.table}
         begin
           update ${n.table}
             set seq = (select coalesce(max(seq), 0) + 1 from ${n.table})
             where id = NEW.id;
         end`,
    ).execute(db)
  }
  await sql.raw(`create index ${n.storeIndex} on ${n.table} (store_id, seq desc)`).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const n = names()
  await sql.raw(`drop index ${n.storeIndexDrop}`).execute(db)
  if (n.pg) {
    // Dropping the column also drops its owned sequence and default.
    await sql.raw(`alter table ${n.table} drop column seq`).execute(db)
  }
  else {
    await sql.raw(`drop trigger ${n.trigger}`).execute(db)
    await sql.raw(`drop index ${n.uniqueIndex}`).execute(db)
    await sql.raw(`alter table ${n.table} drop column seq`).execute(db)
  }
}
