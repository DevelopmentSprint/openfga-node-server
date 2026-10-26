/**
 * HTTP routes — wire-compatible with the OpenFGA reference server's
 * REST API for the surface this project implements.
 *
 * Implemented endpoints (one resource family per sub-app):
 *
 *   GET    /health                                                 → health.ts
 *   GET    /ready                                                  → health.ts
 *   GET    /stores                                                 → stores.ts
 *   POST   /stores                                                 → stores.ts
 *   POST   /stores/:storeId/authorization-models                   → models.ts
 *   GET    /stores/:storeId/authorization-models                   → models.ts
 *   GET    /stores/:storeId/authorization-models/:id               → models.ts
 *   POST   /stores/:storeId/check                                  → evaluation.ts
 *   POST   /stores/:storeId/batch-check                            → evaluation.ts
 *   POST   /stores/:storeId/expand                                 → evaluation.ts
 *   POST   /stores/:storeId/list-objects                           → evaluation.ts
 *   POST   /stores/:storeId/list-users                             → evaluation.ts
 *   POST   /stores/:storeId/write                                  → tuples.ts
 *   POST   /stores/:storeId/read                                   → tuples.ts
 *   GET    /stores/:storeId/changes                                → tuples.ts
 *   GET    /stores/:storeId/assertions/:authorizationModelId       → assertions.ts
 *   PUT    /stores/:storeId/assertions/:authorizationModelId       → assertions.ts
 *
 * The wire format must match `@openfga/sdk` byte-for-byte. The SDK
 * snake_cases everything, so the bodies and responses here do too.
 *
 * Middleware chain (composed at the top-level app, before any
 * sub-app's routes resolve):
 *
 *   1. requestLog   structured log line per request
 *   2. auth         /stores/* — none | preshared | oidc per config
 *   3. requireStore /stores/:storeId/* — 404 on unknown store
 *   4. idempotency  Idempotency-Key for configured mutating endpoints
 */
import { logger } from '../logger'
import { ConditionError } from '../evaluator/conditions'
import { Hono } from 'hono'
import { httpInstrumentationMiddleware as honoOtel } from '@hono/otel'
import { config } from '../config'
import { authMiddleware, getAuthConfig } from '../middleware/auth'
import { idempotencyMiddleware } from '../middleware/idempotency'
import { requestLog } from '../middleware/request-log'
import { requireStore } from '../middleware/require-store'
import { assertionsRoutes } from './assertions'
import { evaluationRoutes } from './evaluation'
import { healthRoutes } from './health'
import { modelsRoutes } from './models'
import { storesRoutes } from './stores'
import { tuplesRoutes } from './tuples'

export function buildApp(): Hono {
  const app = new Hono()
  app.onError((error, c) => {
    if (error instanceof ConditionError) return c.json({ code: error.code, message: error.message }, 400)
    logger.error({ err: error }, 'request_failed')
    return c.json({ code: 'internal_error', message: 'Internal Server Error' }, 500)
  })

  // OpenTelemetry HTTP instrumentation — must wrap every later
  // middleware so the request span is the parent of auth /
  // idempotency / handler activity. Installed only when
  // config.otel.enabled AND config.otel.spans.http; the SDK itself
  // is initialized in src/server.ts before listeners bind, so by
  // the time this app is built the tracer provider is ready.
  if (config.otel.enabled && config.otel.spans.http) {
    app.use('*', honoOtel())
  }

  app.use('*', requestLog)

  // Caller authentication. Mounted on /stores/* so /health stays
  // reachable for liveness probes without credentials. Mode is chosen
  // at boot from config.auth (OPENFGA_AUTH_MODE env-overlay); see
  // src/middleware/auth.ts for the dispatch and the supported modes.
  app.use('/stores/*', authMiddleware(getAuthConfig()))

  // Store-existence guard. Mounted on /stores/:storeId/* so every
  // store-scoped route returns a 404 store_id_not_found before any
  // handler logic runs. POST /stores (create) is correctly excluded
  // by the path scope. AFTER auth (don't leak existence to
  // unauthenticated callers); BEFORE idempotency (don't create
  // idempotency-key entries for non-existent stores). See openfga-rv0.
  app.use('/stores/:storeId/*', requireStore())

  // Idempotency-Key support for the three mutating endpoints in scope
  // (PRD §"Idempotency keys", docs/features/idemnpotency-keys.md).
  // Mode and TTL are read from config.idempotency. Default mode is
  // 'off' so existing clients are not affected until enabled.
  app.use(
    '*',
    idempotencyMiddleware({
      scopes: [
        { method: 'POST', path: '/stores' },
        { method: 'POST', path: '/stores/:storeId/authorization-models' },
        { method: 'POST', path: '/stores/:storeId/write' },
      ],
    }),
  )

  // Resource sub-apps. Each sub-app declares full paths (e.g.
  // `/stores/:storeId/check`) so the OpenFGA wire URLs stay greppable
  // in one place per resource. Mount point is '/' — the parent's
  // path-scoped middleware (auth, requireStore) still applies.
  app.route('/', healthRoutes)
  app.route('/', storesRoutes)
  app.route('/', modelsRoutes)
  app.route('/', evaluationRoutes)
  app.route('/', tuplesRoutes)
  app.route('/', assertionsRoutes)

  return app
}
