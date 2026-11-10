/**
 * Authenticated-caller helpers shared by the auth middlewares
 * (`auth.ts`, `oidc.ts`) and their downstream consumers
 * (`idempotency.ts`).
 *
 * Two concerns live here so neither auth module has to import the
 * other and so idempotency does not depend on an auth implementation:
 *
 *   - `parseBearerToken` — RFC 7235 credentials parsing. The auth
 *     scheme is case-insensitive (`Bearer`, `bearer`, `BEARER` are
 *     all the same scheme) and is separated from the token by one or
 *     more spaces.
 *
 *   - The caller principal: a stable, non-secret identity string the
 *     auth middleware stores on the Hono context once a request is
 *     authenticated. Idempotency namespaces its records by it so one
 *     caller can never replay, or probe the existence of, another
 *     caller's Idempotency-Key. The principal never contains a
 *     credential: preshared mode stores a SHA-256 digest of the
 *     matched key, OIDC stores the token's `sub` and client claims.
 */
import { createHash } from 'node:crypto'
import type { Context } from 'hono'

declare module 'hono' {
  interface ContextVariableMap {
    authPrincipal: string
  }
}

/** Principal recorded when auth mode is `none`. */
export const ANONYMOUS_PRINCIPAL = 'none:anonymous'

export type BearerParseResult =
  | { ok: true, token: string }
  | { ok: false, reason: 'missing_authorization' | 'wrong_scheme' }

/**
 * Parse an `Authorization` header value as `Bearer <token>`. The
 * scheme comparison is case-insensitive per RFC 7235 §2.1, and any
 * run of spaces/tabs between scheme and token is accepted. An empty
 * token is reported as `missing_authorization`.
 */
export function parseBearerToken(header: string | undefined): BearerParseResult {
  if (!header) return { ok: false, reason: 'missing_authorization' }
  const match = /^([^\s]+)[ \t]+(.*)$/.exec(header)
  if (!match || match[1]!.toLowerCase() !== 'bearer') {
    // A bare `Bearer` with no token at all is a missing credential,
    // not a different scheme.
    if (header.trim().toLowerCase() === 'bearer') return { ok: false, reason: 'missing_authorization' }
    return { ok: false, reason: 'wrong_scheme' }
  }
  const token = match[2]!.trim()
  if (!token) return { ok: false, reason: 'missing_authorization' }
  return { ok: true, token }
}

/**
 * Principal for a matched preshared key. The digest identifies which
 * configured key matched without ever storing the key itself, and is
 * stable across config reorderings (unlike a list index).
 */
export function presharedPrincipal(key: string): string {
  return `preshared:${createHash('sha256').update(key, 'utf8').digest('hex')}`
}

/**
 * Principal for a verified OIDC token: the subject plus the client
 * (`client_id`, falling back to `azp`). JSON-encoding keeps the two
 * fields unambiguous whatever characters the issuer puts in them.
 */
export function oidcPrincipal(sub: string | null, client: string | null): string {
  return `oidc:${JSON.stringify([sub, client])}`
}

export function setAuthPrincipal(c: Context, principal: string): void {
  c.set('authPrincipal', principal)
}

/**
 * Read the principal set by the auth middleware. Routes mounted
 * without an auth middleware (unit-test compositions, mode `none`
 * stacks that predate the principal) resolve to the anonymous
 * principal, which matches the `none`-mode behavior.
 */
export function getAuthPrincipal(c: Context): string {
  return c.get('authPrincipal') ?? ANONYMOUS_PRINCIPAL
}
