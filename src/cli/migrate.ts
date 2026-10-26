/**
 * Kysely-based migration runner. Replaces node-pg-migrate (openfga-g2j).
 *
 * Usage:
 *   pnpm migrate up      # apply all pending migrations
 *   pnpm migrate down    # roll back the most recent migration
 *
 * The migration file source lives under `migrations/*.ts`. The runner
 * uses Kysely's `Migrator` + `FileMigrationProvider` to discover and
 * apply them in lexicographic-by-filename order (the timestamps in
 * the filenames sort correctly as text).
 *
 * Tracking tables — Kysely's Migrator stores applied-migration state
 * in `kysely_migration` and a per-process advisory lock in
 * `kysely_migration_lock`. Both are namespaced by the configured
 * `OPENFGA_DB_NAMESPACE`:
 *
 *   Postgres → `<namespace>.kysely_migration`,
 *              `<namespace>.kysely_migration_lock`
 *   SQLite   → `<namespace>_kysely_migration`,
 *              `<namespace>_kysely_migration_lock`
 *
 * The Postgres path uses `migrationTableSchema`. The SQLite path
 * sets `migrationTableName` directly (no schema concept).
 *
 * Tracking tables are NodeFGA operational state. Upstream migration
 * requires explicit conversion; direct dump/restore is unsupported.
 */
import { type MigrationResultSet } from 'kysely'
// Importing `../config` triggers c12-backed .env loading via the
// configuration spec's `dotenv: true` option, replacing the previous
// `import 'dotenv/config'` side effect at the top of this file. The
// resetDb import below transitively requires `config.db.url` to be
// set, so the load also surfaces missing-config failures at the same
// fail-fast boundary as before.
import '../config'
import { resetDb } from '../storage/db'
import { buildMigrator } from '../storage/migrator'

function reportResults(direction: 'up' | 'down', { error, results }: MigrationResultSet): boolean {
  let ok = true
  if (results) {
    for (const r of results) {
      if (r.status === 'Success') {
        console.log('[migrate %s] ✓ %s', direction, r.migrationName)
      }
      else if (r.status === 'Error') {
        ok = false
        console.error('[migrate %s] ✗ %s failed', direction, r.migrationName)
      }
      else {
        console.log('[migrate %s] · %s (%s)', direction, r.migrationName, r.status)
      }
    }
  }
  if (error) {
    ok = false
    console.error('[migrate %s] error:', direction, error)
  }
  return ok
}

async function main(): Promise<void> {
  const direction = (process.argv[2] ?? 'up') as 'up' | 'down'
  if (direction !== 'up' && direction !== 'down') {
    console.error('Usage: pnpm migrate <up|down> (got %j)', direction)
    process.exit(2)
  }

  const migrator = buildMigrator()
  const result = direction === 'up'
    ? await migrator.migrateToLatest()
    : await migrator.migrateDown()
  const ok = reportResults(direction, result)
  await resetDb()
  process.exit(ok ? 0 : 1)
}

main().catch(async (err) => {
  console.error('[migrate] uncaught error:', err)
  await resetDb().catch(() => { /* swallow */ })
  process.exit(1)
})
