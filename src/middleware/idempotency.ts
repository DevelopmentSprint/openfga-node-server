/**
 * Idempotency-Key middleware.
 *
 * Implements the design in docs/features/idemnpotency-keys.md and
 * the PRD §"Idempotency keys" section. Lets clients safely retry
 * mutating requests after timeouts, dropped connections, or
 * ambiguous responses without duplicating side effects.
 *
 * Modes:
 *   - 'off'      — middleware is a no-op. Default.
 *   - 'optional' — Idempotency-Key is honored when present, ignored
 *                  when absent.
 *   - 'required' — scoped mutating requests must include
 *                  Idempotency-Key; missing keys return 400.
 *
 * Scope:
 *
 * The middleware applies only to paths whose `(method, path)` pair
 * is registered via `idempotencyMiddleware({ scopes: [...] })`. Other
 * requests pass through unchanged. The path matcher uses Hono's
 * route-style placeholders (e.g. '/stores/:storeId/write').
 *
 * Concurrency:
 *
 * - Same key + same fingerprint, no in-flight request → replay the
 *   original cached response.
 * - Same key + same fingerprint, in-flight request → 409.
 * - Same key + different fingerprint → 422.
 *
 * Fingerprint = SHA-256 of `<METHOD> <ROUTE>\n<RAW BODY>`, where
 * <ROUTE> is the matched route pattern (so different stores hitting
 * the same route share the same scope but different bodies still
 * produce different fingerprints via the body bytes).
 *
 * Caller scoping (openfga-k2a.3):
 *
 * Records are stored under `scopedIdempotencyKey(principal, key)`, a
 * SHA-256 of the authenticated principal (set by the auth middleware,
 * see ./caller.ts) and the client's key. Two callers that pick the
 * same Idempotency-Key never see each other's records: no replay, no
 * 409/422 that would reveal the key exists. The raw key is never
 * persisted.
 *
 * Keys longer than MAX_IDEMPOTENCY_KEY_LENGTH are rejected with 400.
 *
 * Storage failures bubble up as 503 so retries can succeed once the
 * store recovers.
 *
 * Only 2xx responses are recorded and replayed (openfga-k2a.14). Any
 * other status (4xx or 5xx) or a thrown handler releases the claim,
 * so a retry with the same key re-runs the request instead of
 * replaying a cached failure.
 */
import { createHash } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import { logger } from '../logger'
import { config } from '../config'
import { claimKey, completeKey, releaseKey } from '../storage/idempotency'
import { getAuthPrincipal } from './caller'

export type IdempotencyMode = 'off' | 'optional' | 'required'

export interface IdempotencyScope {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /**
   * Hono-style route pattern. Must match the route registration the
   * handler uses (e.g. '/stores/:storeId/write'). The pattern is used
   * verbatim as the matchedPath component of the fingerprint, so it
   * is stable across stores while still distinguishing routes.
   */
  path: string
}

export interface IdempotencyOptions {
  scopes: IdempotencyScope[]
  /** Override env-derived mode. Primarily for tests. */
  mode?: IdempotencyMode
  /** Override env-derived TTL. Primarily for tests. */
  ttlMs?: number
}

/**
 * Upper bound on the (trimmed) Idempotency-Key length. Generous for
 * UUIDs, ULIDs, and composite client keys while preventing unbounded
 * header values from reaching hashing, logs, and storage.
 */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255

const ERROR_ENVELOPES = {
  missing_key: { code: 'invalid_argument', message: 'Idempotency-Key header is required' },
  empty_key: { code: 'invalid_argument', message: 'Idempotency-Key header must not be empty' },
  key_too_long: { code: 'invalid_argument', message: `Idempotency-Key header must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters` },
  in_flight: { code: 'idempotency_in_flight', message: 'a previous request with this Idempotency-Key is still being processed' },
  mismatch: { code: 'idempotency_fingerprint_mismatch', message: 'Idempotency-Key was reused with a different request fingerprint' },
  unavailable: { code: 'idempotency_store_unavailable', message: 'idempotency store is unavailable; retry later' },
} as const

/** Statuses whose Response must not carry a body (Fetch spec). */
const NULL_BODY_STATUSES = new Set([204, 205, 304])

function pathMatches(routePattern: string, requestPath: string): boolean {
  if (routePattern === requestPath) return true
  const patternParts = routePattern.split('/')
  const requestParts = requestPath.split('/')
  if (patternParts.length !== requestParts.length) return false
  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i]!
    const r = requestParts[i]!
    if (p.startsWith(':')) continue
    if (p !== r) return false
  }
  return true
}

function findScope(scopes: IdempotencyScope[], method: string, path: string): IdempotencyScope | null {
  for (const scope of scopes) {
    if (scope.method === method && pathMatches(scope.path, path)) return scope
  }
  return null
}

function fingerprint(method: string, requestPath: string, rawBody: string): string {
  // The path component MUST be the concrete request URL (e.g.
  // `/stores/01ABC.../write`), not the matched route pattern
  // (`/stores/:storeId/write`). Hashing the pattern collapses every
  // store onto the same fingerprint, so the same Idempotency-Key
  // reused across two stores with the same body would replay the
  // first store's response under the second store's namespace —
  // a cross-store data leak. See openfga-fot.
  return createHash('sha256').update(`${method} ${requestPath}\n${rawBody}`).digest('hex')
}

/**
 * Storage key for a client Idempotency-Key, namespaced by the
 * authenticated principal. JSON-encoding the pair keeps the boundary
 * unambiguous (`('a','bc')` and `('ab','c')` differ); hashing keeps the
 * stored value fixed-length and free of the raw key.
 */
export function scopedIdempotencyKey(principal: string, key: string): string {
  return createHash('sha256').update(JSON.stringify([principal, key])).digest('hex')
}

function keyHash(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

/**
 * Build a Hono middleware that enforces Idempotency-Key for the
 * configured scopes. Reads `OPENFGA_IDEMPOTENCY_MODE` and
 * `OPENFGA_IDEMPOTENCY_TTL_MS` from the environment unless overrides
 * are passed.
 */
export function idempotencyMiddleware(options: IdempotencyOptions): MiddlewareHandler {
  const mode = options.mode ?? config.idempotency.mode
  const ttlMs = options.ttlMs ?? config.idempotency.ttlMs
  const scopes = options.scopes

  return async (c, next) => {
    if (mode === 'off') return next()

    const scope = findScope(scopes, c.req.method, c.req.path)
    if (!scope) return next()

    const headerValue = c.req.header('Idempotency-Key')
    const key = headerValue?.trim() ?? ''

    if (key === '') {
      if (mode === 'required') {
        const envelope = headerValue === undefined ? ERROR_ENVELOPES.missing_key : ERROR_ENVELOPES.empty_key
        return c.json(envelope, 400)
      }
      return next()
    }

    if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      return c.json(ERROR_ENVELOPES.key_too_long, 400)
    }

    const storageKey = scopedIdempotencyKey(getAuthPrincipal(c), key)

    let rawBody: string
    try {
      rawBody = await c.req.text()
    }
    catch (err) {
      logger.warn({ err, key_hash: keyHash(key) }, 'idempotency_body_read_failed')
      return c.json(ERROR_ENVELOPES.unavailable, 503)
    }

    const fp = fingerprint(scope.method, c.req.path, rawBody)
    const keyLog = { key_hash: keyHash(key), method: scope.method, route: scope.path }

    let claim
    try {
      claim = await claimKey(storageKey, fp, ttlMs)
    }
    catch (err) {
      logger.error({ err, ...keyLog }, 'idempotency_store_unavailable')
      return c.json(ERROR_ENVELOPES.unavailable, 503)
    }

    if (claim.kind === 'in_flight') {
      logger.info(keyLog, 'idempotency_in_flight')
      return c.json(ERROR_ENVELOPES.in_flight, 409)
    }
    if (claim.kind === 'mismatch') {
      logger.info(keyLog, 'idempotency_fingerprint_mismatch')
      return c.json(ERROR_ENVELOPES.mismatch, 422)
    }
    if (claim.kind === 'replay') {
      logger.info({ ...keyLog, replay_status: claim.status }, 'idempotency_replay')
      // An empty original body (e.g. 204) is stored as NULL and must
      // replay as an empty body: `new Response('null', { status: 204 })`
      // throws, and any other status would otherwise replay a literal
      // `null` the handler never sent.
      if (claim.body === null || claim.body === undefined || NULL_BODY_STATUSES.has(claim.status)) {
        return new Response(null, { status: claim.status })
      }
      return new Response(JSON.stringify(claim.body), {
        status: claim.status,
        headers: { 'content-type': 'application/json' },
      })
    }

    // claim.kind === 'claimed' — we own the slot. Run the handler,
    // capture the response, persist it for replay when it is 2xx (or
    // drop the slot otherwise so retries re-run the request). Every follow-up write carries
    // the claim token so it is a no-op if our lease expired and
    // another request reclaimed the key meanwhile.
    const { token } = claim
    const release = async (): Promise<void> => {
      try {
        const released = await releaseKey(storageKey, token)
        if (!released) logger.warn(keyLog, 'idempotency_claim_lost')
      }
      catch (releaseErr) {
        logger.error({ err: releaseErr, ...keyLog }, 'idempotency_release_failed')
      }
    }
    try {
      await next()
    }
    catch (err) {
      logger.warn({ err, ...keyLog }, 'idempotency_handler_threw')
      await release()
      throw err
    }

    const status = c.res.status
    if (status < 200 || status >= 300) {
      logger.info({ ...keyLog, status }, 'idempotency_release_non_2xx')
      await release()
      return
    }

    let body: unknown
    try {
      const cloned = c.res.clone()
      const text = await cloned.text()
      // Empty body → undefined → stored as SQL NULL → replayed empty.
      body = text === '' ? undefined : JSON.parse(text)
    }
    catch (err) {
      logger.warn({ err, ...keyLog }, 'idempotency_response_capture_failed')
      await release()
      return
    }

    try {
      const completed = await completeKey(storageKey, token, status, body)
      if (completed) {
        logger.info({ ...keyLog, status }, 'idempotency_complete')
      }
      else {
        // Our lease expired and another request reclaimed the key.
        // Leave its row alone; the response still goes to the client.
        logger.warn({ ...keyLog, status }, 'idempotency_claim_lost')
      }
    }
    catch (err) {
      logger.error({ err, ...keyLog }, 'idempotency_complete_failed')
      // Best-effort cleanup (token-scoped, so it can only remove our
      // own claim). The original response still goes to the client;
      // otherwise the lease makes the key reclaimable shortly.
      try {
        await releaseKey(storageKey, token)
      }
      catch { /* swallow */ }
    }
  }
}
