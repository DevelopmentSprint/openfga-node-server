import { sql } from 'kysely'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/routes/index'
import { createStore } from '../../src/storage/stores'
import { writeAuthorizationModel } from '../../src/storage/authorization-models'
import { applyTupleMutations, readTuples } from '../../src/storage/tuples'
import { acquireWriteFence, lockWriteFence, WriteFenceError } from '../../src/storage/write-fences'
import { getDb, getNamespace } from '../../src/storage/db'
import { reloadConfigForTests } from '../../src/config'
import { bootstrapIntegrationDb } from '../_helpers/integration-bootstrap'

const bootstrap = await bootstrapIntegrationDb()
afterAll(() => bootstrap.teardown())
const describeIfDb = bootstrap.ready ? describe : describe.skip

describeIfDb('durable write fences', () => {
  const tuple = { user: 'user:alice', relation: 'viewer', object: 'doc:one' }
  async function setup() {
    const store = await createStore('fenced-writes')
    const model = await writeAuthorizationModel(store.id, { schema_version: '1.1', type_definitions: [{ type: 'user' }, { type: 'doc', relations: { viewer: { this: {} } }, metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'user' }] } } } }] })
    return { app: buildApp(), id: store.id, modelId: model.id, expiry: new Date(Date.now() + 60000).toISOString() }
  }
  it('preserves legacy writes, rejects expired arrival and rolls back a deadline exceeded during mutation', async () => {
    const { app, id, modelId } = await setup()
    const body = { authorization_model_id: modelId, writes: { tuple_keys: [tuple] } }
    const late = await app.request(`/stores/${id}/write`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Not-After': new Date(0).toISOString() }, body: JSON.stringify(body) })
    expect(late.status).toBe(409)
    expect(await late.json()).toMatchObject({ code: 'write_deadline_exceeded' })
    expect(await readTuples(id, {})).toHaveLength(0)
    let calls = 0
    await expect(applyTupleMutations(id, { writes: [tuple], deletes: [], onDuplicate: 'ignore', onMissing: 'ignore', deadline: { notAfter: 100, now: () => ++calls > 2 ? 101 : 1 } })).rejects.toBeInstanceOf(WriteFenceError)
    expect(await readTuples(id, {})).toHaveLength(0)
    expect(await getDb().selectFrom('tuple_change').selectAll().where('store_id', '=', id).execute()).toHaveLength(0)
    expect((await app.request(`/stores/${id}/write`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status).toBe(200)
  })
  it('acquires monotonically, preserves retries and refuses stale generations or renewal under the same generation', async () => {
    const { app, id, modelId, expiry } = await setup()
    const acquire = (generation: string, notAfter = expiry) => app.request(`/stores/${id}/write-fences/queue-one`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ generation, not_after: notAfter }) })
    expect((await acquire('1')).status).toBe(200)
    expect((await acquire('1')).status).toBe(200)
    expect((await acquire('1', new Date(Date.parse(expiry) + 1).toISOString())).status).toBe(409)
    expect((await acquire('2')).status).toBe(200)
    expect((await acquire('1')).status).toBe(409)
    for (const generation of ['0', '01', '1\n', '9223372036854775808', 'invalid']) expect((await acquire(generation)).status).toBe(400)
    const write = (generation: string) => app.request(`/stores/${id}/write`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Write-Fence-Key': 'queue-one', 'X-Write-Fence-Generation': generation, 'X-Not-After': expiry }, body: JSON.stringify({ authorization_model_id: modelId, writes: { tuple_keys: [tuple] } }) })
    expect((await write('1')).status).toBe(409)
    expect(await readTuples(id, {})).toHaveLength(0)
    expect((await write('2')).status).toBe(200)
    expect((await acquire('3', new Date(0).toISOString())).status).toBe(409)
    for (const headers of [{ 'X-Write-Fence-Key': 'queue-one' }, { 'X-Write-Fence-Generation': '2' }, { 'X-Not-After': 'invalid' }]) {
      expect((await app.request(`/stores/${id}/write`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ writes: { tuple_keys: [tuple] } }) })).status).toBe(400)
    }
    const other = await setup()
    expect((await other.app.request(`/stores/${other.id}/write`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Write-Fence-Key': 'queue-one', 'X-Write-Fence-Generation': '2', 'X-Not-After': expiry }, body: JSON.stringify({ authorization_model_id: other.modelId, writes: { tuple_keys: [tuple] } }) })).status).toBe(409)
  })
  it('does not let idempotency replay bypass a superseded generation or an expired deadline', async () => {
    await reloadConfigForTests({ overrides: { idempotency: { mode: 'optional' } } })
    try {
      const { app, id, modelId, expiry } = await setup()
      await acquireWriteFence(id, { key: 'queue-one', generation: '1' }, expiry)
      const request = (generation: string, notAfter = expiry) => app.request(`/stores/${id}/write`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'fenced-replay', 'X-Write-Fence-Key': 'queue-one', 'X-Write-Fence-Generation': generation, 'X-Not-After': notAfter }, body: JSON.stringify({ authorization_model_id: modelId, writes: { tuple_keys: [tuple] } }) })
      expect((await request('1')).status).toBe(200)
      await acquireWriteFence(id, { key: 'queue-one', generation: '2' }, expiry)
      expect((await request('1')).status).toBe(409)
      expect((await request('2', new Date(0).toISOString())).status).toBe(409)
      expect((await request('2')).status).toBe(200)
    }
    finally { await reloadConfigForTests() }
  })
  it.skipIf(bootstrap.dialect !== 'postgres')('refuses a fence that appears after an UPDATE acquired no row lock', async () => {
    const { id, expiry } = await setup()
    const namespace = getNamespace()
    await sql.raw(`create function ${namespace}.pause_empty_fence_update() returns trigger language plpgsql as $$ begin if not exists (select 1 from changed_fences) then perform pg_sleep(0.3); end if; return null; end $$`).execute(getDb())
    await sql.raw(`create trigger pause_empty_fence_update after update on ${namespace}.write_fence referencing new table as changed_fences for each statement execute function ${namespace}.pause_empty_fence_update()`).execute(getDb())
    let pending: Promise<unknown> | undefined
    try {
      pending = applyTupleMutations(id, { writes: [tuple], deletes: [], onDuplicate: 'ignore', onMissing: 'ignore', fence: { key: 'new-queue', generation: '1' }, deadline: { notAfter: Date.parse(expiry) } }).then(() => 'accepted', error => error)
      let paused = false
      for (let attempt = 0; attempt < 200; attempt++) {
        const state = await sql<{ paused: number }>`select count(*)::int as paused from pg_stat_activity where datname = current_database() and wait_event = 'PgSleep' and query like '%write_fence%'`.execute(getDb())
        if (state.rows[0]!.paused > 0) { paused = true; break }
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      expect(paused).toBe(true)
      await acquireWriteFence(id, { key: 'new-queue', generation: '1' }, expiry)
      expect(await pending).toBeInstanceOf(WriteFenceError)
      expect(await readTuples(id, {})).toHaveLength(0)
    }
    finally {
      if (pending) await pending
      await sql.raw(`drop trigger pause_empty_fence_update on ${namespace}.write_fence`).execute(getDb())
      await sql.raw(`drop function ${namespace}.pause_empty_fence_update()`).execute(getDb())
    }
  })
  it.skipIf(bootstrap.dialect !== 'postgres')('waits for an older transaction to commit before granting its successor', async () => {
    const { id, expiry } = await setup()
    const first = { key: 'queue-one', generation: '1' }
    await acquireWriteFence(id, first, expiry)
    let entered!: () => void
    const locked = new Promise<void>(resolve => { entered = resolve })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const older = getDb().transaction().execute(async (trx) => {
      await lockWriteFence(trx, id, first, { notAfter: Date.parse(expiry) })
      entered()
      await gate
    })
    await locked
    let granted = false
    const successor = acquireWriteFence(id, { key: 'queue-one', generation: '2' }, expiry).then(result => { granted = true; return result })
    try {
      // A separate connection reaches the lock while the old transaction is paused.
      let waiting = false
      for (let attempt = 0; attempt < 200; attempt++) {
        const state = await sql<{ blocked: number }>`select count(*)::int as blocked from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%write_fence%'`.execute(getDb())
        if (state.rows[0]!.blocked > 0) { waiting = true; break }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(waiting).toBe(true)
      expect(granted).toBe(false)
    }
    finally { release() }
    await older
    await successor
    await expect(applyTupleMutations(id, { writes: [tuple], deletes: [], onDuplicate: 'ignore', onMissing: 'ignore', fence: first, deadline: { notAfter: Date.parse(expiry) } })).rejects.toBeInstanceOf(WriteFenceError)
    expect(await readTuples(id, {})).toHaveLength(0)
  })
})
