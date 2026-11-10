/**
 * Self-host bootstrap helper for `OPENFGA_MIGRATE_ON_START`.
 *
 * Wired into `src/server.ts` only. NOT imported from `src/index.ts`,
 * which is the Hono app file serverless hosts import — running migrations
 * as a side effect of every cold-start invocation would be wrong on
 * any platform where `index.ts` is treated as a per-request entry
 * (the `kysely_migration_lock` advisory lock would correctly serialize
 * runs, but every concurrent cold-start would still queue on it,
 * ballooning P99 latency on the request-serving hot path).
 *
 * Default is OFF. Operators who want migrations to run before sockets
 * bind opt in by setting OPENFGA_MIGRATE_ON_START=true. Anything other
 * than the strings `'true'` or `'false'` (case- and whitespace-tolerant)
 * is fatal at validation, mirroring `OPENFGA_HTTP_ENABLED`'s strict
 * boolean parsing — divergent boolean coercions across env vars is the
 * kind of inconsistency that bites in production.
 */
import { logger } from '../logger'
import { config } from '../config'
import { runMigrationsToLatest } from './migrator'

/**
 * Parse a raw OPENFGA_MIGRATE_ON_START string into a boolean.
 *
 * Retained for direct invocation by callers that have a raw env
 * string in hand (and by the existing unit test that exercises the
 * strict-bool grammar). Production code paths read the already-
 * parsed `config.migrateOnStart` boolean from the loaded config
 * instead, since the schema applies the same parser.
 */
export function parseMigrateOnStart(raw: string | undefined): boolean {
  const value = (raw ?? 'false').trim().toLowerCase()
  if (value !== 'true' && value !== 'false') {
    throw new Error(
      `OPENFGA_MIGRATE_ON_START must be "true" or "false"; got ${JSON.stringify(raw)}`,
    )
  }
  return value === 'true'
}

/**
 * If `OPENFGA_MIGRATE_ON_START=true`, apply all pending migrations
 * before returning. Throws on any migration failure — the caller is
 * expected to log and exit non-zero so the server never binds sockets
 * against a half-migrated database.
 *
 * Logging contract:
 *
 *   - DEBUG (always): one `migrate_on_start_state` line carrying the
 *     resolved boolean and the raw env value. Lets operators confirm
 *     which branch the boot took even when INFO is too noisy for an
 *     ops dashboard. Fires whether auto-migration was attempted or
 *     not.
 *   - INFO (attempted only): `migrate_on_start_attempt` before the
 *     migrator runs and `migrate_on_start_success` after it returns
 *     cleanly. Failure is intentionally not logged here — the throw
 *     propagates and `src/server.ts` records it at FATAL before
 *     exiting non-zero, so we avoid duplicate error events.
 */
export async function applyMigrationsOnStartIfEnabled(): Promise<void> {
  const enabled = config.migrateOnStart
  logger.debug(
    { migrateOnStart: enabled },
    enabled
      ? 'migrate_on_start_state: enabled — will run migrator.migrateToLatest() before binding sockets'
      : 'migrate_on_start_state: disabled — no migration will be attempted',
  )
  if (!enabled) return
  logger.info('migrate_on_start_attempt')
  await runMigrationsToLatest()
  logger.info('migrate_on_start_success')
}
