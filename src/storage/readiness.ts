/**
 * Engine-agnostic readiness check used by `GET /ready`.
 *
 * Distinguishes two failure modes operators care about:
 *
 *   - `db_unreachable` — the readiness query itself threw. Network,
 *     auth, DSN, or driver-level problem.
 *   - `schema_outdated` — every core table exists but at least one
 *     migration bundled with this build is not recorded in the
 *     namespaced `kysely_migration` table (replica running ahead of
 *     the database schema).
 *   - `schema_missing` — the query succeeded but at least one of the
 *     core namespaced tables is absent. Operator forgot to run
 *     migrations, or `OPENFGA_DB_NAMESPACE` points at an empty schema.
 *
 * `kysely_migration` is included in the core set on purpose — its
 * absence is the cleanest signal that no migration has ever run
 * against the configured namespace, which is the common production
 * misconfiguration this probe was added to catch.
 *
 * The probe uses one round-trip per call — Postgres `to_regclass(text)`
 * over the four qualified names; SQLite `sqlite_master` `IN`-list. Both
 * are catalog lookups so the readiness path never contends with
 * application traffic for connections beyond a single short query.
 */
import { sql } from 'kysely'
import { MIGRATIONS } from '../cli/migrations-bundle'
import { getDb, getDialect, getNamespace } from './db'

const CORE_TABLES = ['store', 'authorization_model', 'tuple', 'kysely_migration'] as const
type CoreTable = (typeof CORE_TABLES)[number]

export type ReadinessReason = 'db_unreachable' | 'schema_missing' | 'schema_outdated'

export interface ReadinessResult {
  ok: boolean
  /** Set when `ok` is false. */
  reason?: ReadinessReason
  /** Tables the probe expected to find but didn't. Set when reason is `schema_missing`. */
  missing?: CoreTable[]
  /** Bundled migrations not yet applied. Set when reason is `schema_outdated`. For logs only. */
  pending?: string[]
  /** Underlying driver error when reason is `db_unreachable`. For logs only; never put in a response. */
  error?: unknown
}

/** Names of bundled migrations absent from the applied set, in bundle order. */
function pendingMigrations(applied: Set<string>): string[] {
  return Object.keys(MIGRATIONS).sort().filter(name => !applied.has(name))
}

/**
 * Raw SQL bypasses Kysely plugins (TablePrefixPlugin, withSchema), so
 * the namespace is composed into the literal table reference here.
 * The namespace is validated against `/^[a-z][a-z0-9_]{0,62}$/` by
 * `getNamespace()` so it cannot contain quotes, semicolons, or other
 * SQL metacharacters — composing it into the literal is safe.
 */
export async function checkReadiness(): Promise<ReadinessResult> {
  // getNamespace / getDialect / getDb can all throw synchronously
  // (bad env, unopenable SQLite path, pg.Pool construction error)
  // before any query is issued — they belong inside the try too, or
  // the readiness route would surface a 500 instead of a structured
  // 503 db_unreachable.
  try {
    const ns = getNamespace()
    const dialect = getDialect()
    const db = getDb()

    if (dialect === 'postgres') {
      const result = await sql<Record<CoreTable, boolean>>`
        select
          to_regclass(${`${ns}.store`}) is not null as store,
          to_regclass(${`${ns}.authorization_model`}) is not null as authorization_model,
          to_regclass(${`${ns}.tuple`}) is not null as tuple,
          to_regclass(${`${ns}.kysely_migration`}) is not null as kysely_migration
      `.execute(db)
      const row = result.rows[0]
      if (!row) return { ok: false, reason: 'db_unreachable' }
      const missing = CORE_TABLES.filter(t => row[t] !== true)
      if (missing.length > 0) return { ok: false, reason: 'schema_missing', missing }
      const applied = await sql<{ name: string }>`
        select name from ${sql.id(ns, 'kysely_migration')}
      `.execute(db)
      const pending = pendingMigrations(new Set(applied.rows.map(r => r.name)))
      if (pending.length > 0) return { ok: false, reason: 'schema_outdated', pending }
      return { ok: true }
    }

    const expected = CORE_TABLES.map(t => `${ns}_${t}`)
    const result = await sql<{ name: string }>`
      select name from sqlite_master
      where type = 'table'
        and name in (
          ${sql.join(expected.map(n => sql`${n}`))}
        )
    `.execute(db)
    const present = new Set(result.rows.map(r => r.name))
    const missing = CORE_TABLES.filter(t => !present.has(`${ns}_${t}`))
    if (missing.length > 0) return { ok: false, reason: 'schema_missing', missing }
    const applied = await sql<{ name: string }>`
      select name from ${sql.id(`${ns}_kysely_migration`)}
    `.execute(db)
    const pending = pendingMigrations(new Set(applied.rows.map(r => r.name)))
    if (pending.length > 0) return { ok: false, reason: 'schema_outdated', pending }
    return { ok: true }
  }
  catch (error) {
    return { ok: false, reason: 'db_unreachable', error }
  }
}
