/**
 * Optional durable write fences (openfga-pzm.4,
 * docs/features/write-fences.md). Runs on SQLite (`integration`) and
 * Postgres (`integration-pg`); the lock-handoff, zero-row-UPDATE race
 * and retry tests are Postgres-only because they need concurrent
 * connections, row locks and SQLSTATE retries.
 */
import { sql } from 'kysely'
import type { Hono } from 'hono'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/routes/index'
import { createStore } from '../../src/storage/stores'
import { writeAuthorizationModel } from '../../src/storage/authorization-models'
import { applyTupleMutations, readTuples } from '../../src/storage/tuples'
import { inStoreMutationTransaction, lockStoreForMutation } from '../../src/storage/store-mutation'
import { acquireWriteFence, WriteFenceError } from '../../src/storage/write-fences'
import { getDb, getNamespace } from '../../src/storage/db'
import { reloadConfigForTests } from '../../src/config'
import { bootstrapIntegrationDb } from '../_helpers/integration-bootstrap'

const bootstrap = await bootstrapIntegrationDb()
afterAll(() => bootstrap.teardown())
const describeIfDb = bootstrap.ready ? describe : describe.skip
const isPg = bootstrap.dialect === 'postgres'

const tuple = { user: 'user:alice', relation: 'viewer', object: 'doc:one' }
const MODEL = {
  schema_version: '1.1',
  type_definitions: [
    { type: 'user' },
    { type: 'doc', relations: { viewer: { this: {} } }, metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'user' }] } } } },
  ],
}
const JSON_HEADERS = { 'Content-Type': 'application/json' }

async function enable(extra: Record<string, unknown> = {}): Promise<Hono> {
  await reloadConfigForTests({ overrides: { writeFences: { enabled: true }, ...extra } })
  return buildApp()
}

async function setup() {
  const store = await createStore(`fenced-${Math.random().toString(36).slice(2, 8)}`)
  const model = await writeAuthorizationModel(store.id, MODEL)
  return { id: store.id, modelId: model.id, expiry: new Date(Date.now() + 60_000).toISOString() }
}

function acquire(app: Hono, storeId: string, key: string, generation: string, notAfter: string, headers: Record<string, string> = {}) {
  return app.request(`/x-ext/stores/${storeId}/write-fences/${key}`, {
    method: 'PUT',
    headers: { ...JSON_HEADERS, ...headers },
    body: JSON.stringify({ generation, not_after: notAfter }),
  })
}

function write(app: Hono, storeId: string, modelId: string, headers: Record<string, string>, t = tuple) {
  return app.request(`/stores/${storeId}/write`, {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...headers },
    body: JSON.stringify({ authorization_model_id: modelId, writes: { tuple_keys: [t] } }),
  })
}

function fenced(key: string, generation: string, notAfter: string): Record<string, string> {
  return { 'X-Write-Fence-Key': key, 'X-Write-Fence-Generation': generation, 'X-Not-After': notAfter }
}

async function changeCount(storeId: string): Promise<number> {
  return (await getDb().selectFrom('tuple_change').select('id').where('store_id', '=', storeId).execute()).length
}

async function waitFor(predicate: () => Promise<boolean>, attempts = 300, delayMs = 10): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, delayMs))
  }
  return false
}

describeIfDb('durable write fences', () => {
  afterEach(async () => { await reloadConfigForTests() })

  describe('disabled (default)', () => {
    it('does not mount the acquisition route and answers with the JSON undefined_endpoint 404', async () => {
      await reloadConfigForTests()
      const app = buildApp()
      const { id, expiry } = await setup()
      const res = await acquire(app, id, 'queue-one', '1', expiry)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ code: 'undefined_endpoint', message: 'Endpoint not enabled' })
    })

    it('ignores fence headers on /write entirely, including malformed and stale ones', async () => {
      await reloadConfigForTests()
      const app = buildApp()
      const { id, modelId } = await setup()
      const past = new Date(0).toISOString()
      expect((await write(app, id, modelId, fenced('never-acquired', '7', past))).status).toBe(200)
      expect((await write(app, id, modelId, { 'X-Write-Fence-Key': '!!', 'X-Not-After': 'garbage' }, { ...tuple, user: 'user:bob' })).status).toBe(200)
      expect(await readTuples(id, {})).toHaveLength(2)
      expect(await getDb().selectFrom('write_fence').select('key').where('store_id', '=', id).execute()).toEqual([])
    })
  })

  describe('enabled', () => {
    it('leaves standard writes without fence headers unchanged', async () => {
      const app = await enable()
      const { id, modelId } = await setup()
      expect((await write(app, id, modelId, {})).status).toBe(200)
      const dup = await write(app, id, modelId, {})
      expect(dup.status).toBe(400)
      expect(await dup.json()).toMatchObject({ code: 'write_failed_due_to_invalid_input' })
      expect(await changeCount(id)).toBe(1)
    })

    it('answers unknown /x-ext paths with the JSON 404 envelope', async () => {
      const app = await enable()
      const res = await app.request('/x-ext/unknown', { method: 'GET' })
      expect(res.status).toBe(404)
      expect(await res.json()).toMatchObject({ code: 'undefined_endpoint' })
    })

    it('runs acquisition through auth and the store-existence check', async () => {
      const app = await enable({ auth: { mode: 'preshared', presharedKeys: ['fixture-key'] } })
      const { id, expiry } = await setup()
      expect((await acquire(app, id, 'queue-one', '1', expiry)).status).toBe(401)
      const auth = { Authorization: 'Bearer fixture-key' }
      const missing = await acquire(app, '01ARZ3NDEKTSV4RRFFQ69G5FAV', 'queue-one', '1', expiry, auth)
      expect(missing.status).toBe(404)
      expect(await missing.json()).toMatchObject({ code: 'store_id_not_found' })
      const ok = await acquire(app, id, 'queue-one', '1', expiry, auth)
      expect(ok.status).toBe(200)
      expect(await ok.json()).toEqual({ key: 'queue-one', generation: '1', not_after: expiry })
    })

    it('rejects malformed acquisition requests and fence headers with 400 validation_error', async () => {
      const app = await enable()
      const { id, modelId, expiry } = await setup()
      for (const generation of ['0', '01', '-1', '1.0', ' 1', '9223372036854775808', 'invalid', '']) {
        const res = await acquire(app, id, 'queue-one', generation, expiry)
        expect(res.status, generation).toBe(400)
        expect(await res.json()).toMatchObject({ code: 'validation_error' })
      }
      for (const notAfter of ['tomorrow', '2030-01-01', '2030-01-01T00:00:00+01:00']) {
        expect((await acquire(app, id, 'queue-one', '1', notAfter)).status, notAfter).toBe(400)
      }
      expect((await acquire(app, id, '-leading-dash', '1', expiry)).status).toBe(400)
      expect((await acquire(app, id, 'x'.repeat(129), '1', expiry)).status).toBe(400)
      const extra = await app.request(`/x-ext/stores/${id}/write-fences/queue-one`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ generation: '1', not_after: expiry, other: 1 }) })
      expect(extra.status).toBe(400)

      expect((await acquire(app, id, 'queue-one', '9223372036854775807', expiry)).status).toBe(200)
      for (const headers of [
        { 'X-Write-Fence-Key': 'queue-one' },
        { 'X-Write-Fence-Generation': '1' },
        { 'X-Write-Fence-Key': 'queue-one', 'X-Write-Fence-Generation': '9223372036854775807' },
        { 'X-Not-After': 'invalid' },
        fenced('queue one', '1', expiry),
        fenced('queue-one', '01', expiry),
        fenced('queue-one', '9223372036854775808', expiry),
      ]) {
        const res = await write(app, id, modelId, headers)
        expect(res.status, JSON.stringify(headers)).toBe(400)
        expect(await res.json()).toEqual({ code: 'validation_error', message: 'invalid write fence headers' })
      }
      expect(await readTuples(id, {})).toHaveLength(0)
    })

    it('refuses expired arrivals with 409 write_deadline_exceeded and no mutation', async () => {
      const app = await enable()
      const { id, modelId, expiry } = await setup()
      const past = new Date(Date.now() - 1000).toISOString()
      const late = await write(app, id, modelId, { 'X-Not-After': past })
      expect(late.status).toBe(409)
      expect(await late.json()).toMatchObject({ code: 'write_deadline_exceeded' })
      const lateAcquire = await acquire(app, id, 'queue-one', '1', past)
      expect(lateAcquire.status).toBe(409)
      expect(await lateAcquire.json()).toMatchObject({ code: 'write_deadline_exceeded' })
      expect((await acquire(app, id, 'queue-one', '1', expiry)).status).toBe(200)
      expect((await write(app, id, modelId, fenced('queue-one', '1', past))).status).toBe(409)
      expect(await readTuples(id, {})).toHaveLength(0)
      expect(await changeCount(id)).toBe(0)
      // A standalone not-after in the future is a valid deadline-only write.
      expect((await write(app, id, modelId, { 'X-Not-After': expiry })).status).toBe(200)
    })

    it('caps the requested deadline with the stored lease expiry', async () => {
      const app = await enable()
      const { id, modelId } = await setup()
      const shortLease = new Date(Date.now() + 300).toISOString()
      expect((await acquire(app, id, 'queue-one', '1', shortLease)).status).toBe(200)
      await new Promise(resolve => setTimeout(resolve, 400))
      const res = await write(app, id, modelId, fenced('queue-one', '1', new Date(Date.now() + 60_000).toISOString()))
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ code: 'write_deadline_exceeded' })
      expect(await readTuples(id, {})).toHaveLength(0)
    })

    it('rolls back tuple and change-log mutations when the deadline passes mid-transaction', async () => {
      const { id, expiry } = await setup()
      await acquireWriteFence(id, { key: 'queue-one', generation: '1' }, expiry)
      // The clock reads "late" from the third check onwards: admission
      // and the post-lock checks pass, the pre-commit check fails.
      for (const fence of [undefined, { key: 'queue-one', generation: '1' }]) {
        let calls = 0
        const deadline = { notAfter: Date.now() + 60_000, now: () => (++calls > 2 ? Date.now() + 120_000 : Date.now()) }
        await expect(applyTupleMutations(id, { writes: [tuple], deletes: [], onDuplicate: 'error', onMissing: 'error', deadline, fence }))
          .rejects.toMatchObject({ code: 'write_deadline_exceeded' })
        expect(calls).toBeGreaterThanOrEqual(3)
      }
      expect(await readTuples(id, {})).toHaveLength(0)
      expect(await changeCount(id)).toBe(0)
    })

    it('advances generations numerically and refuses superseded or unacquired writers', async () => {
      const app = await enable()
      const { id, modelId, expiry } = await setup()
      expect((await write(app, id, modelId, fenced('queue-one', '1', expiry))).status).toBe(409)
      expect((await acquire(app, id, 'queue-one', '9', expiry)).status).toBe(200)
      // '10' < '9' as text; numerically it is the successor.
      expect((await acquire(app, id, 'queue-one', '10', expiry)).status).toBe(200)
      const stale = await acquire(app, id, 'queue-one', '9', expiry)
      expect(stale.status).toBe(409)
      expect(await stale.json()).toMatchObject({ code: 'write_fence_rejected' })
      const rejected = await write(app, id, modelId, fenced('queue-one', '9', expiry))
      expect(rejected.status).toBe(409)
      expect(await rejected.json()).toMatchObject({ code: 'write_fence_rejected' })
      expect(await readTuples(id, {})).toHaveLength(0)
      expect((await write(app, id, modelId, fenced('queue-one', '10', expiry))).status).toBe(200)
      expect(await readTuples(id, {})).toHaveLength(1)
      expect(await changeCount(id)).toBe(1)
    })

    it('keeps the expiry of a generation immutable: identical retry succeeds, a changed expiry is refused', async () => {
      const app = await enable()
      const { id, expiry } = await setup()
      expect((await acquire(app, id, 'queue-one', '1', expiry)).status).toBe(200)
      const retry = await acquire(app, id, 'queue-one', '1', expiry)
      expect(retry.status).toBe(200)
      expect(await retry.json()).toEqual({ key: 'queue-one', generation: '1', not_after: expiry })
      const renewed = await acquire(app, id, 'queue-one', '1', new Date(Date.parse(expiry) + 1).toISOString())
      expect(renewed.status).toBe(409)
      expect(await renewed.json()).toMatchObject({ code: 'write_fence_rejected' })
      const row = await getDb().selectFrom('write_fence').selectAll().where('store_id', '=', id).executeTakeFirstOrThrow()
      expect(row).toMatchObject({ key: 'queue-one', generation: '1', not_after: expiry })
    })

    it('isolates fences per store and per key', async () => {
      const app = await enable()
      const a = await setup()
      const b = await setup()
      expect((await acquire(app, a.id, 'queue-one', '5', a.expiry)).status).toBe(200)
      expect((await write(app, b.id, b.modelId, fenced('queue-one', '5', a.expiry))).status).toBe(409)
      expect((await write(app, a.id, a.modelId, fenced('queue-two', '5', a.expiry))).status).toBe(409)
      expect((await acquire(app, b.id, 'queue-one', '1', b.expiry)).status).toBe(200)
      expect((await write(app, b.id, b.modelId, fenced('queue-one', '1', b.expiry))).status).toBe(200)
      expect((await write(app, a.id, a.modelId, fenced('queue-one', '5', a.expiry))).status).toBe(200)
    })

    it('does not let an idempotent replay bypass a superseded generation or an expired deadline', async () => {
      const app = await enable({ idempotency: { mode: 'optional' } })
      const { id, modelId, expiry } = await setup()
      await acquireWriteFence(id, { key: 'queue-one', generation: '1' }, expiry)
      const request = (generation: string, notAfter = expiry) =>
        write(app, id, modelId, { 'Idempotency-Key': `fenced-replay-${id}`, ...fenced('queue-one', generation, notAfter) })
      expect((await request('1')).status).toBe(200)
      await acquireWriteFence(id, { key: 'queue-one', generation: '2' }, expiry)
      const stale = await request('1')
      expect(stale.status).toBe(409)
      expect(await stale.json()).toMatchObject({ code: 'write_fence_rejected' })
      const late = await request('2', new Date(Date.now() - 1000).toISOString())
      expect(late.status).toBe(409)
      expect(await late.json()).toMatchObject({ code: 'write_deadline_exceeded' })
      // The current generation may receive the cached 2xx of the
      // mutation that already committed; no second mutation happens.
      expect((await request('2')).status).toBe(200)
      expect(await changeCount(id)).toBe(1)
    })

    it('rechecks the original deadline after waiting for the store write lock', async () => {
      const { id, expiry } = await setup()
      await acquireWriteFence(id, { key: 'queue-one', generation: '1' }, expiry)
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      let locked!: () => void
      const holding = new Promise<void>((resolve) => { locked = resolve })
      // Holds the per-store advisory lock (Postgres) / the connection
      // and write transaction (SQLite) until released.
      const blocker = inStoreMutationTransaction(async (trx) => {
        await lockStoreForMutation(trx, id)
        locked()
        await gate
      })
      await holding
      const pending = applyTupleMutations(id, {
        writes: [tuple], deletes: [], onDuplicate: 'error', onMissing: 'error',
        fence: { key: 'queue-one', generation: '1' },
        deadline: { notAfter: Date.now() + 250 },
      }).then(() => 'accepted', (error: unknown) => error)
      await new Promise(resolve => setTimeout(resolve, 500))
      release()
      await blocker
      expect(await pending).toMatchObject({ code: 'write_deadline_exceeded' })
      expect(await readTuples(id, {})).toHaveLength(0)
      expect(await changeCount(id)).toBe(0)
    })
  })

  describe.skipIf(!isPg)('Postgres concurrency', () => {
    it('makes a successor acquisition wait for an older in-flight fenced write, then rejects the predecessor', async () => {
      const app = await enable()
      const { id, modelId, expiry } = await setup()
      const ns = getNamespace()
      await acquireWriteFence(id, { key: 'queue-one', generation: '1' }, expiry)
      await sql.raw(`create function ${ns}.pzm4_slow_tuple() returns trigger language plpgsql as $$ begin if NEW.object_id = 'slow' then perform pg_sleep(0.6); end if; return NEW; end $$`).execute(getDb())
      await sql.raw(`create trigger pzm4_slow_tuple before insert on ${ns}.tuple for each row execute function ${ns}.pzm4_slow_tuple()`).execute(getDb())
      try {
        const older = write(app, id, modelId, fenced('queue-one', '1', expiry), { ...tuple, object: 'doc:slow' })
        expect(await waitFor(async () => {
          const r = await sql<{ n: number }>`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event = 'PgSleep'`.execute(getDb())
          return r.rows[0]!.n > 0
        })).toBe(true)
        let granted = false
        const successor = acquireWriteFence(id, { key: 'queue-one', generation: '2' }, expiry).then((r) => { granted = true; return r })
        expect(await waitFor(async () => {
          const r = await sql<{ n: number }>`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`.execute(getDb())
          return r.rows[0]!.n > 0
        })).toBe(true)
        expect(granted).toBe(false)
        // The older write started under generation 1 before takeover and commits.
        expect((await older).status).toBe(200)
        await successor
        expect(granted).toBe(true)
        const after = await write(app, id, modelId, fenced('queue-one', '1', expiry), { ...tuple, object: 'doc:after' })
        expect(after.status).toBe(409)
        expect(await after.json()).toMatchObject({ code: 'write_fence_rejected' })
        await expect(applyTupleMutations(id, { writes: [{ ...tuple, object: 'doc:direct' }], deletes: [], onDuplicate: 'error', onMissing: 'error', fence: { key: 'queue-one', generation: '1' }, deadline: { notAfter: Date.parse(expiry) } }))
          .rejects.toBeInstanceOf(WriteFenceError)
        expect((await readTuples(id, {})).map(t => t.object_id)).toEqual(['slow'])
      }
      finally {
        await sql.raw(`drop trigger pzm4_slow_tuple on ${ns}.tuple`).execute(getDb())
        await sql.raw(`drop function ${ns}.pzm4_slow_tuple()`).execute(getDb())
      }
    })

    it('refuses a fence row that appears after its UPDATE locked no row (negative control for the row-count guard)', async () => {
      const { id, expiry } = await setup()
      const ns = getNamespace()
      await sql.raw(`create function ${ns}.pzm4_pause_empty_fence_update() returns trigger language plpgsql as $$ begin if not exists (select 1 from changed_fences) then perform pg_sleep(0.4); end if; return null; end $$`).execute(getDb())
      await sql.raw(`create trigger pzm4_pause_empty_fence_update after update on ${ns}.write_fence referencing new table as changed_fences for each statement execute function ${ns}.pzm4_pause_empty_fence_update()`).execute(getDb())
      let pending: Promise<unknown> | undefined
      try {
        pending = applyTupleMutations(id, {
          writes: [tuple], deletes: [], onDuplicate: 'error', onMissing: 'error',
          fence: { key: 'raced-queue', generation: '1' }, deadline: { notAfter: Date.parse(expiry) },
        }).then(() => 'accepted', (error: unknown) => error)
        expect(await waitFor(async () => {
          const r = await sql<{ n: number }>`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event = 'PgSleep' and query like '%write_fence%'`.execute(getDb())
          return r.rows[0]!.n > 0
        })).toBe(true)
        // Another connection makes generation 1 visible while the
        // writer's UPDATE has already matched (and locked) nothing.
        // Without the affected-row-count guard the writer's following
        // READ COMMITTED read would see it and accept an unlocked fence.
        await getDb().insertInto('write_fence').values({ store_id: id, key: 'raced-queue', generation: '1', not_after: expiry }).execute()
        expect(await pending).toBeInstanceOf(WriteFenceError)
        expect(await readTuples(id, {})).toHaveLength(0)
      }
      finally {
        if (pending) await pending
        await sql.raw(`drop trigger pzm4_pause_empty_fence_update on ${ns}.write_fence`).execute(getDb())
        await sql.raw(`drop function ${ns}.pzm4_pause_empty_fence_update()`).execute(getDb())
      }
    })

    it('rechecks the original deadline on a retry attempt and never restarts it', async () => {
      const { id, expiry } = await setup()
      const ns = getNamespace()
      await acquireWriteFence(id, { key: 'queue-one', generation: '1' }, expiry)
      await sql.raw(`create sequence ${ns}.pzm4_attempts`).execute(getDb())
      // First insert attempt: wait, then fail with a retryable deadlock
      // SQLSTATE. Sequences are not transactional, so the counter
      // survives the rollback.
      await sql.raw(`create function ${ns}.pzm4_deadlock_once() returns trigger language plpgsql as $$ begin if nextval('${ns}.pzm4_attempts') = 1 then perform pg_sleep(0.3); raise exception 'injected deadlock' using errcode = '40P01'; end if; return NEW; end $$`).execute(getDb())
      await sql.raw(`create trigger pzm4_deadlock_once before insert on ${ns}.tuple for each row execute function ${ns}.pzm4_deadlock_once()`).execute(getDb())
      const attempts = async () => (await sql<{ n: string }>`select last_value::text as n from ${sql.raw(`${ns}.pzm4_attempts`)}`.execute(getDb())).rows[0]!.n
      try {
        const mutation = (notAfter: number, object: string) => applyTupleMutations(id, {
          writes: [{ ...tuple, object }], deletes: [], onDuplicate: 'error', onMissing: 'error',
          fence: { key: 'queue-one', generation: '1' }, deadline: { notAfter },
        })
        // Deadline passes during the failed first attempt: the retry is refused.
        await expect(mutation(Date.now() + 150, 'doc:late')).rejects.toMatchObject({ code: 'write_deadline_exceeded' })
        expect(await attempts()).toBe('1')
        expect(await readTuples(id, {})).toHaveLength(0)
        // Control: with a generous deadline the retry succeeds.
        await sql.raw(`alter sequence ${ns}.pzm4_attempts restart`).execute(getDb())
        await mutation(Date.now() + 30_000, 'doc:retried')
        expect(await attempts()).toBe('2')
        expect((await readTuples(id, {})).map(t => t.object_id)).toEqual(['retried'])
      }
      finally {
        await sql.raw(`drop trigger pzm4_deadlock_once on ${ns}.tuple`).execute(getDb())
        await sql.raw(`drop function ${ns}.pzm4_deadlock_once()`).execute(getDb())
        await sql.raw(`drop sequence ${ns}.pzm4_attempts`).execute(getDb())
      }
    })
  })
})
