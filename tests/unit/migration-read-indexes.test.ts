/**
 * Migration 1794300100000_read-and-model-indexes (openfga-k2a.5):
 * adds the /read ordering index and the latest-model index, with
 * namespace-prefixed names on SQLite; down() drops only those two.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { getDb, resetDb } from '../../src/storage/db'
import { reloadConfigForTests } from '../../src/config'
import { buildMigrator } from '../../src/storage/migrator'
import { migrateToLatest } from '../_helpers/sqlite-bootstrap'
import { createStore, deleteStore, getStore } from '../../src/storage/stores'

const ENV_KEYS = ['OPENFGA_DB_URL', 'OPENFGA_DB_NAMESPACE'] as const
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

beforeEach(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  process.env['OPENFGA_DB_URL'] = ':memory:'
  delete process.env['OPENFGA_DB_NAMESPACE']
  await reloadConfigForTests()
  await resetDb()
})

afterEach(async () => {
  await resetDb()
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  await reloadConfigForTests()
})

async function indexes(table: string): Promise<Array<{ name: string, cols: string[] }>> {
  const db = getDb()
  const list = await sql<{ name: string }>`select name from pragma_index_list(${table})`.execute(db)
  const out = []
  for (const { name } of list.rows) {
    const info = await sql<{ name: string }>`select name from pragma_index_info(${name}) order by seqno`.execute(db)
    out.push({ name, cols: info.rows.map(r => r.name) })
  }
  return out
}

describe('read-and-model-indexes migration (SQLite)', () => {
  it('creates both indexes with namespace-prefixed names and the expected columns', async () => {
    process.env['OPENFGA_DB_NAMESPACE'] = 'app_authz'
    await reloadConfigForTests()
    await resetDb()
    await migrateToLatest()
    const tuple = await indexes('app_authz_tuple')
    expect(tuple.find(i => i.name === 'app_authz_idx_tuple_store_read_order')?.cols)
      .toEqual(['store_id', 'inserted_at', 'object_type', 'object_id', 'relation', 'user_str'])
    const model = await indexes('app_authz_authorization_model')
    expect(model.find(i => i.name === 'app_authz_idx_authorization_model_store_id_desc')?.cols)
      .toEqual(['store_id', 'id'])
  })

  it('down() drops only the two new indexes and up() can be re-applied', async () => {
    await migrateToLatest()
    const before = (await indexes('openfga_tuple')).map(i => i.name).sort()
    const beforeModel = (await indexes('openfga_authorization_model')).map(i => i.name).sort()
    const migrator = buildMigrator()
    const down = await migrator.migrateDown()
    expect(down.error).toBeUndefined()
    expect(down.results?.[0]?.migrationName).toBe('1794300100000_read-and-model-indexes')
    const after = (await indexes('openfga_tuple')).map(i => i.name).sort()
    const afterModel = (await indexes('openfga_authorization_model')).map(i => i.name).sort()
    expect(before.filter(n => !after.includes(n))).toEqual(['openfga_idx_tuple_store_read_order'])
    expect(beforeModel.filter(n => !afterModel.includes(n))).toEqual(['openfga_idx_authorization_model_store_id_desc'])
    expect(after.length).toBe(before.length - 1)
    const up = await migrator.migrateToLatest()
    expect(up.error).toBeUndefined()
  })
})

describe('deleteStore', () => {
  it('stamps deleted_at and hides the store', async () => {
    await migrateToLatest()
    const s = await createStore('to-delete')
    await deleteStore(s.id)
    expect(await getStore(s.id)).toBeNull()
    const r = await sql<{ deleted_at: string | null }>`select deleted_at from openfga_store where id = ${s.id}`.execute(getDb())
    expect(r.rows[0]?.deleted_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
  })
})
