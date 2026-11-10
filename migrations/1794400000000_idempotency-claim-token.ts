/**
 * OpenFGA-Node-Server: dedicated claim-token column on
 * idempotency_keys (openfga-k2a.14).
 *
 * openfga-k2a.3 stored the in-flight claim token as a random NEGATIVE
 * integer in `response_status` to avoid a schema change. That
 * overloaded the column: it held either a token (in flight) or an HTTP
 * status (completed). This migration gives the token its own nullable
 * `claim_token text` column so `response_status` holds only a real
 * HTTP status.
 *
 * Data move: any row that is in flight at migration time and carries a
 * legacy negative token has the token copied (as text) into
 * `claim_token` and its `response_status` cleared. Completed rows are
 * not touched.
 *
 * down(): drops the column. Completed rows (response_status +
 * response_body) are unaffected. In-flight rows keep a NULL
 * `response_status`, so the pre-k2a.14 code sees them as in flight
 * (409) until the 5-minute in-flight lease makes them reclaimable;
 * their owners' token-guarded completion becomes a no-op. No completed
 * data is lost.
 *
 * Naming: Postgres tables live in the namespace schema
 * (`<ns>.idempotency_keys`); SQLite tables are prefixed
 * (`<ns>_idempotency_keys`), same approach as
 * 1778083200000_tuple-change-seq.ts. No index is added.
 */
import { sql, type Kysely } from 'kysely'
import { getDialect, getNamespace } from '../src/storage/db'
import { isPostgres } from '../src/storage/dialect'

function physicalTable(): string {
  const ns = getNamespace()
  return isPostgres(getDialect()) ? `${ns}.idempotency_keys` : `${ns}_idempotency_keys`
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const table = physicalTable()
  await sql.raw(`alter table ${table} add column claim_token text`).execute(db)
  // Both engines evaluate SET right-hand sides against the pre-update
  // row, so response_status is read before it is cleared.
  await sql.raw(
    `update ${table}
        set claim_token = cast(response_status as text),
            response_status = null
      where status = 'in_flight' and response_status < 0`,
  ).execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`alter table ${physicalTable()} drop column claim_token`).execute(db)
}
