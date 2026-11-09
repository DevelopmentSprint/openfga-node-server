/**
 * Unit tests for `engine-context.ts` — the wiring layer between the
 * storage repositories and the evaluator's `TupleStore` interface.
 *
 * Covers:
 *   - loadModelIndex pinning to a specific model id
 *   - loadModelIndex falling back to the latest model when id is undefined
 *   - loadModelIndex returning null when neither resolves
 *   - the per-store ModelIndex cache (second call hits the cache)
 *   - clearModelCache resetting the cache
 *   - pgTupleStore wraps the three evaluator helpers
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sql } from 'kysely'
import { getDb, resetDb } from '../../src/storage/db'
import { createStore } from '../../src/storage/stores'
import * as models from '../../src/storage/authorization-models'
import { writeAuthorizationModel } from '../../src/storage/authorization-models'
import { writeTuples } from '../../src/storage/tuples'
import { clearModelCache, loadModelIndex, pgTupleStore } from '../../src/storage/engine-context'
import { migrateToLatest } from '../_helpers/sqlite-bootstrap'

async function stampModelCreatedAt(modelId: string, ts: string): Promise<void> {
  await sql`update openfga_authorization_model set created_at = ${ts} where id = ${modelId}`.execute(getDb())
}

const ENV_KEYS = ['OPENFGA_DB_URL', 'OPENFGA_DB_NAMESPACE'] as const
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

beforeEach(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  await resetDb()
  delete process.env['OPENFGA_DB_NAMESPACE']
  await migrateToLatest()
  clearModelCache()
})

afterEach(async () => {
  vi.restoreAllMocks()
  clearModelCache()
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  await resetDb()
})

describe('loadModelIndex', () => {
  it('returns null when the store has no models and no id is pinned', async () => {
    const store = await createStore('s')
    expect(await loadModelIndex(store.id, undefined)).toBeNull()
  })

  it('returns null when a pinned model id does not exist', async () => {
    const store = await createStore('s')
    expect(await loadModelIndex(store.id, '01ABCDEFGHIJKLMNOPQRSTUVWX')).toBeNull()
  })

  it('returns the latest model when no id is pinned', async () => {
    const store = await createStore('s')
    const m1 = await writeAuthorizationModel(store.id, {
      schema_version: '1.1',
      type_definitions: [{ type: 'user' }],
    })
    await stampModelCreatedAt(m1.id, '2026-01-01T00:00:00.001Z')
    const m2 = await writeAuthorizationModel(store.id, {
      schema_version: '1.1',
      type_definitions: [{ type: 'user' }, { type: 'doc' }],
    })
    await stampModelCreatedAt(m2.id, '2026-01-01T00:00:00.002Z')
    const ctx = await loadModelIndex(store.id, undefined)
    expect(ctx?.modelId).toBe(m2.id)
  })

  it('honors a pinned model id even when newer models exist', async () => {
    const store = await createStore('s')
    const m1 = await writeAuthorizationModel(store.id, {
      schema_version: '1.1',
      type_definitions: [{ type: 'user' }],
    })
    await stampModelCreatedAt(m1.id, '2026-01-01T00:00:00.001Z')
    const m2 = await writeAuthorizationModel(store.id, {
      schema_version: '1.1',
      type_definitions: [{ type: 'user' }, { type: 'doc' }],
    })
    await stampModelCreatedAt(m2.id, '2026-01-01T00:00:00.002Z')
    const ctx = await loadModelIndex(store.id, m1.id)
    expect(ctx?.modelId).toBe(m1.id)
  })

  it('caches the ModelIndex by (storeId, modelId)', async () => {
    const store = await createStore('s')
    const model = await writeAuthorizationModel(store.id, {
      schema_version: '1.1',
      type_definitions: [{ type: 'user' }],
    })
    const a = await loadModelIndex(store.id, model.id)
    const b = await loadModelIndex(store.id, model.id)
    // Same instance returned on the second call.
    expect(a?.index).toBe(b?.index)
  })

  it('does not reread a pinned immutable model, including concurrent requests', async () => {
    const store = await createStore('s')
    const model = await writeAuthorizationModel(store.id, { schema_version: '1.1', type_definitions: [{ type: 'user' }] })
    const read = vi.spyOn(models, 'getAuthorizationModel')
    const contexts = await Promise.all(Array.from({ length: 10 }, () => loadModelIndex(store.id, model.id)))
    expect(read).toHaveBeenCalledTimes(1)
    expect(contexts.every(ctx => ctx?.index === contexts[0]?.index)).toBe(true)
    await loadModelIndex(store.id, model.id)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('resolves latest on every request but reads each immutable payload only once', async () => {
    const store = await createStore('s')
    const first = await writeAuthorizationModel(store.id, { schema_version: '1.1', type_definitions: [{ type: 'user' }] })
    const read = vi.spyOn(models, 'getAuthorizationModel')
    const latest = vi.spyOn(models, 'getLatestAuthorizationModelId')
    const old = await loadModelIndex(store.id, undefined)
    expect((await loadModelIndex(store.id, undefined))?.index).toBe(old?.index)
    expect(read).toHaveBeenCalledTimes(1)
    const second = await writeAuthorizationModel(store.id, { schema_version: '1.1', type_definitions: [{ type: 'user' }, { type: 'doc' }] })
    const current = await loadModelIndex(store.id, undefined)
    expect(current?.modelId).toBe(second.id)
    expect(current?.index.hasType('doc')).toBe(true)
    expect((await loadModelIndex(store.id, first.id))?.index).toBe(old?.index)
    expect(read).toHaveBeenCalledTimes(2)
    expect(latest).toHaveBeenCalledTimes(3)
  })

  it('isolates cached models by store', async () => {
    const a = await createStore('a')
    const b = await createStore('b')
    const model = await writeAuthorizationModel(a.id, { schema_version: '1.1', type_definitions: [{ type: 'user' }] })
    expect(await loadModelIndex(a.id, model.id)).not.toBeNull()
    expect(await loadModelIndex(b.id, model.id)).toBeNull()
  })

  it('retries failed loads rather than caching errors', async () => {
    const store = await createStore('s')
    const model = await writeAuthorizationModel(store.id, { schema_version: '1.1', type_definitions: [{ type: 'user' }] })
    const read = vi.spyOn(models, 'getAuthorizationModel').mockRejectedValueOnce(new Error('unavailable'))
    await expect(loadModelIndex(store.id, model.id)).rejects.toThrow('unavailable')
    expect(await loadModelIndex(store.id, model.id)).not.toBeNull()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('retries missing models rather than retaining negative cache entries', async () => {
    const store = await createStore('s')
    const read = vi.spyOn(models, 'getAuthorizationModel')
    expect(await loadModelIndex(store.id, 'missing')).toBeNull()
    expect(await loadModelIndex(store.id, 'missing')).toBeNull()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('does not repopulate the cache when an in-flight load crosses a reset', async () => {
    const store = await createStore('s')
    const model = await writeAuthorizationModel(store.id, { schema_version: '1.1', type_definitions: [{ type: 'user' }] })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const read = vi.spyOn(models, 'getAuthorizationModel').mockImplementationOnce(async () => {
      await gate
      return model
    })
    const pending = loadModelIndex(store.id, model.id)
    // loadModelIndex begins synchronously when tracing is disabled (test default).
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    clearModelCache()
    release()
    const old = await pending
    const fresh = await loadModelIndex(store.id, model.id)
    expect(read).toHaveBeenCalledTimes(2)
    expect(fresh?.index).not.toBe(old?.index)
  })

  it('clearModelCache forces a fresh ModelIndex on next load', async () => {
    const store = await createStore('s')
    const model = await writeAuthorizationModel(store.id, {
      schema_version: '1.1',
      type_definitions: [{ type: 'user' }],
    })
    const before = await loadModelIndex(store.id, model.id)
    clearModelCache()
    const after = await loadModelIndex(store.id, model.id)
    expect(after?.index).not.toBe(before?.index)
  })
})

describe('pgTupleStore', () => {
  it('exposes the three evaluator helpers scoped to a store', async () => {
    const store = await createStore('s')
    await writeTuples(store.id, [
      { user: 'user:alice', relation: 'viewer', object: 'doc:1' },
      { user: 'user:alice', relation: 'viewer', object: 'doc:2' },
      { user: 'user:bob', relation: 'editor', object: 'doc:1' },
    ])
    const ts = pgTupleStore(store.id)

    const users = await ts.listUsersForRelation('doc', '1', 'viewer')
    expect(users.sort()).toEqual(['user:alice'])

    const ids = await ts.listObjectIdsForUser('doc', 'viewer', 'user:alice')
    expect(ids.sort()).toEqual(['1', '2'])

    const all = await ts.listAllForRelation('doc', 'viewer')
    expect(all.map(p => `${p.object_id}/${p.user_str}`).sort())
      .toEqual(['1/user:alice', '2/user:alice'])
  })
})
