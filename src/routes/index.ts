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
 *   PUT    /x-ext/stores/:storeId/write-fences/:key               → write-fences.ts
 *          (extension; mounted only when config.writeFences.enabled)
 *
 * The wire format must match `@openfga/sdk` byte-for-byte. The SDK
 * snake_cases everything, so the bodies and responses here do too.
 *
 * Middleware chain (composed at the top-level app, before any
 * sub-app's routes resolve):
 *
 *   1. requestLog   structured log line per request
 *   2. bodyLimit    1 MiB cap on request bodies — 413 JSON envelope
 *   3. auth         /stores/* — none | preshared | oidc per config
 *   4. requireStore /stores/:storeId/* — 404 on unknown store
 *   5. writeFencePreflight  /stores/:storeId/write fence admission
 *                   (only when config.writeFences.enabled)
 *   6. idempotency  Idempotency-Key for configured mutating endpoints
 */
import { logger } from '../logger'
import { ConditionError } from '../evaluator/conditions'
import { ModelReferenceError } from './_helpers/evaluation-validation'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
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
import { WriteFenceError } from '../storage/write-fences'
import { StoreNotFoundError } from '../storage/store-mutation'
import { EXTENSION_PREFIX, writeFencePreflight, writeFenceRoutes } from './write-fences'
import { tuplesRoutes } from './tuples'

/** Maximum accepted request body size. A code constant, not configuration. */
export const MAX_BODY_BYTES = 1024 * 1024

export function buildApp(): Hono {
  const app = new Hono()
  // Unmatched routes under /stores/* use the JSON error envelope
  // (upstream NotFoundErrorCode `undefined_endpoint`) instead of Hono's
  // plain-text 404.
  app.notFound((c) => {
    // Extension paths (/x-ext/...) get the same JSON envelope, whether
    // or not the extension is enabled.
    if (c.req.path === '/stores' || c.req.path.startsWith('/stores/') || c.req.path.startsWith(`${EXTENSION_PREFIX}/`)) {
      return c.json({ code: 'undefined_endpoint', message: 'Endpoint not enabled' }, 404)
    }
    return c.text('404 Not Found', 404)
  })
  app.onError((error, c) => {
    if (error instanceof WriteFenceError) return c.json({ code: error.code, message: error.message }, 409)
    if (error instanceof StoreNotFoundError) return c.json({ code: 'store_id_not_found', message: error.message }, 404)
    if (error instanceof ConditionError || error instanceof ModelReferenceError) return c.json({ code: error.code, message: error.message }, 400)
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

  // Request body size cap. FIRST body-touching middleware: idempotency
  // hashes the whole body and validation parses it, so an oversized
  // body must be refused before either reads it. Enforced against
  // Content-Length when present and against the streamed byte count
  // otherwise (chunked uploads).
  app.use(
    '*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: c => c.json(
        { code: 'payload_too_large', message: `request body exceeds the ${MAX_BODY_BYTES} byte limit` },
        413,
      ),
    }),
  )

  // Caller authentication. Mounted on /stores/* so /health stays
  // reachable for liveness probes without credentials. Mode is chosen
  // at boot from config.auth (OPENFGA_AUTH_MODE env-overlay); see
  // src/middleware/auth.ts for the dispatch and the supported modes.
  const auth = authMiddleware(getAuthConfig())
  app.use('/stores/*', auth)

  // Store-existence guard. Mounted on /stores/:storeId/* so every
  // store-scoped route returns a 404 store_id_not_found before any
  // handler logic runs. POST /stores (create) is correctly excluded
  // by the path scope. AFTER auth (don't leak existence to
  // unauthenticated callers); BEFORE idempotency (don't create
  // idempotency-key entries for non-existent stores). See openfga-rv0.
  app.use('/stores/:storeId/*', requireStore())

  // Optional durable write-fence extension (docs/features/write-fences.md).
  // Off by default; when off nothing below is mounted, the /x-ext/
  // route falls through to notFound and fence headers on /write are
  // ignored, so the surface is identical to upstream OpenFGA. When on,
  // the acquisition route gets the same auth and store-existence
  // checks as /stores/:storeId/*, and the /write preflight runs BEFORE
  // idempotency so a cached 2xx cannot bypass fence admission.
  const writeFencesEnabled = config.writeFences.enabled
  if (writeFencesEnabled) {
    app.use(`${EXTENSION_PREFIX}/stores/*`, auth)
    app.use(`${EXTENSION_PREFIX}/stores/:storeId/*`, requireStore())
    app.use('/stores/:storeId/write', writeFencePreflight())
  }

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
  if (writeFencesEnabled) app.route('/', writeFenceRoutes)
  app.route('/', assertionsRoutes)

  return app
}
