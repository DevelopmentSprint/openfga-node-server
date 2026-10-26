import { afterAll, expect, it } from 'vitest'
import { buildMigrator } from '../../src/storage/migrator'
import { getDb, resetDb } from '../../src/storage/db'
import { generateId } from '../../src/storage/ids'

afterAll(() => resetDb())
it('upgrades populated pre-condition storage without changing unconditional rows', async () => {
  const migrator = buildMigrator()
  expect((await migrator.migrateTo('1778083200000_tuple-change-seq')).error).toBeUndefined()
  const db = getDb()
  const id = generateId()
  await db.insertInto('store').values({ id, name: 'upgrade' }).execute()
  const tuple = { store_id: id, object_type: 'document', object_id: 'legacy', relation: 'reader', user_str: 'user:anne' }
  await db.insertInto('tuple').values(tuple).execute()
  await db.insertInto('tuple_change').values({ ...tuple, id: generateId(), operation: 'TUPLE_OPERATION_WRITE' }).execute()
  expect((await migrator.migrateToLatest()).error).toBeUndefined()
  const row = await db.selectFrom('tuple').selectAll().executeTakeFirstOrThrow()
  expect(row).toMatchObject({ ...tuple, condition_name: null, condition_context: null })
  expect((await db.selectFrom('tuple_change').selectAll().executeTakeFirstOrThrow()).condition_name).toBeNull()
  expect((await migrator.migrateDown()).error).toBeUndefined()
  expect((await migrator.migrateToLatest()).error).toBeUndefined()
  expect((await db.selectFrom('tuple').selectAll().executeTakeFirstOrThrow()).user_str).toBe('user:anne')
})
