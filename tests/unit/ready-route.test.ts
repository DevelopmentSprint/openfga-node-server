/**
 * Unit tests for the GET /ready endpoint.
 *
 * The endpoint is auth-exempt (mirroring /health) and must:
 *
 *   - return 200 {status:'ok'} when the database is reachable and
 *     the configured namespace has the core tables.
 *   - return 503 {status:'unhealthy', reason:'schema_missing'} when
 *     the DB is reachable but the namespace is empty/incomplete.
 *   - return 503 {status:'unhealthy', reason:'db_unreachable'} when
 *     the readiness query throws.
 *   - never echo DSN, namespace, or driver detail in the response —
 *     the reason field is generic by contract.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { getDb, resetDb } from '../../src/storage/db'
import { buildApp } from '../../src/routes/index'
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

describe('GET /ready', () => {
  it('returns 503 schema_missing when the namespace has no tables', async () => {
    const app = buildApp()
    const res = await app.request('/ready')
    expect(res.status).toBe(503)
    const body = await res.json() as { status: string, reason: string }
    expect(body).toEqual({ status: 'unhealthy', reason: 'schema_missing' })
  })

  it('returns 200 ok after migrations have run', async () => {
    await migrateToLatest()
    const app = buildApp()
    const res = await app.request('/ready')
    expect(res.status).toBe(200)
    const body = await res.json() as { status: string }
    expect(body).toEqual({ status: 'ok' })
  })

  it('returns 503 db_unreachable when the database cannot be queried', async () => {
    process.env['OPENFGA_DB_URL'] = 'sqlite:/dev/null/openfga.db'
    await reloadConfigForTests()
    await resetDb()
    const app = buildApp()
    const res = await app.request('/ready')
    expect(res.status).toBe(503)
    const body = await res.json() as { status: string, reason: string }
    expect(body).toEqual({ status: 'unhealthy', reason: 'db_unreachable' })
  })

  it('returns 503 schema_outdated with a generic body when a migration is unapplied', async () => {
    await migrateToLatest()
    await sql`delete from openfga_kysely_migration where name = '1794300100000_read-and-model-indexes'`.execute(getDb())
    const app = buildApp()
    const res = await app.request('/ready')
    expect(res.status).toBe(503)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ status: 'unhealthy', reason: 'schema_outdated' })
    expect(text).not.toContain('read-and-model-indexes')
  })

  it('does not require authentication (auth-exempt like /health)', async () => {
    // Set the auth mode to shared_key so the auth middleware would
    // reject unauthenticated /stores/* calls. /ready must still answer.
    const savedMode = process.env['OPENFGA_AUTH_MODE']
    const savedKeys = process.env['OPENFGA_AUTH_PRESHARED_KEYS']
    process.env['OPENFGA_AUTH_MODE'] = 'preshared'
    process.env['OPENFGA_AUTH_PRESHARED_KEYS'] = 'secret'
    try {
      await migrateToLatest()
      const app = buildApp()
      const res = await app.request('/ready')
      expect(res.status).toBe(200)
    }
    finally {
      if (savedMode === undefined) delete process.env['OPENFGA_AUTH_MODE']
      else process.env['OPENFGA_AUTH_MODE'] = savedMode
      if (savedKeys === undefined) delete process.env['OPENFGA_AUTH_PRESHARED_KEYS']
      else process.env['OPENFGA_AUTH_PRESHARED_KEYS'] = savedKeys
    }
  })

  it('does not echo DSN or schema details in the 503 body', async () => {
    process.env['OPENFGA_DB_NAMESPACE'] = 'something_distinctive_xyz'
    await resetDb()
    const app = buildApp()
    const res = await app.request('/ready')
    expect(res.status).toBe(503)
    const text = await res.text()
    expect(text).not.toContain('something_distinctive_xyz')
    expect(text).not.toContain(':memory:')
    expect(text).not.toContain('sqlite')
  })
})
