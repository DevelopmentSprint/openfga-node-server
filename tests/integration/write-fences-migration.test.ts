/**
 * Integration test — migration 1794500000000_write-fences (openfga-pzm.4).
 *
 * Runs against SQLite (`integration`) and Postgres (`integration-pg`) in
 * a throwaway namespace so migrating down/up never touches the schema
 * the other integration specs share.
 *
 *   - a database already at 1794400100000 (the last released
 *     migration) migrates forward to the fence table; a name sorting
 *     before an applied migration (the old, never-released
 *     `1793012400001_write-fences`) is refused by Kysely, which is the
 *     regression this name guards against
 *   - the table is namespaced, keyed by (store_id, key), references the
 *     physical store table and cascades on store deletion
 *   - generations up to 2^63-1 round-trip exactly
 *   - down() drops only the fence table and re-applying is clean
 */
import { afterAll, describe, expect, it } from 'vitest'
import { Migrator, sql } from 'kysely'
import { reloadConfigForTests } from '../../src/config'
import { getDb, getDialect, resetDb } from '../../src/storage/db'
import { buildMigrator } from '../../src/storage/migrator'
import { MIGRATIONS } from '../../src/cli/migrations-bundle'

const PREVIOUS = '1794400100000_authorization-model-seq'
const TARGET = '1794500000000_write-fences'
const NS = `pzm4_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
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
    console.warn(`[openfga integration] database unreachable — skipping write-fences migration spec (${(err as Error).message}).`)
    return false
  }
}

const ready = await setUp()
const isPg = ready && getDialect() === 'postgres'
const table = isPg ? `${NS}.write_fence` : `${NS}_write_fence`
const store = isPg ? `${NS}.store` : `${NS}_store`

afterAll(async () => {
  if (isPg) await sql.raw(`drop schema if exists ${NS} cascade`).execute(getDb())
  await resetDb()
  if (savedNs === undefined) delete process.env['OPENFGA_DB_NAMESPACE']
  else process.env['OPENFGA_DB_NAMESPACE'] = savedNs
  await reloadConfigForTests()
})

async function tableExists(): Promise<boolean> {
  const r = isPg
    ? await sql<{ n: number }>`select count(*)::int as n from information_schema.tables where table_schema = ${NS} and table_name = 'write_fence'`.execute(getDb())
    : await sql<{ n: number }>`select count(*) as n from sqlite_master where type = 'table' and name = ${`${NS}_write_fence`}`.execute(getDb())
  return Number(r.rows[0]!.n) === 1
}

const describeIf = ready ? describe : describe.skip

describeIf('write-fences migration', () => {
  it('applies on a database already at the last released migration and is reversible', async () => {
    const migrator = buildMigrator()
    expect((await migrator.migrateTo(PREVIOUS)).error).toBeUndefined()
    expect(await tableExists()).toBe(false)

    // Regression: the never-released name sorted before already
    // applied migrations, which Kysely refuses to run.
    const unordered = new Migrator({
      db: getDb(),
      provider: { getMigrations: async () => ({ ...MIGRATIONS, '1793012400001_write-fences': MIGRATIONS[TARGET]! }) },
      ...(isPg
        ? { migrationTableName: 'kysely_migration', migrationLockTableName: 'kysely_migration_lock', migrationTableSchema: NS }
        : { migrationTableName: `${NS}_kysely_migration`, migrationLockTableName: `${NS}_kysely_migration_lock` }),
    })
    const refused = await unordered.migrateToLatest()
    expect(refused.error).toBeDefined()
    expect(await tableExists()).toBe(false)

    const up = await migrator.migrateToLatest()
    expect(up.error).toBeUndefined()
    expect(up.results?.map(r => r.migrationName)).toEqual([TARGET])
    expect(await tableExists()).toBe(true)

    await sql.raw(`insert into ${store} (id, name) values ('s1', 'one'), ('s2', 'two')`).execute(getDb())
    await sql.raw(
      `insert into ${table} (store_id, key, generation, not_after)
       values ('s1', 'q', '9223372036854775807', '2030-01-01T00:00:00.000Z'), ('s2', 'q', '1', '2030-01-01T00:00:00.000Z')`,
    ).execute(getDb())
    // Store-scoped primary key.
    await expect(sql.raw(`insert into ${table} (store_id, key, generation, not_after) values ('s1', 'q', '2', 'x')`).execute(getDb())).rejects.toThrow()
    // Foreign key to the physical store table.
    await expect(sql.raw(`insert into ${table} (store_id, key, generation, not_after) values ('missing', 'q', '1', 'x')`).execute(getDb())).rejects.toThrow()
    const big = await sql<{ generation: string }>`select generation from ${sql.raw(table)} where store_id = 's1'`.execute(getDb())
    expect(big.rows[0]!.generation).toBe('9223372036854775807')
    // Removed only with the store row.
    await sql.raw(`delete from ${store} where id = 's1'`).execute(getDb())
    const left = await sql<{ store_id: string }>`select store_id from ${sql.raw(table)}`.execute(getDb())
    expect(left.rows.map(r => r.store_id)).toEqual(['s2'])

    const down = await migrator.migrateDown()
    expect(down.error).toBeUndefined()
    expect(down.results?.[0]?.migrationName).toBe(TARGET)
    expect(await tableExists()).toBe(false)
    const stores = await sql<{ id: string }>`select id from ${sql.raw(store)}`.execute(getDb())
    expect(stores.rows.map(r => r.id)).toEqual(['s2'])

    expect((await migrator.migrateToLatest()).error).toBeUndefined()
    expect(await tableExists()).toBe(true)
  })
})
