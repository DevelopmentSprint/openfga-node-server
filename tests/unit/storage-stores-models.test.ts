/**
 * Unit tests for `stores.ts` and `authorization-models.ts` against
 * in-memory SQLite. Bootstraps the schema via the Kysely Migrator
 * (the same migration files the production CLI applies under
 * `pnpm migrate up`), so the tests stay in sync with schema evolution.
 *
 * Originally introduced as smoke tests under openfga-n0m when SQLite
 * was a manual bootstrap. Promoted to migrator-backed unit tests
 * under openfga-yg9.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { getDb, resetDb } from '../../src/storage/db'
import {
  createStore,
  findStoreByName,
  getStore,
  listStores,
  listStoresPage,
} from '../../src/storage/stores'
import {
  getAuthorizationModel,
  getLatestAuthorizationModel,
  getLatestAuthorizationModelId,
  listAuthorizationModelsPage,
  listAuthorizationModels,
  writeAuthorizationModel,
} from '../../src/storage/authorization-models'
import { migrateToLatest } from '../_helpers/sqlite-bootstrap'

/**
 * Stamp `created_at` on a row to a known ISO-8601 value so ordering
 * assertions are deterministic without relying on wall-clock spacing.
 * Tests use this to space inserts on a synthetic timeline (e.g.
 * `2026-01-01T00:00:00.001Z`, `…002Z`, `…003Z`) instead of
 * `setTimeout` between insertions.
 */
async function stampCreatedAt(table: 'openfga_store' | 'openfga_authorization_model', id: string, ts: string): Promise<void> {
  if (table === 'openfga_store') {
    await sql`update openfga_store set created_at = ${ts}, updated_at = ${ts} where id = ${id}`.execute(getDb())
  }
  else {
    await sql`update openfga_authorization_model set created_at = ${ts} where id = ${id}`.execute(getDb())
  }
}

function syntheticTs(i: number): string {
  // Pad to 3-digit ms so lexicographic comparison on the full
  // ISO-8601 string sorts numerically.
  return `2026-01-01T00:00:00.${String(i).padStart(3, '0')}Z`
}

const ENV_KEYS = ['OPENFGA_DB_URL', 'OPENFGA_DB_NAMESPACE'] as const
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

beforeEach(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  await resetDb()
  // OPENFGA_DB_URL=:memory: is set by vitest.config.ts for the unit
  // project. Ensure the namespace stays at default so the migrator's
  // tracking tables and the ported storage modules agree on the
  // physical table names.
  delete process.env['OPENFGA_DB_NAMESPACE']
  await migrateToLatest()
})

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  await resetDb()
})

describe('stores (Kysely port)', () => {
  it('createStore returns a fully-populated row', async () => {
    const row = await createStore('hello')
    expect(row.id).toMatch(/[A-Z0-9]{20,}/i)
    expect(row.name).toBe('hello')
    expect(typeof row.created_at).toBe('string')
    expect(typeof row.updated_at).toBe('string')
    expect(row.deleted_at).toBeNull()
  })

  it('getStore round-trips and excludes soft-deleted', async () => {
    const a = await createStore('a')
    const b = await createStore('b')
    expect((await getStore(a.id))?.name).toBe('a')
    // Soft-delete `a` and verify getStore excludes it.
    await sql`update openfga_store set deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where id = ${a.id}`.execute(getDb())
    expect(await getStore(a.id)).toBeNull()
    expect((await getStore(b.id))?.name).toBe('b')
  })

  it('findStoreByName returns the most recent live row', async () => {
    const first = await createStore('dup')
    await stampCreatedAt('openfga_store', first.id, syntheticTs(1))
    const second = await createStore('dup')
    await stampCreatedAt('openfga_store', second.id, syntheticTs(2))
    const found = await findStoreByName('dup')
    expect(found?.id).toBe(second.id)
  })

  it('listStores returns oldest-first', async () => {
    const a = await createStore('a')
    await stampCreatedAt('openfga_store', a.id, syntheticTs(1))
    const b = await createStore('b')
    await stampCreatedAt('openfga_store', b.id, syntheticTs(2))
    const list = await listStores()
    expect(list.map(s => s.id)).toEqual([a.id, b.id])
  })

  it('listStoresPage cursor-walks newest-first to terminal page', async () => {
    const created: string[] = []
    for (let i = 0; i < 5; i++) {
      const row = await createStore(`s${i}`)
      await stampCreatedAt('openfga_store', row.id, syntheticTs(i + 1))
      created.push(row.id)
    }
    const seen: string[] = []
    let cursor: { created_at: string, id: string } | null = null
    let safety = 50
    while (safety-- > 0) {
      const page = await listStoresPage(2, cursor)
      seen.push(...page.rows.map(r => r.id))
      if (page.nextCursor === null) break
      cursor = page.nextCursor
    }
    expect(safety).toBeGreaterThan(0)
    // Newest-first across the walk; no duplicates, no drops.
    expect(seen).toEqual([...created].reverse())
    expect(new Set(seen).size).toBe(seen.length)
  })
})

describe('authorization_model (Kysely port)', () => {
  async function makeStore(): Promise<string> {
    return (await createStore('s')).id
  }

  it('writeAuthorizationModel round-trips the JSON model', async () => {
    const storeId = await makeStore()
    const written = await writeAuthorizationModel(storeId, {
      schema_version: '1.1',
      type_definitions: [
        { type: 'user' },
        { type: 'document', relations: { viewer: { this: {} } } },
      ],
    })
    expect(written.id).toMatch(/[A-Z0-9]{20,}/i)
    expect(written.schema_version).toBe('1.1')
    expect(written.type_definitions).toHaveLength(2)
    expect(written.type_definitions[1]?.type).toBe('document')
  })

  it('getAuthorizationModel returns by (storeId, modelId) and rejects cross-store', async () => {
    const storeA = await makeStore()
    const storeB = await makeStore()
    const written = await writeAuthorizationModel(storeA, {
      schema_version: '1.1',
      type_definitions: [{ type: 'user' }],
    })
    expect(await getAuthorizationModel(storeA, written.id)).not.toBeNull()
    expect(await getAuthorizationModel(storeB, written.id)).toBeNull()
  })

  it('getLatestAuthorizationModel returns the most recently written model', async () => {
    const storeId = await makeStore()
    const first = await writeAuthorizationModel(storeId, {
      schema_version: '1.1',
      type_definitions: [{ type: 'user' }],
    })
    await stampCreatedAt('openfga_authorization_model', first.id, syntheticTs(1))
    const second = await writeAuthorizationModel(storeId, {
      schema_version: '1.1',
      type_definitions: [{ type: 'user' }, { type: 'doc' }],
    })
    await stampCreatedAt('openfga_authorization_model', second.id, syntheticTs(2))
    const latest = await getLatestAuthorizationModel(storeId)
    expect(latest?.id).toBe(second.id)
    expect(latest?.type_definitions).toHaveLength(2)
  })

  it('listAuthorizationModels honours pageSize and DESC ordering', async () => {
    const storeId = await makeStore()
    const ids: string[] = []
    for (let i = 0; i < 4; i++) {
      const row = await writeAuthorizationModel(storeId, {
        schema_version: '1.1',
        type_definitions: [{ type: `t${i}` }],
      })
      await stampCreatedAt('openfga_authorization_model', row.id, syntheticTs(i + 1))
      ids.push(row.id)
    }
    const page = await listAuthorizationModels(storeId, 2)
    // DESC by created_at — last two written come first.
    expect(page.map(m => m.id)).toEqual([ids[3], ids[2]])
  })

  it('selects latest by write-order seq even when a later write has a lexically smaller id (openfga-k2a.16)', async () => {
    const storeId = await makeStore()
    const first = await writeAuthorizationModel(storeId, {
      schema_version: '1.1',
      type_definitions: [{ type: 'user' }],
    })
    // Simulate a replica with a lagging clock: written later, sorts earlier.
    const skewedId = '00000000000000000000000001'
    expect(skewedId < first.id).toBe(true)
    await getDb().insertInto('authorization_model').values({
      id: skewedId,
      store_id: storeId,
      schema_version: '1.1',
      model: JSON.stringify({ schema_version: '1.1', type_definitions: [{ type: 'user' }, { type: 'doc' }] }),
    }).execute()
    expect((await getLatestAuthorizationModel(storeId))?.id).toBe(skewedId)
    expect(await getLatestAuthorizationModelId(storeId)).toBe(skewedId)
    expect((await listAuthorizationModels(storeId, 2)).map(m => m.id)).toEqual([skewedId, first.id])
    const page1 = await listAuthorizationModelsPage(storeId, 1)
    expect(page1.rows.map(m => m.id)).toEqual([skewedId])
    const page2 = await listAuthorizationModelsPage(storeId, 1, page1.next!)
    expect(page2.rows.map(m => m.id)).toEqual([first.id])
    expect(page2.next).toBeNull()
  })
})
