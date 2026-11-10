/**
 * Storage layer for `openfga.idempotency_keys`.
 *
 * The middleware in `src/middleware/idempotency.ts` is the only
 * consumer. The functions here encapsulate the SQL and the
 * concurrency protocol so the middleware can stay readable.
 *
 * Routes through Kysely via `getDb()` (openfga-6tv). The TTL cutoff
 * is rendered by `dialectNowMinus(dialect, ms)` so the openfga-how
 * SQL-side cutoff (cutoff and `created_at` share the database's
 * clock) is preserved across both engines.
 *
 * Concurrency model:
 *
 *   - `claimKey` is the atomic entry point. It deletes any row for the
 *     key that is past the record TTL, or that is still `in_flight`
 *     but past the in-flight lease (its owner crashed or hung), then
 *     attempts an `INSERT ... ON CONFLICT (key) DO NOTHING`. If the
 *     insert wins, the caller owns the slot and receives a claim
 *     token; it must eventually call `completeKey` or `releaseKey`
 *     with that token. If the insert loses, the caller reads the
 *     existing row to classify the result as in-flight, replay, or
 *     mismatch.
 *
 *   - `completeKey` records a final response so subsequent retries
 *     replay it.
 *
 *   - `releaseKey` removes an in-flight row when the handler errored
 *     (non-2xx response or thrown exception) so the client can retry
 *     cleanly. Only 2xx responses are recorded (openfga-k2a.14).
 *
 * Claim ownership (openfga-k2a.3):
 *
 *   Once a lease expires another request may reclaim the key. The
 *   original (stale) owner may still finish later, so `completeKey`
 *   and `releaseKey` only touch the row when it is still `in_flight`
 *   AND carries the caller's claim token. A stale owner's writes are
 *   no-ops and report `false`.
 *
 *   The token lives in its own nullable `claim_token` column
 *   (openfga-k2a.14; previously a negative integer overloaded onto
 *   `response_status`). It is a random UUID set on claim and cleared
 *   on completion, so `response_status` only ever holds a real HTTP
 *   status. A replay is only produced for `completed` rows, so the
 *   token is never served.
 */
import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { getDb, getDialect } from './db'
import { dialectNow, dialectNowMinus } from './dialect'

/**
 * How long an `in_flight` claim is honored before the key becomes
 * reclaimable. Bounds how long a crashed or hung request can block
 * retries (previously the full record TTL, 24h by default). Mutating
 * handlers in this server complete in well under a second, so a
 * request still running after this long is treated as abandoned.
 */
export const IN_FLIGHT_LEASE_MS = 5 * 60_000

export type ClaimResult =
  | { kind: 'claimed', token: string }
  | { kind: 'in_flight' }
  | { kind: 'mismatch' }
  | { kind: 'replay', status: number, body: unknown }

export interface ClaimOptions {
  /** Override the in-flight lease. Tests only; production uses IN_FLIGHT_LEASE_MS. */
  inFlightLeaseMs?: number
}

function newClaimToken(): string {
  return randomUUID()
}

/**
 * Atomically claim an idempotency-key slot or classify the existing
 * record. The `ttlMs` is enforced here: rows older than the cutoff
 * are deleted before the claim attempt, so TTL needs no separate
 * cleanup job. `in_flight` rows are additionally reclaimable once
 * older than the in-flight lease (capped at `ttlMs`).
 *
 * Returns:
 *   - 'claimed' — the caller owns the slot and must follow up with
 *     `completeKey` (2xx) or `releaseKey` (non-2xx / thrown),
 *     passing the returned `token`.
 *   - 'in_flight' — a concurrent request holds the slot. Caller
 *     should respond 409.
 *   - 'mismatch' — the slot is claimed with a different fingerprint.
 *     Caller should respond 422.
 *   - 'replay' — the slot is completed and the cached response
 *     should be returned to the client.
 */
export async function claimKey(
  key: string,
  fingerprint: string,
  ttlMs: number,
  options: ClaimOptions = {},
): Promise<ClaimResult> {
  // The DELETE+INSERT+SELECT runs as three separate queries against
  // the configured Kysely instance. The original pool.connect()
  // wrapper on the legacy pg.Pool path was a perf optimization (one
  // checkout for three queries); we deliberately do NOT use Kysely's
  // analogous getDb().connection().execute() here because it
  // deadlocks under sequential claimKey() calls on the SqliteDialect
  // (the single-connection lock isn't released cleanly between
  // calls; see openfga-8ys investigation). The auto-checkout cost on
  // Postgres is negligible compared to the correctness win on
  // SQLite. ON CONFLICT DO NOTHING is row-atomic at the engine
  // level, so no wrapping transaction is needed for the three-step
  // protocol.
  const dialect = getDialect()
  const leaseMs = Math.min(options.inFlightLeaseMs ?? IN_FLIGHT_LEASE_MS, ttlMs)
  return await claimWithDb(dialect, key, fingerprint, ttlMs, leaseMs, true)
}

async function claimWithDb(
  dialect: ReturnType<typeof getDialect>,
  key: string,
  fingerprint: string,
  ttlMs: number,
  leaseMs: number,
  mayRetry: boolean,
): Promise<ClaimResult> {
  const db = getDb()

  // Compute the TTL cutoff in SQL so it shares the clock that wrote
  // `created_at`. A JS-computed cutoff (Date.now() - ttlMs) compared
  // against the row's database-assigned `created_at` is a clock-skew
  // race: even microsecond drift between the application container
  // and the DB can leave rows strictly after the JS cutoff, making
  // the DELETE silently miss them and the SELECT then return them
  // with a stale fingerprint. See openfga-how.
  //
  // The cutoff comparison is `<=` (not `<`) so that on a dialect
  // where the clock and the row's `created_at` resolve to the same
  // instant (SQLite's 'now' is millisecond-floor, openfga-sp5), a
  // ttlMs=0 sweep still treats existing rows as expired. The lookup
  // mirror below uses the inclusive boundary's complement (`>`) to
  // stay consistent. Postgres microsecond now() effectively never
  // hit the equality boundary, so this is a no-op there in practice.
  //
  // The same rule applies to the in-flight lease: an `in_flight` row
  // whose lease has run out is deleted here so this request can
  // claim it. Two concurrent reclaimers both run the DELETE, but only
  // one INSERT wins; the other sees the fresh row as in flight. A row
  // inserted by the winner is never inside the lease cutoff, so a
  // late DELETE from the loser cannot remove it.
  await db
    .deleteFrom('idempotency_keys')
    .where('key', '=', key)
    .where(eb => eb.or([
      sql<boolean>`created_at <= ${dialectNowMinus(dialect, ttlMs)}`,
      eb.and([
        eb('status', '=', 'in_flight'),
        sql<boolean>`created_at <= ${dialectNowMinus(dialect, leaseMs)}`,
      ]),
    ]))
    .execute()

  const token = newClaimToken()
  const insertResult = await db
    .insertInto('idempotency_keys')
    .values({ key, request_hash: fingerprint, status: 'in_flight', claim_token: token })
    .onConflict(oc => oc.column('key').doNothing())
    .returning('key')
    .executeTakeFirst()

  if (insertResult) return { kind: 'claimed', token }

  const lookup = await db
    .selectFrom('idempotency_keys')
    .select(['request_hash', 'status', 'response_status', 'response_body'])
    .where('key', '=', key)
    .where(sql<boolean>`created_at > ${dialectNowMinus(dialect, ttlMs)}`)
    .executeTakeFirst()

  // The row was deleted between our INSERT and SELECT (TTL/lease race
  // or the owner released it). Retry once — the second attempt will
  // normally succeed because no other request is holding the slot.
  // If it races again, report in-flight (409, retryable) rather than
  // recursing without bound.
  if (!lookup) {
    if (mayRetry) return claimWithDb(dialect, key, fingerprint, ttlMs, leaseMs, false)
    return { kind: 'in_flight' }
  }

  if (lookup.request_hash !== fingerprint) return { kind: 'mismatch' }
  if (lookup.status === 'in_flight') return { kind: 'in_flight' }

  return {
    kind: 'replay',
    status: lookup.response_status ?? 500,
    body: lookup.response_body,
  }
}

/**
 * Record the final response for a claim. Returns `false` (and writes
 * nothing) when the caller no longer owns the claim — its lease
 * expired and another request reclaimed the key.
 */
export async function completeKey(
  key: string,
  token: string,
  status: number,
  body: unknown,
): Promise<boolean> {
  const result = await getDb()
    .updateTable('idempotency_keys')
    .set({
      status: 'completed',
      response_status: status,
      claim_token: null,
      // JSON column insert/update type is `string | null` per the
      // ColumnType deviation documented in db-schema.ts; the caller
      // hands us an arbitrary value, we stringify (or null when
      // undefined) to match the legacy contract.
      response_body: body === undefined ? null : JSON.stringify(body),
      completed_at: dialectNow(getDialect()),
    })
    .where('key', '=', key)
    .where('status', '=', 'in_flight')
    .where('claim_token', '=', token)
    .executeTakeFirst()
  return Number(result.numUpdatedRows) > 0
}

/**
 * Drop an in-flight claim so the client can retry. Returns `false`
 * (and deletes nothing) when the caller no longer owns the claim, so
 * a stale owner can never delete the new owner's row or a completed
 * record.
 */
export async function releaseKey(key: string, token: string): Promise<boolean> {
  const result = await getDb()
    .deleteFrom('idempotency_keys')
    .where('key', '=', key)
    .where('status', '=', 'in_flight')
    .where('claim_token', '=', token)
    .executeTakeFirst()
  return Number(result.numDeletedRows) > 0
}
