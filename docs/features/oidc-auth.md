# OIDC API Authentication Mode

## Status

Proposed.

## Source of Truth

- PRD: `docs/PRD.md` §"API caller authentication" (L142-154) names three modes (`none`, `shared_key`, `oidc`) — see Open Question on the `shared_key`/`preshared` naming discrepancy below; §"Implementation roadmap" §openfga-711 (L86-88) anchors this feature and states "OIDC layers onto the same middleware dispatch."
- External standards: OpenID Connect Core 1.0 (`iss` / `aud` / `sub` / `exp` / `nbf` / `iat` claim semantics), RFC 7517 (JWKS), RFC 7519 (JWT), RFC 7518 (JWA — asymmetric algorithms).
- Upstream OpenFGA reference (verified via `openfga.dev/docs/getting-started/setup-openfga/configure-openfga`): mode string `oidc`, configuration keys `authn.oidc.{issuer, audience, issuerAliases, subjects}`. Our env-var naming continues the established `OPENFGA_AUTH_*` convention from `openfga-ywi` (not upstream's `AUTHN`) for repo consistency.
- Implementation library: **`jose`** (Panva). ESM-first JWT verification with `createRemoteJWKSet` for JWKS rotation. Chosen over Hono's built-in `jwk` middleware because the spec's structured error-reason logging table needs per-failure granularity that the built-in does not expose.
- Existing dispatcher seam: `src/middleware/auth.ts` already documents OIDC as the third mode and routes config via `getAuthConfig()`.

## Business Intent

The auth middleware accepts `none` and `preshared` today. Deployments behind enterprise identity providers (Okta, Auth0, Microsoft Entra ID, Keycloak, AWS Cognito) need bearer-token auth where the bearer is a signed JWT validated against a public JWKS, not a static secret. OIDC mode closes that gap and matches upstream OpenFGA's caller-auth surface so `@openfga/sdk` clients configured with a token provider work against this server without code changes.

The pipeline is pure HTTP-boundary work: extract `Authorization: Bearer <jwt>`, verify the signature against the issuer's JWKS, validate standard claims (`iss`, `aud`, `exp`, `nbf`), apply optional `sub` and `client_id` allowlists, and pass through. The OpenFGA wire shape for authorized requests is unchanged.

## Goals

- New auth mode `oidc` selectable via `config.auth.mode = 'oidc'`. Existing `none` and `preshared` modes are unaffected.
- Bearer-token validation against the issuer's published JWKS, with automatic JWKS rotation on `kid` miss via `jose.createRemoteJWKSet`.
- Configurable `issuer`, `audience`, optional `issuerAliases`, optional `subjects` allowlist, optional `clients` allowlist.
- Configurable allowed algorithms (default: the asymmetric set — `RS256`, `RS384`, `RS512`, `ES256`, `ES384`, `PS256`, `PS512`).
- Configurable clock skew tolerance for `exp` / `nbf` (default: 60 seconds).
- Fail-fast at startup when `oidc` mode is selected but required configuration is missing or the issuer's discovery document is unreachable.
- `/health` and `/ready` remain auth-exempt (`src/routes/index.ts` already scopes the auth middleware to `/stores/*`).
- Documentation in `openfga.config.example.yaml`, `.env.example`, and the README auth section.

## Non-Goals

- **No token issuance.** This server validates tokens; it does not mint them. No `/token`, `/authorize`, or userinfo endpoints.
- **No HS256 / shared-secret JWTs.** OIDC mode is for asymmetric verification against a published JWKS. A static-secret-with-JWT pattern offers no security advantage over the existing `preshared` mode and complicates the validation matrix.
- **No RFC 7662 introspection-endpoint fallback.** Stay JWT-only for v1.
- **No per-token claim → tuple mapping.** Authorization model is unaffected; the token only proves the *caller* is authenticated. Tuple-level user identity is established by the OpenFGA `user` field on each request as today.
- **No JWKS pinning beyond `kid`-based rotation.** Operators rotate keys via the issuer; this server follows the published set.
- **No PRD edits without separate explicit permission.** The `shared_key` / `preshared` discrepancy in PRD §"API caller authentication" is documented as an Open Question — fixing it requires a separate user approval per the repo's hard rule on PRD changes.

## Wire-Level Contract

Authorized requests follow the same shape as `preshared` mode:

```
POST /stores/01ABC.../check
Authorization: Bearer eyJhbGciOiJSUzI1NiIs...
Content-Type: application/json

{ "tuple_key": ..., ... }
```

The wire-level difference between modes is what the bearer token *contains* and how the server validates it. Success returns the unchanged OpenFGA response. Failure returns the existing 401 envelope:

```json
{ "code": "unauthenticated", "message": "missing or invalid Authorization header" }
```

The error envelope, status code, and absence of detail are intentional. Distinguishing "expired" vs "wrong audience" vs "bad signature" in the client-facing response only helps attackers; operators get the actual reason from structured logs.

## Configuration Surface

Extends the `auth` section already in `openfga.config.example.yaml`:

```yaml
auth:
  mode: oidc                              # was: none | preshared. Adds: oidc.
  presharedKeys: []                       # ignored when mode=oidc

  oidc:
    issuer: https://auth.example.com      # required when mode=oidc
    audience: openfga-server              # required when mode=oidc
    # Optional — accept additional iss values for federated providers
    # whose iss claim does not exactly match the discovery URL.
    issuerAliases: []
    # Optional — restrict accepted callers to a fixed sub allowlist.
    # Empty = accept any sub the issuer signs for.
    subjects: []
    # Optional — restrict by client_id (Auth0/Okta) or azp (OIDC spec).
    # Empty = accept any client.
    clients: []
    # Optional — restrict accepted signing algorithms.
    # Default: every asymmetric alg jose supports.
    algorithms: [RS256, RS384, RS512, ES256, ES384, PS256, PS512]
    # Optional — clock skew tolerance for exp / nbf in seconds.
    clockSkewSec: 60
    # Optional — explicit JWKS URI override. Default discovery via
    # ${issuer}/.well-known/openid-configuration → jwks_uri.
    jwksUri: ''
    # Optional — JWKS cache lifetime and the minimum gap between
    # kid-miss refetches, in milliseconds.
    jwksCacheMaxAgeMs: 600000
    jwksCooldownMs: 30000
```

### Zod schema additions (`src/config-schema.ts`)

- New `OidcSchema` exporting an enum-validated `algorithms` array. HS256 / HS384 / HS512 are explicitly rejected via `.refine` (matches §Non-Goals).
- `auth.mode` enum extended: `['none', 'preshared', 'oidc']`.
- `auth.oidc` optional at the schema level so non-OIDC deployments are unaffected.
- Cross-field constraint (`superRefine` on the root schema): when `auth.mode === 'oidc'`, require `auth.oidc.issuer` non-empty AND `auth.oidc.audience` non-empty. Preserve the existing `auth.mode === 'preshared'` requires `presharedKeys` rule.

## Env-Var Override Mapping

| Env var | Config path | Type |
|---|---|---|
| `OPENFGA_AUTH_MODE` | `auth.mode` | enum `none\|preshared\|oidc` |
| `OPENFGA_AUTH_OIDC_ISSUER` | `auth.oidc.issuer` | string |
| `OPENFGA_AUTH_OIDC_AUDIENCE` | `auth.oidc.audience` | string |
| `OPENFGA_AUTH_OIDC_ISSUER_ALIASES` | `auth.oidc.issuerAliases` | comma-string → string[] |
| `OPENFGA_AUTH_OIDC_SUBJECTS` | `auth.oidc.subjects` | comma-string → string[] |
| `OPENFGA_AUTH_OIDC_CLIENTS` | `auth.oidc.clients` | comma-string → string[] |
| `OPENFGA_AUTH_OIDC_ALGORITHMS` | `auth.oidc.algorithms` | comma-string → string[] |
| `OPENFGA_AUTH_OIDC_CLOCK_SKEW_SEC` | `auth.oidc.clockSkewSec` | non-negative int |
| `OPENFGA_AUTH_OIDC_JWKS_URI` | `auth.oidc.jwksUri` | string |
| `OPENFGA_AUTH_OIDC_JWKS_CACHE_MAX_AGE_MS` | `auth.oidc.jwksCacheMaxAgeMs` | non-negative int (default 600000) |
| `OPENFGA_AUTH_OIDC_JWKS_COOLDOWN_MS` | `auth.oidc.jwksCooldownMs` | non-negative int (default 30000) |

`src/config-env-overrides.ts` gains a new section mirroring the existing comma-string handling for `OPENFGA_AUTH_PRESHARED_KEYS` (split, trim, drop empties).

Empty-string semantics follow `docs/features/configuration.md` §"Empty-String Semantics": empty optional strings map to undefined; empty integers fall back to schema default; empty comma-arrays produce empty arrays.

## Middleware Composition

New module `src/middleware/oidc.ts`. Public surface:

```ts
export function oidcMiddleware(oidc: OidcConfig): MiddlewareHandler
```

`src/middleware/auth.ts` adds a third dispatcher branch:

```ts
export function authMiddleware(authConfig: AuthConfig): MiddlewareHandler {
  if (authConfig.mode === 'none') return passThrough
  if (authConfig.mode === 'preshared') return presharedMiddleware(authConfig.presharedKeys)
  if (authConfig.mode === 'oidc') return oidcMiddleware(authConfig.oidc!)
  // exhaustive — TS narrows on the enum
}
```

The non-null assertion on `authConfig.oidc` is safe because the schema's `superRefine` already enforced presence when `mode === 'oidc'`. The factory pattern matches `preshared`: heavy lifting (JWKS resolution, validation context) happens once at composition time; the per-request handler is `validate(token) → next() | 401`.

## Validation Pipeline

Per request:

1. Read `Authorization` header. Reject (`reason: 'missing_authorization'` or `'wrong_scheme'`) if missing or not the `Bearer` scheme. The scheme name is matched case-insensitively (`Bearer`, `bearer`, `BEARER`) per RFC 7235 and may be followed by one or more spaces before the token.
2. Extract JWT. Pass to `jose.jwtVerify(token, jwks, { issuer, audience, algorithms, clockTolerance })`.
3. `jose.jwtVerify` validates:
   - Signature against JWKS (`createRemoteJWKSet` auto-fetches on `kid` miss, with a cooldown, 30 seconds by default, to prevent abuse).
   - `iss` matches `issuer` or any value in `issuerAliases` (we pass an array to `jwtVerify`'s `issuer` option).
   - `aud` contains `audience`.
   - `exp` is required: a token with no `exp` claim is rejected with `reason: 'time_claim_invalid'`. A present `exp` must not be before `now - clockSkewSec`.
   - `nbf` not after `now + clockSkewSec`.
   - `alg` is in the allowed set (enforces algorithm pinning; defends against `alg=none` and HS* downgrades).
4. If `subjects` non-empty: token `sub` claim must be in the allowlist. Otherwise 401 with `reason: 'sub_disallowed'`.
5. If `clients` non-empty: token `client_id` (Auth0) or `azp` (OIDC spec) must be in the allowlist. Otherwise 401 with `reason: 'client_disallowed'`.
6. Attach `caller = { sub, iss, scope }` to the Hono `Context` for downstream logging. **Not** consumed by the OpenFGA evaluator or tuple semantics.
7. Call `next()`.

## Startup Discovery

When `auth.mode === 'oidc'`, the factory:

1. Resolves the JWKS URI: explicit `auth.oidc.jwksUri` config wins; otherwise fetch `${issuer}/.well-known/openid-configuration` once at boot and take its `jwks_uri`.
2. Constructs a `jose.createRemoteJWKSet(new URL(jwksUri))` with `cacheMaxAge` and `cooldownDuration` taken from `auth.oidc.jwksCacheMaxAgeMs` (default 600000, 10 min) and `auth.oidc.jwksCooldownMs` (default 30000, 30 sec).
3. **Does not** block boot on JWKS contents — the set lazily fetches on first request.
4. The OIDC discovery fetch uses a 5-second timeout with one retry. If both attempts fail, log FATAL with `reason: 'oidc_discovery_failed'` and exit non-zero. Matches the boot fail-fast pattern at `src/server.ts:34-39` (`requireDbUrl`).

Discovery is shared and memoized: boot-time prefetch and every middleware built for the same issuer, JWKS URI, and cache settings reuse one discovery promise, so concurrent requests do not each re-run discovery. A failed discovery is not cached permanently: after a 5-second backoff the next request starts discovery again, and meanwhile requests receive a uniform 401 with `reason: 'jwks_unavailable'`. Boot-time discovery failure remains fatal.

Rationale: an unreachable issuer at boot is fatal (operator misconfiguration). JWKS-fetch failures during normal operation are per-request 401s with structured logs — not a server-wide outage.

## Auth Mode `none`

When `auth.mode` is `none` the server accepts unauthenticated requests and logs a startup warning (`auth_disabled`) advising `preshared` or `oidc` for any non-local deployment. Idempotency records in this mode share one anonymous principal.

## Error Semantics

All client-facing responses use the existing envelope (`code: 'unauthenticated'`, `message: 'missing or invalid Authorization header'`, HTTP `401`). Operators distinguish failures via structured logs:

| Failure | HTTP | Log fields (in addition to method/path) |
|---|---|---|
| No `Authorization` header | 401 | `reason: 'missing_authorization'` |
| Non-`Bearer` scheme | 401 | `reason: 'wrong_scheme'` |
| Malformed JWT | 401 | `reason: 'jwt_malformed'`, `err` |
| Signature invalid | 401 | `reason: 'signature_invalid'`, `kid` (if present) |
| `iss` mismatch | 401 | `reason: 'iss_mismatch'`, observed `iss` |
| `aud` mismatch | 401 | `reason: 'aud_mismatch'`, observed `aud` |
| `exp` / `nbf` violation | 401 | `reason: 'time_claim_invalid'`, `exp` and/or `nbf` |
| `alg` not in allowlist | 401 | `reason: 'alg_disallowed'`, observed `alg` |
| `sub` not in allowlist | 401 | `reason: 'sub_disallowed'`, observed `sub` |
| `client_id` / `azp` not in allowlist | 401 | `reason: 'client_disallowed'`, observed value |
| JWKS fetch failed | 401 | `reason: 'jwks_unavailable'`, `err`, `kid` |

## Test Strategy

Module structure for testability follows the same pattern as `src/middleware/idempotency.ts`: the middleware factory accepts an explicit `OidcConfig` argument so tests construct the middleware without going through the global `config` Proxy. Tests that exercise the env-driven path use `reloadConfigForTests()` per `docs/features/configuration.md` §"Test Strategy".

### Unit tests (`tests/unit/oidc.test.ts`)

- Generate test RSA and EC keypairs at suite startup (`jose.generateKeyPair('RS256')`, `jose.generateKeyPair('ES256')`).
- Mount a Hono app with `oidcMiddleware(...)` and a fixture JWKS endpoint served from an in-process `Hono` instance.
- Required cases:
  - Valid `RS256` token signed by the issuer → 200.
  - Valid `ES256` token signed by the issuer → 200.
  - Expired token (`exp` in the past) → 401, `reason: 'time_claim_invalid'`.
  - Not-yet-valid token (`nbf` in the future) → 401.
  - Wrong issuer → 401, `reason: 'iss_mismatch'`.
  - Wrong audience → 401, `reason: 'aud_mismatch'`.
  - Issuer alias accepted → 200 (token's `iss` matches an entry in `issuerAliases`).
  - Subject allowlist match → 200.
  - Subject not in allowlist → 401, `reason: 'sub_disallowed'`.
  - Client allowlist match (via `client_id` claim) → 200.
  - Client allowlist match (via `azp` claim) → 200.
  - HS256 token rejected even if signature would verify, when not in `algorithms` → 401.
  - `alg=none` rejected → 401.
  - Unknown `kid` triggers JWKS refresh and then accepts → 200.
  - JWKS fetch fails on first request → 401, `reason: 'jwks_unavailable'`.
  - Clock-skew tolerance: token with `exp` within `clockSkewSec` of now → 200.

### Schema test (`tests/unit/config-schema.test.ts`)

- `mode: 'oidc'` without `oidc.issuer` → ZodError with a clear message identifying the missing field.
- `mode: 'oidc'` without `oidc.audience` → ZodError.
- `mode: 'oidc'` with HS256 in `algorithms` → ZodError (rejected by the algorithm `.refine`).

### Env-overlay test (`tests/unit/config-env-overrides.test.ts`)

- Each `OPENFGA_AUTH_OIDC_*` env var maps to the documented nested path. Empty values fall through to schema defaults per the documented semantics.

### Integration test (`tests/integration/oidc-auth.test.ts`)

- Stand up an in-process HTTP server publishing a fixture JWKS at `/.well-known/jwks.json` and a discovery doc at `/.well-known/openid-configuration`.
- Set `auth.mode = 'oidc'` with `issuer` pointing at the fixture and `audience: 'test'`.
- Build the full `buildApp()` stack and exercise:
  - `GET /health` → 200 unauthenticated (auth-exempt).
  - `POST /stores/.../check` with valid token → 200, OpenFGA response body unchanged.
  - `POST /stores/.../check` with expired token → 401 with the standard envelope.
  - JWKS rotation: add a new key to the fixture set, sign a token with the new `kid`, send it — first request triggers refresh, second hits cache.

## Dependency Changes

- Add: `jose` pinned to the latest stable major (verify the exact pin at implementation time per the c12-beta lesson — `pnpm view jose dist-tags` before installing).
- No removals.

## Boot Sequence Notes

OIDC discovery runs at config-load-adjacent time, not at module evaluation of `src/config.ts`. The flow:

1. `src/config.ts` loads (sync structural validation only).
2. `src/server.ts` calls `requireDbUrl(...)`, then composes the route stack via `buildApp()`.
3. `buildApp()` calls `authMiddleware(getAuthConfig())`. When `auth.mode === 'oidc'`, that triggers a one-shot OIDC discovery fetch.
4. Failure of (3) is fatal pre-listener; matches today's pre-listener fail-fast for missing `OPENFGA_DB_URL`.

This means the discovery network call happens BEFORE the HTTP listener binds, so a misconfigured issuer cannot accept any traffic. Tests for the `oidc_discovery_failed` path drive this path explicitly via `buildApp()`.

## Acceptance Criteria

- `config.auth.mode = 'oidc'` is accepted by the schema with required `auth.oidc.{issuer, audience}`.
- Zod schema rejects `mode=oidc` without `issuer` or without `audience` at config load with a clear error tree.
- Zod schema rejects HS256/HS384/HS512 in `auth.oidc.algorithms`.
- Every `OPENFGA_AUTH_OIDC_*` env var in the mapping table produces the documented nested config value when set.
- `authMiddleware(getAuthConfig())` with `mode=oidc` rejects unauthenticated `/stores/*` requests with `401` and the existing error envelope.
- Valid JWTs (signed by the configured issuer's JWKS, with matching `iss`/`aud`, current `exp`/`nbf`, allowed `alg`, and matching allowlists if configured) pass through. OpenFGA response bodies are identical to the `none` and `preshared` paths.
- JWKS rotation: a token signed by a key newly added to the issuer's JWKS is accepted on the first request that references its `kid`.
- Issuer-unreachable-at-startup is FATAL with `reason: 'oidc_discovery_failed'` in the structured log, before any listener binds.
- `/health` and `/ready` remain auth-exempt (no regression on the existing scope).
- Tests cover at minimum every case listed in §"Test Strategy".
- `openfga.config.example.yaml` documents the `auth.oidc` block.
- `.env.example` documents every `OPENFGA_AUTH_OIDC_*` variable.
- `README.md` auth section references OIDC mode and links to this spec.

## Open Questions

- **PRD `shared_key` vs upstream `preshared` discrepancy**: `docs/PRD.md` §"API caller authentication" L148 uses `shared_key`. Upstream OpenFGA uses `preshared` (verified via `openfga.dev/docs/getting-started/setup-openfga/configure-openfga`). This codebase already shipped `preshared` under `openfga-ywi` matching upstream. The PRD is the outlier. Fixing it is a one-line PRD edit that requires explicit user approval per the hard rule on `docs/PRD.md` changes. **Action item: get user sign-off to update PRD L148 from `shared_key` to `preshared`. Not part of this feature's implementation; tracked here so it isn't forgotten.**
- **Hono built-in `jwk` middleware as an alternative**: the bead's DESIGN field mentions Hono's built-in JWK middleware. This spec chose `jose` directly for finer-grained error-reason logging. Decision recorded; revisit if the per-failure log granularity turns out to be unnecessary in practice.
- **Caller context propagation to OpenTelemetry**: when `openfga-371` (OTel) lands, the validated `sub` should be added to the request span attributes. Out of scope here; flagged for openfga-371's spec.
- **Multi-issuer / multi-tenant**: `issuerAliases` covers one issuer's alternate URIs (e.g. trailing slash, http vs https). True multi-tenant multi-issuer auth (different JWKS per request based on a tenant header) is out of scope. Revisit if a concrete use case appears.
- **`scope` claim enforcement**: not validated by this feature. If a future deployment needs `scope: 'openfga:write'` style fine-grained gating, that's a follow-up feature.
- **CASS / OPA upstream alignment**: upstream OpenFGA's `subjects` allowlist is a *substring filter* per its documentation. This spec proposes an exact-match allowlist for clarity. Open: prefer exact-match (this spec) or upstream-bug-compatible substring (operator surprise low, semantics clearer)? Lean exact-match; document the divergence explicitly in the implementation.
