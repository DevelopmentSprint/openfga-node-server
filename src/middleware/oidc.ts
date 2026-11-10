/**
 * OIDC bearer-token middleware.
 *
 * Per docs/features/oidc-auth.md. Validates `Authorization: Bearer <jwt>`
 * against the configured issuer's published JWKS using `jose.jwtVerify`
 * with the algorithm allowlist, issuer / audience / expiry / not-before
 * claims, and optional `sub` and `client_id`/`azp` allowlists.
 *
 * Client-facing failures are uniformly `401 { code: 'unauthenticated',
 * message: 'missing or invalid Authorization header' }`. Operators get
 * the actual distinguishing `reason` in structured logs (see the table
 * in oidc-auth.md §"Error Semantics"). Returning a more informative
 * client response leaks JWT validation oracles to attackers.
 *
 * The middleware factory does NOT block on JWKS contents — the set is
 * lazily fetched on first request via jose.createRemoteJWKSet. OIDC
 * issuer discovery (resolving the `jwks_uri` from
 * `${issuer}/.well-known/openid-configuration`) runs once per distinct
 * OIDC config and is shared, via one memoized promise, between the
 * boot-time `prefetchOidcJwks` and every middleware built for that
 * config. A boot-time discovery failure is fatal: it surfaces as a
 * thrown `OidcDiscoveryError` so the server bootstrap can log FATAL and
 * exit before binding any listener. A failure is never cached
 * permanently: after a short backoff the next request (or the next
 * prefetch, immediately) runs discovery again (openfga-k2a.3).
 */
import type { Context, MiddlewareHandler } from 'hono'
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose'
import { logger } from '../logger'
import type { Config } from '../config-schema'
import { oidcPrincipal, parseBearerToken, setAuthPrincipal } from './caller'

export type OidcConfig = Config['auth']['oidc']

const ENVELOPE_401 = {
  code: 'unauthenticated',
  message: 'missing or invalid Authorization header',
}

const DISCOVERY_TIMEOUT_MS = 5_000
const DISCOVERY_RETRY_COUNT = 1
/**
 * After a failed discovery, requests inside this window reuse the
 * failure (401 jwks_unavailable) instead of each re-running discovery
 * against an issuer that just failed. The first request after the
 * window starts a fresh attempt.
 */
const DISCOVERY_FAILURE_BACKOFF_MS = 5_000

interface OidcDiscoveryDocument {
  jwks_uri?: string
}

/**
 * Raised when OIDC issuer discovery fails at startup. Callers
 * (server bootstrap) are expected to log FATAL and exit non-zero;
 * the server must not bind listeners against a misconfigured
 * OIDC mode.
 */
export class OidcDiscoveryError extends Error {
  override readonly name = 'OidcDiscoveryError'
}

/**
 * Resolve the JWKS URI: explicit `jwksUri` config wins; otherwise
 * fetch `${issuer}/.well-known/openid-configuration` and read its
 * `jwks_uri`. One retry on transient failure. 5-second per-attempt
 * timeout. Throws `OidcDiscoveryError` if both attempts fail.
 */
async function resolveJwksUri(oidc: OidcConfig): Promise<string> {
  if (oidc.jwksUri) return oidc.jwksUri

  const issuer = oidc.issuer
  if (!issuer) {
    // Schema-level validation should have caught this. Defensive throw
    // so a tampered Config object surfaces here rather than during
    // request handling.
    throw new OidcDiscoveryError('auth.oidc.issuer is not set; cannot run OIDC discovery')
  }
  const discoveryUrl = new URL('.well-known/openid-configuration', issuer.endsWith('/') ? issuer : `${issuer}/`)

  let lastErr: unknown
  for (let attempt = 0; attempt <= DISCOVERY_RETRY_COUNT; attempt++) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS)
      try {
        const res = await fetch(discoveryUrl, { signal: controller.signal })
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} from ${discoveryUrl}`)
        }
        const doc = (await res.json()) as OidcDiscoveryDocument
        if (!doc.jwks_uri) {
          throw new Error(`discovery document at ${discoveryUrl} missing jwks_uri`)
        }
        return doc.jwks_uri
      }
      finally {
        clearTimeout(timeout)
      }
    }
    catch (err) {
      lastErr = err
    }
  }
  throw new OidcDiscoveryError(
    `OIDC discovery failed for ${discoveryUrl.toString()}: ${(lastErr as Error)?.message ?? String(lastErr)}`,
  )
}

interface LogContext {
  method: string
  path: string
}

function reject(c: Context, ctx: LogContext, reason: string, extra: Record<string, unknown> = {}): Response {
  logger.warn({ ...ctx, ...extra, reason }, 'auth_rejected')
  return c.json(ENVELOPE_401, 401)
}

interface DiscoveryEntry {
  promise: Promise<JWTVerifyGetKey>
  /** `Date.now()` when `promise` rejected; null while pending or resolved. */
  failedAt: number | null
}

/**
 * One discovery per distinct OIDC config. Keyed by the fields that
 * determine the resulting key set, not by object identity, so the boot
 * prefetch and the middleware share an entry even when they receive
 * different (but equal) config objects.
 */
const discoveryCache = new Map<string, DiscoveryEntry>()

function discoveryCacheKey(oidc: OidcConfig): string {
  return JSON.stringify([oidc.issuer ?? null, oidc.jwksUri ?? null, oidc.jwksCacheMaxAgeMs, oidc.jwksCooldownMs])
}

/**
 * Return the shared JWKS promise for `oidc`, starting discovery when
 * there is none yet, or when the previous attempt failed and either
 * the backoff has elapsed or `retryFailedNow` is set. Successful
 * results are kept for the life of the process (jose handles key
 * rotation within the resolved JWKS URI).
 */
function getSharedJwks(oidc: OidcConfig, retryFailedNow = false): Promise<JWTVerifyGetKey> {
  const cacheKey = discoveryCacheKey(oidc)
  const existing = discoveryCache.get(cacheKey)
  if (existing) {
    if (existing.failedAt === null) return existing.promise
    if (!retryFailedNow && Date.now() - existing.failedAt < DISCOVERY_FAILURE_BACKOFF_MS) return existing.promise
  }

  const entry: DiscoveryEntry = { promise: buildJWKS(oidc), failedAt: null }
  discoveryCache.set(cacheKey, entry)
  // The handler both records the failure time and marks the rejection
  // as handled, so a discovery nobody has awaited yet cannot trip
  // Node's unhandled-rejection crash. Awaiting `entry.promise` later
  // still observes the rejection.
  entry.promise.catch((err: unknown) => {
    entry.failedAt = Date.now()
    logger.error({ err, reason: 'oidc_discovery_failed' }, 'oidc_discovery_failed')
  })
  return entry.promise
}

/** Drop all memoized discovery results. Tests only. */
export function resetOidcDiscoveryCacheForTests(): void {
  discoveryCache.clear()
}

/**
 * Build the OIDC middleware. Kicks off (or joins) the shared discovery
 * for this config so the first request does not pay the cold-start
 * cost. Per-request validation runs via jose.jwtVerify against the
 * resolved JWKS. If discovery has failed, the request is rejected with
 * `jwks_unavailable` and a later request retries discovery.
 *
 * For fail-fast boot behavior, callers should await
 * prefetchOidcJwks(oidc) BEFORE binding any listener so the
 * OidcDiscoveryError is observed by the bootstrap rather than the
 * first request handler.
 */
export function oidcMiddleware(oidc: OidcConfig): MiddlewareHandler {
  void getSharedJwks(oidc).catch(() => { /* surfaced per request */ })

  const issuerAccepts = [
    oidc.issuer!, // schema enforces presence
    ...oidc.issuerAliases,
  ]
  const subjectAllowlist = new Set(oidc.subjects)
  const clientAllowlist = new Set(oidc.clients)
  const algorithms = oidc.algorithms

  return async (c, next) => {
    const ctx: LogContext = { method: c.req.method, path: c.req.path }

    const parsed = parseBearerToken(c.req.header('Authorization'))
    if (!parsed.ok) {
      return reject(c, ctx, parsed.reason)
    }
    const token = parsed.token

    let jwks: JWTVerifyGetKey
    try {
      jwks = await getSharedJwks(oidc)
    }
    catch (err) {
      return reject(c, ctx, 'jwks_unavailable', { err: errString(err) })
    }

    let payload: JWTPayload
    try {
      const result = await jwtVerify(token, jwks, {
        issuer: issuerAccepts,
        audience: oidc.audience!, // schema enforces presence
        algorithms: [...algorithms],
        clockTolerance: oidc.clockSkewSec,
        // A token without `exp` would otherwise never expire.
        // oidc-auth.md requires exp validation; jose reports a missing
        // claim as JWTClaimValidationFailed(claim: 'exp'), which
        // classifyJoseError maps to time_claim_invalid.
        requiredClaims: ['exp'],
      })
      payload = result.payload
    }
    catch (err) {
      return reject(c, ctx, classifyJoseError(err), { err: errString(err) })
    }

    const sub = typeof payload.sub === 'string' ? payload.sub : null
    const clientId = typeof payload['client_id'] === 'string'
      ? (payload['client_id'] as string)
      : typeof payload.azp === 'string'
        ? payload.azp
        : null

    if (subjectAllowlist.size > 0) {
      if (!subjectAllowlist.has(sub ?? '')) {
        return reject(c, ctx, 'sub_disallowed', { sub: sub ?? '' })
      }
    }

    if (clientAllowlist.size > 0) {
      if (!clientAllowlist.has(clientId ?? '')) {
        return reject(c, ctx, 'client_disallowed', { client: clientId ?? '' })
      }
    }

    setAuthPrincipal(c, oidcPrincipal(sub, clientId))
    await next()
  }
}

/**
 * Boot-time fail-fast helper. Server bootstrap awaits this before
 * binding any listener so an unreachable OIDC issuer surfaces as a
 * FATAL log at boot rather than as 401s on every authenticated
 * request. Throws `OidcDiscoveryError` on failure.
 *
 * Shares the memoized discovery with `oidcMiddleware`, so a successful
 * prefetch means the middleware never repeats discovery. A previously
 * failed attempt is retried immediately (no backoff) so the boot
 * decision reflects the issuer's current state.
 */
export async function prefetchOidcJwks(oidc: OidcConfig): Promise<void> {
  try {
    await getSharedJwks(oidc, true)
  }
  catch (err) {
    if (err instanceof OidcDiscoveryError) throw err
    throw new OidcDiscoveryError(String(err))
  }
}

/**
 * Resolve the JWKS URI and build the remote key set. The function
 * returned by createRemoteJWKSet is a stable reference that memoizes
 * fetches internally via the configured cacheMaxAge and
 * cooldownDuration.
 */
async function buildJWKS(oidc: OidcConfig): Promise<JWTVerifyGetKey> {
  const jwksUri = await resolveJwksUri(oidc)
  return createRemoteJWKSet(new URL(jwksUri), {
    cacheMaxAge: oidc.jwksCacheMaxAgeMs,
    cooldownDuration: oidc.jwksCooldownMs,
  })
}

/**
 * Map a thrown jose error to one of the structured `reason` strings
 * documented in oidc-auth.md §"Error Semantics". Falls through to
 * `jwt_malformed` for unrecognized errors so operators still see a
 * single classifying string in the log, with the actual error
 * appended in `err`.
 */
function classifyJoseError(err: unknown): string {
  if (err instanceof joseErrors.JWTExpired) return 'time_claim_invalid'
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    // Also covers a missing required claim (reason: 'missing'), e.g.
    // a token without `exp` → time_claim_invalid.
    if (err.claim === 'iss') return 'iss_mismatch'
    if (err.claim === 'aud') return 'aud_mismatch'
    if (err.claim === 'nbf' || err.claim === 'iat' || err.claim === 'exp') return 'time_claim_invalid'
    return 'claim_invalid'
  }
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) return 'signature_invalid'
  if (err instanceof joseErrors.JOSEAlgNotAllowed) return 'alg_disallowed'
  if (err instanceof joseErrors.JWKSNoMatchingKey) return 'signature_invalid'
  if (err instanceof joseErrors.JWKSMultipleMatchingKeys) return 'signature_invalid'
  // Network failures fetching the JWKS during per-request verification
  // surface as raw TypeError from Node's fetch (jose doesn't wrap
  // them). Classify these as jwks_unavailable so operators see the
  // right reason in logs rather than the misleading 'jwt_malformed'.
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) return 'jwks_unavailable'
  if (err instanceof joseErrors.JWSInvalid || err instanceof joseErrors.JWTInvalid) return 'jwt_malformed'
  return 'jwt_malformed'
}

function errString(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  return String(err)
}
