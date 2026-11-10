/**
 * Integration test — migration 1794400000000_idempotency-claim-token
 * (openfga-k2a.14).
 *
 * Runs against SQLite (`integration`) and Postgres (`integration-pg`).
 * Uses a throwaway namespace so migrating down/up never touches the
 * schema the other integration specs share:
 *
 *   - migrate to the previous migration, seed legacy rows (an
 *     in-flight row carrying a negative token in response_status and a
 *     completed row with a real HTTP status)
 *   - up(): the in-flight token moves to claim_token and its
 *     response_status is cleared; the completed row is unchanged
 *   - the migrated in-flight row is completable with its legacy token
 *   - down(): drops claim_token without losing completed data
 */
import { afterAll, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { reloadConfigForTests } from '../../src/config'
import { getDb, getDialect, resetDb } from '../../src/storage/db'
import { buildMigrator } from '../../src/storage/migrator'
import { claimKey, completeKey } from '../../src/storage/idempotency'

const PREVIOUS = '1794300100000_read-and-model-indexes'
const TARGET = '1794400000000_idempotency-claim-token'
const NS = `k2a14_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
const savedNs = process.env['OPENFGA_DB_NAMESPACE']

async function setUp(): Promise<boolean> {
  if (!process.env['OPENFGA_DB_URL']) return false
  process.env['OPENFGA_DB_NAMESPACE'] = NS
  await reloadConfigForTests()
  await resetDb()
  try {
    await sql`select 1`.execute(getDb())
    return true
  }
  catch (err) {
    console.warn(`[openfga integration] database unreachable — skipping claim-token migration spec (${(err as Error).message}).`)
    return false
  }
}

const ready = await setUp()
const isPg = ready && getDialect() === 'postgres'
const table = isPg ? `${NS}.idempotency_keys` : `${NS}_idempotency_keys`

afterAll(async () => {
  if (isPg) await sql.raw(`drop schema if exists ${NS} cascade`).execute(getDb())
  await resetDb()
  if (savedNs === undefined) delete process.env['OPENFGA_DB_NAMESPACE']
  else process.env['OPENFGA_DB_NAMESPACE'] = savedNs
  await reloadConfigForTests()
})

interface Row {
  key: string
  status: string
  response_status: number | null
  claim_token?: string | null
  response_body: unknown
}

async function rows(): Promise<Row[]> {
  const r = await sql.raw<Row>(`select * from ${table} order by key`).execute(getDb())
  return r.rows.map(row => ({
    ...row,
    // SQLite returns the text column raw; Postgres parses jsonb.
    response_body: typeof row.response_body === 'string' ? JSON.parse(row.response_body) : row.response_body,
  }))
}

const describeIf = ready ? describe : describe.skip

describeIf('idempotency claim_token migration', () => {
  it('moves legacy in-flight tokens into claim_token and preserves completed rows across up/down', async () => {
    const migrator = buildMigrator()
    const before = await migrator.migrateTo(PREVIOUS)
    expect(before.error).toBeUndefined()

    await sql.raw(
      `insert into ${table} (key, request_hash, status, response_status, response_body)
       values ('a-inflight', 'fp-a', 'in_flight', -12345, null),
              ('b-done', 'fp-b', 'completed', 201, '{"id":"kept"}')`,
    ).execute(getDb())

    const up = await migrator.migrateTo(TARGET)
    expect(up.error).toBeUndefined()
    expect(up.results?.map(r => r.migrationName)).toEqual([TARGET])

    expect(await rows()).toMatchObject([
      { key: 'a-inflight', status: 'in_flight', response_status: null, claim_token: '-12345' },
      { key: 'b-done', status: 'completed', response_status: 201, claim_token: null, response_body: { id: 'kept' } },
    ])

    // The storage layer treats the migrated row as a live claim owned
    // by the legacy token.
    expect(await claimKey('a-inflight', 'fp-a', 60_000)).toEqual({ kind: 'in_flight' })
    expect(await completeKey('a-inflight', '-12345', 200, { ok: true })).toBe(true)
    expect(await claimKey('b-done', 'fp-b', 60_000)).toEqual({ kind: 'replay', status: 201, body: { id: 'kept' } })

    const down = await migrator.migrateDown()
    expect(down.error).toBeUndefined()
    expect(down.results?.[0]?.migrationName).toBe(TARGET)

    const after = await rows()
    expect(after.every(r => !('claim_token' in r))).toBe(true)
    expect(after).toMatchObject([
      { key: 'a-inflight', status: 'completed', response_status: 200, response_body: { ok: true } },
      { key: 'b-done', status: 'completed', response_status: 201, response_body: { id: 'kept' } },
    ])

    // Re-applying is clean.
    const again = await migrator.migrateToLatest()
    expect(again.error).toBeUndefined()
  })
})
