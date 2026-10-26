/**
 * Static migration bundle — used by both the production migrate CLI
 * (`src/cli/migrate.ts`) and the SQLite smoke tests
 * (`tests/unit/storage-tuples-idempotency.test.ts`).
 *
 * Why this exists: Kysely's `FileMigrationProvider` does a dynamic
 * `import()` on each migration file. Under tsx (the production CLI
 * entry point) those .ts files resolve fine, but under vitest's
 * runtime the dynamic-import chain can't follow the migrations'
 * internal `'../src/storage/db'` relative imports because the
 * migrations folder is outside the test include scope. Static
 * imports go through vite's transform layer in both runtimes, so
 * this bundle works everywhere.
 *
 * Order matters — the keys (timestamps) sort lexicographically into
 * the same order as the on-disk filenames the legacy
 * `FileMigrationProvider` would have discovered.
 */
import type { Migration, MigrationProvider } from 'kysely'
import * as initialSchema from '../../migrations/1777680000000_initial-openfga-schema'
import * as idempotencyKeys from '../../migrations/1777824000000_idempotency-keys'
import * as tupleChanges from '../../migrations/1777910400000_tuple-changes'
import * as assertions from '../../migrations/1777996800000_assertions'
import * as tupleChangeSeq from '../../migrations/1778083200000_tuple-change-seq'

import * as tupleConditions from '../../migrations/1793012400000_tuple-conditions'

export const MIGRATIONS: Record<string, Migration> = {
  '1777680000000_initial-openfga-schema': initialSchema,
  '1777824000000_idempotency-keys': idempotencyKeys,
  '1777910400000_tuple-changes': tupleChanges,
  '1777996800000_assertions': assertions,
  '1778083200000_tuple-change-seq': tupleChangeSeq,
  '1793012400000_tuple-conditions': tupleConditions,
}

export class StaticMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return MIGRATIONS
  }
}
