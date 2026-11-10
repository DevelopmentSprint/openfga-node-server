# Auth0 / Okta FGA SDK Client

[`@openfga/sdk`](https://www.npmjs.com/package/@openfga/sdk) — the
official SDK published by Okta / Auth0 — works directly against
NodeFGA. Use the same client patterns you'd use against any other
OpenFGA-protocol server.

## Install

```sh
pnpm add @openfga/sdk
```

## Minimal example

```ts
import { OpenFgaClient } from '@openfga/sdk'

const fga = new OpenFgaClient({
  apiUrl:                 process.env.OPENFGA_API_URL!,   // e.g., https://openfga.example.com
  storeId:                process.env.OPENFGA_STORE_ID!,
  authorizationModelId:   process.env.OPENFGA_MODEL_ID,   // optional; uses latest if omitted
})

const result = await fga.check({
  user:     'user:alice',
  relation: 'viewer',
  object:   'document:doc-1',
})

if (result.allowed) {
  // …
}
```

## With pre-shared key auth

```ts
import { OpenFgaClient, CredentialsMethod } from '@openfga/sdk'

const fga = new OpenFgaClient({
  apiUrl:  process.env.OPENFGA_API_URL!,
  storeId: process.env.OPENFGA_STORE_ID!,
  credentials: {
    method: CredentialsMethod.ApiToken,
    config: { token: process.env.OPENFGA_PRESHARED_KEY! },
  },
})
```

The SDK sets `Authorization: Bearer <token>` on every request, which
is exactly what `auth.mode = preshared` expects.

## With OIDC client credentials

```ts
import { OpenFgaClient, CredentialsMethod } from '@openfga/sdk'

const fga = new OpenFgaClient({
  apiUrl:  process.env.OPENFGA_API_URL!,
  storeId: process.env.OPENFGA_STORE_ID!,
  credentials: {
    method: CredentialsMethod.ClientCredentials,
    config: {
      apiTokenIssuer:   'auth.example.com',
      apiAudience:      'openfga-server',
      clientId:         process.env.OIDC_CLIENT_ID!,
      clientSecret:     process.env.OIDC_CLIENT_SECRET!,
    },
  },
})
```

The SDK calls the issuer's token endpoint to mint a JWT, caches it
in memory until expiry, and sends it as Bearer on every request.
NodeFGA validates the JWT against the same issuer's
JWKS.

## Common operations

### `check`

```ts
const result = await fga.check({
  user:     'user:alice',
  relation: 'editor',
  object:   'document:doc-1',
})
// result.allowed: boolean
```

### `expand`

```ts
const result = await fga.expand({
  relation: 'editor',
  object:   'document:doc-1',
})
// result.tree: the userset-tree representation
```

Use when you need the *reasoning* behind a check (debugging
"why does Alice get editor?"). Not for production hot-path; `check`
is the right primitive there.

### `listObjects` — "what can this user see?"

```ts
const result = await fga.listObjects({
  user:     'user:alice',
  relation: 'viewer',
  type:     'document',
})
// result.objects: string[] — list of object ids
```

Useful for populating UI lists. Be mindful: `listObjects` walks the
model bottom-up and can be expensive at scale; consider caching
results at the application layer for read-heavy paths.

### `listUsers` — "who has access to this object?"

```ts
const result = await fga.listUsers({
  object:       { type: 'document', id: 'doc-1' },
  relation:     'viewer',
  userFilters:  [{ type: 'user' }],
})
// result.users: user-ish objects
```

### `write` — add tuples

```ts
await fga.write({
  writes: [
    { user: 'user:alice', relation: 'viewer', object: 'document:doc-1' },
  ],
})
```

### `delete` — remove tuples

```ts
await fga.write({
  deletes: [
    { user: 'user:alice', relation: 'viewer', object: 'document:doc-1' },
  ],
})
```

### `batchCheck` — multiple checks in one round-trip

```ts
const result = await fga.batchCheck({
  checks: [
    { user: 'user:alice', relation: 'viewer', object: 'document:doc-1', correlationId: 'a' },
    { user: 'user:alice', relation: 'editor', object: 'document:doc-1', correlationId: 'b' },
  ],
})
// result.responses: per-check outcome with correlationId
```

Each `correlationId` must be unique within the request and 1 to 36
characters of ASCII letters, digits, underscore or hyphen. A request
with more checks than `maxChecksPerBatchCheck` (default 50; env
`OPENFGA_MAX_CHECKS_PER_BATCH_CHECK`) or with a repeated id is rejected
with `400 validation_error`. If one check fails, that item carries its
own error and the other results are returned normally.

## Idempotency-Key on writes

If you've enabled
[idempotency](/guide/idempotency) on the server, pass a key per
logical write:

```ts
await fga.write(
  {
    writes: [{ user: 'user:alice', relation: 'viewer', object: 'document:doc-1' }],
  },
  {
    additionalHeaders: { 'Idempotency-Key': someUlid },
  },
)
```

Retrying the same operation with the same key returns the original
response without re-executing the write. See
[Idempotency](/guide/idempotency) for the full contract.

## Error handling

The SDK throws `FgaApiError` subclasses on non-2xx responses:

```ts
import { FgaApiError, FgaApiAuthenticationError, FgaApiValidationError } from '@openfga/sdk'

try {
  await fga.check({ user: 'user:alice', relation: 'editor', object: 'doc:1' })
}
catch (err) {
  if (err instanceof FgaApiAuthenticationError) {
    // 401 — token expired or rejected
  }
  else if (err instanceof FgaApiValidationError) {
    // 400 — malformed tuple, unknown relation, etc.
  }
  else if (err instanceof FgaApiError) {
    // other 4xx/5xx
  }
  else {
    // network / unexpected
  }
}
```

The 401 path will fire when:

- `auth.mode = preshared` and the key was rotated out
  (see [Rotate Pre-Shared Keys](/runbooks/rotate-preshared-keys))
- `auth.mode = oidc` and the JWT expired faster than the SDK
  refreshed it
- `auth.mode = oidc` and the OIDC issuer's JWKS rotated

The OIDC SDK refresh path generally hides this from you, but it's
worth handling for robustness.

## Pointing at a different server

If you ever need to move off NodeFGA, your SDK code itself doesn't
change — `apiUrl` swaps and tuples/models migrate via the
[migration runbook](/runbooks/migrate-to-upstream-openfga).

## See also

- [OpenFGA SDK docs](https://openfga.dev/docs/getting-started/install-sdk)
- [GitHub-Style Permissions](/recipes/github-permissions)
- [Document Sharing](/recipes/document-sharing)
