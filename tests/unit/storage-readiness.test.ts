/**
 * Unit tests for the engine-agnostic readiness probe.
 *
 * vitest's unit project sets `OPENFGA_DB_URL=:memory:` so a fresh
 * SQLite instance is used per `resetDb()`. The cases here cover:
 *
 *   - schema_missing: probe runs against an empty DB; reports the
 *     full set of expected core tables as missing.
 *   - schema_missing (partial): manually provision a subset and
 *     assert only the absent tables are reported missing.
 *   - ok: run the production migrator (via the sqlite-bootstrap
 *     helper) and assert the probe goes green.
 *   - db_unreachable: point OPENFGA_DB_URL at an unopenable SQLite
 *     path so getDb() succeeds but the first query fails.
 *   - namespace honoured: change OPENFGA_DB_NAMESPACE and assert the
 *     SQLite branch looks for the prefixed table names.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { getDb, resetDb } from '../../src/storage/db'
import { MIGRATIONS } from '../../src/cli/migrations-bundle'
import { checkReadiness } from '../../src/storage/readiness'
import { migrateToLatest } from '../_helpers/sqlite-bootstrap'
import { reloadConfigForTests } from '../../src/config'

const ENV_KEYS = ['OPENFGA_DB_URL', 'OPENFGA_DB_NAMESPACE'] as const
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

beforeEach(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  process.env['OPENFGA_DB_URL'] = ':memory:'
  delete process.env['OPENFGA_DB_NAMESPACE']
  await reloadConfigForTests()
  await resetDb()
})

afterEach(async () => {
  await resetDb()
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  await reloadConfigForTests()
})

describe('checkReadiness (SQLite)', () => {
  it('reports schema_missing on an unmigrated database', async () => {
    const result = await checkReadiness()
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('schema_missing')
    expect(result.missing).toEqual(
      expect.arrayContaining(['store', 'authorization_model', 'tuple', 'kysely_migration']),
    )
  })

  it('reports only the absent tables when some core tables exist', async () => {
    const db = getDb()
    // Provision two of the four core tables by hand. The probe should
    // report the other two as missing.
    await sql`create table openfga_store (id text primary key)`.execute(db)
    await sql`create table openfga_tuple (store_id text, object_type text, object_id text, relation text, user_str text)`.execute(db)
    const result = await checkReadiness()
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('schema_missing')
    expect(result.missing).toEqual(['authorization_model', 'kysely_migration'])
  })

  it('reports ok after the production migrator has run', async () => {
    await migrateToLatest()
    const result = await checkReadiness()
    expect(result).toEqual({ ok: true })
  })

  it('reports schema_outdated when a bundled migration is not recorded', async () => {
    await migrateToLatest()
    const latest = Object.keys(MIGRATIONS).sort().at(-1)!
    await sql`delete from openfga_kysely_migration where name = ${latest}`.execute(getDb())
    const result = await checkReadiness()
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('schema_outdated')
    expect(result.pending).toEqual([latest])
  })

  it('honours a non-default OPENFGA_DB_NAMESPACE (looks for prefixed names)', async () => {
    process.env['OPENFGA_DB_NAMESPACE'] = 'app_authz'
    await reloadConfigForTests()
    await resetDb()
    await migrateToLatest()
    const result = await checkReadiness()
    expect(result).toEqual({ ok: true })
  })

  it('works under a namespace that is a prefix of a logical table name', async () => {
    process.env['OPENFGA_DB_NAMESPACE'] = 'tuple'
    await reloadConfigForTests()
    await resetDb()
    await migrateToLatest()
    expect(await checkReadiness()).toEqual({ ok: true })
  })

  it('reports db_unreachable when the database file cannot be opened', async () => {
    // /dev/null is not a directory — opening a SQLite file beneath it
    // succeeds at handle creation under better-sqlite3 but fails on
    // first query, which is exactly the surface the probe needs to
    // tolerate (open-success-then-query-fail).
    process.env['OPENFGA_DB_URL'] = 'sqlite:/dev/null/openfga.db'
    await reloadConfigForTests()
    await resetDb()
    const result = await checkReadiness()
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('db_unreachable')
  })
})
