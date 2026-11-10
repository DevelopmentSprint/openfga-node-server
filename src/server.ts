/**
 * Self-hosted bootstrap for the OpenFGA-Node-Server.
 *
 * This file is the entrypoint for `pnpm dev` / `pnpm start` and any
 * bare-metal, container, or VM deployment. It binds TCP sockets via
 * `@hono/node-server`'s `serve()`, so it must NOT be imported by any
 * runtime that supplies its own request transport (e.g. a
 * serverless function host). The Hono app itself lives in `./index.ts`, which is what
 * such platforms import.
 *
 * Reads the resolved `config` (see `src/config.ts` and
 * `docs/features/configuration.md`) for db.url, listener config, TLS
 * paths, and the migrate-on-start gate. The schema in
 * `src/config-schema.ts` enforces validation and cross-field rules
 * (TLS pair-wise, port collision, no-listener-without-TLS) before
 * this file ever sees the configuration. The remaining
 * `requireDbUrl()` check covers the schema-optional `db.url` field at
 * bootstrap, since the server cannot start without a database.
 *
 * `.env` discovery and parsing now flows through c12 inside
 * `src/config.ts` (via `dotenv: true`), replacing the previous
 * `import 'dotenv/config'` side effect at the top of this file.
 */
import { readFileSync } from 'node:fs'
import { createServer as createHttpsServer } from 'node:https'
import { serve } from '@hono/node-server'
import app from './index'
import { logger } from './logger'
import { config } from './config'
import { applyMigrationsOnStartIfEnabled } from './storage/migrate-on-start'
import { closeDb, describeDb, requireDbUrl } from './storage/db'
import { checkReadiness } from './storage/readiness'
import { prefetchOidcJwks } from './middleware/oidc'
import { initOtelSdk, shutdownOtelSdk } from './observability/otel'
import { closeServers, createShutdownHandler, type ClosableServer } from './shutdown'

// Initialize OpenTelemetry SDK BEFORE any other module that might
// participate in tracing. No-op when config.otel.enabled is false —
// the SDK is never imported in that path. Failure (bad exporter
// URL, unsupported propagator) is fatal at boot.
try {
  await initOtelSdk()
}
catch (err) {
  logger.fatal({ err, reason: 'otel_setup_failed' }, 'otel_setup_failed; refusing to start')
  process.exit(1)
}

try {
  requireDbUrl(config.db.url)
}
catch (err) {
  logger.fatal({ err }, 'required configuration not set; refusing to start')
  process.exit(1)
}

// When OIDC auth is enabled, resolve issuer discovery + JWKS BEFORE
// binding any listener. A misconfigured issuer (typo, network
// partition, unpublished `.well-known/openid-configuration`) must
// surface as a FATAL boot log rather than as 401s on every
// authenticated request. The Hono middleware factory has its own
// lazy promise for non-server callers, but the production boot path
// is intentionally fail-fast.
if (config.auth.mode === 'oidc') {
  try {
    await prefetchOidcJwks(config.auth.oidc)
  }
  catch (err) {
    logger.fatal({ err, reason: 'oidc_discovery_failed' }, 'oidc_setup_failed; refusing to start')
    process.exit(1)
  }
}

// Run migrations against the configured database before binding
// sockets when the operator has explicitly opted in. Failure here is
// fatal — the server must not accept traffic against a half-migrated
// database. See src/storage/migrate-on-start.ts for why this lives in
// server.ts (NOT index.ts).
try {
  await applyMigrationsOnStartIfEnabled()
}
catch (err) {
  logger.fatal({ err }, 'migrate_on_start_failed; refusing to start')
  process.exit(1)
}

// Run the readiness probe before binding sockets so a misconfigured
// or unreachable database fails fast at boot — and so the resolved
// pg.Pool / better-sqlite3 driver state populated by the first real
// connection is available for the storage_connected log below.
//
// Failure modes:
//   - db_unreachable: always fatal. Network, auth, DSN, or driver
//     problem the operator must resolve before the server can serve
//     any traffic.
//   - schema_missing: fatal UNLESS the operator opted into
//     migrateOnStart. In the migrate-on-start path the migrator
//     already ran above; if it succeeded but the readiness probe
//     still reports schema_missing, surface a warn and let the
//     /ready endpoint report the live state from there.
const readiness = await checkReadiness()
if (!readiness.ok) {
  if (readiness.reason === 'schema_missing' && config.migrateOnStart) {
    logger.warn(
      { readiness, db: describeDb() },
      'storage_schema_missing_after_migrate_on_start',
    )
  }
  else {
    logger.fatal(
      { readiness, db: describeDb() },
      'storage_probe_failed; refusing to start',
    )
    process.exit(1)
  }
}
// Emit the resolved driver state at INFO so operators can see at a
// glance which database the server is actually connected to — derived
// from the live pg.Pool / better-sqlite3 instance, not by re-parsing
// the configured db.url.
logger.info(describeDb(), 'storage_connected')

if (config.auth.mode === 'none') {
  logger.warn(
    { authMode: 'none' },
    'auth_disabled; auth.mode=none accepts unauthenticated requests. Set auth.mode to preshared or oidc for any non-local deployment.',
  )
}

const servers: ClosableServer[] = []

if (config.listeners.http.enabled) {
  servers.push(serve({ fetch: app.fetch, port: config.listeners.http.port }, (info) => {
    logger.info({ protocol: 'http', port: info.port }, 'server_listening')
  }) as ClosableServer)
}

if (config.tls.certFile && config.tls.keyFile) {
  servers.push(serve(
    {
      fetch: app.fetch,
      port: config.listeners.https.port,
      createServer: createHttpsServer,
      serverOptions: {
        key: readFileSync(config.tls.keyFile),
        cert: readFileSync(config.tls.certFile),
      },
    },
    (info) => {
      logger.info({ protocol: 'https', port: info.port }, 'server_listening')
    },
  ) as ClosableServer)
}

// Single owner of process shutdown. Registering these listeners
// disables Node's default exit-on-signal, so the handler always ends
// in process.exit. OTel installs no signal handlers of its own.
const shutdown = createShutdownHandler({
  closeListeners: () => closeServers(servers),
  shutdownTelemetry: shutdownOtelSdk,
  closeDatabase: closeDb,
  exit: code => process.exit(code),
  log: logger,
})
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => { void shutdown(signal) })
}
