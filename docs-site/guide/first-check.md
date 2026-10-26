# Your First Authorization Check

The flow from a clean install to a passing `check` is five
steps. Every example uses `curl` and a running server on `:8080`.

## 1. Create a store

```sh
curl -sS -X POST http://localhost:8080/stores \
  -H 'Content-Type: application/json' \
  -d '{"name":"demo"}' | jq
```

Response:

```json
{
  "id": "01HXYZ…",
  "name": "demo",
  "created_at": "2026-…",
  "updated_at": "2026-…"
}
```

Save the `id` — every subsequent call needs it.

## 2. Load an authorization model

Use the bundled GitHub-style fixture:

```sh
STORE_ID=01HXYZ… pnpm load-model tests/fixtures/github.fga
```

`load-model` reads the `.fga` DSL, compiles it via
`@openfga/syntax-transformer`, posts the JSON model to the
server's `/stores/:storeId/authorization-models` endpoint, and
prints the resulting `OPENFGA_MODEL_ID`.

## 3. Write a tuple

```sh
curl -sS -X POST http://localhost:8080/stores/$STORE_ID/write \
  -H 'Content-Type: application/json' \
  -d '{
    "writes": {
      "tuple_keys": [
        { "user": "user:alice", "relation": "owner", "object": "repo:openfga/demo" }
      ]
    }
  }' | jq
```

Returns `{}` on success. The tuple is persisted in
`<namespace>.tuple` and a corresponding row is recorded in
`<namespace>.tuple_change` for the changelog.

## 4. Run a check

```sh
curl -sS -X POST http://localhost:8080/stores/$STORE_ID/check \
  -H 'Content-Type: application/json' \
  -d '{
    "tuple_key": {
      "user": "user:alice",
      "relation": "owner",
      "object": "repo:openfga/demo"
    }
  }' | jq
```

Response:

```json
{ "allowed": true }
```

## 5. Run a `check` that should fail

```sh
curl -sS -X POST http://localhost:8080/stores/$STORE_ID/check \
  -H 'Content-Type: application/json' \
  -d '{
    "tuple_key": {
      "user": "user:bob",
      "relation": "owner",
      "object": "repo:openfga/demo"
    }
  }' | jq
# { "allowed": false, "resolution": "" }
```

## What just happened

The `/check` endpoint runs the OpenFGA rewrite algebra against the
authorization model and the persisted tuple store. For this
simple case the rewrite for `owner` is `this` (direct relation),
so the evaluator just looks up whether
`(repo:openfga/demo, owner, user:alice)` is in the tuple table.

For non-trivial models (groups, teams, computed usersets), the
evaluator recursively walks the rewrite tree. See
[Recipes](/recipes/github-permissions) for richer examples
including `team#member` style userset membership and
`computedUserset` flattening.

## From here

- **[Authentication](/guide/authentication)** — gate `/stores/*`
  with pre-shared keys or OIDC before anyone hits your server.
- **[Observability](/guide/observability)** — turn on
  OpenTelemetry traces and watch the evaluator span tree.
- **[Recipes](/recipes/github-permissions)** — copy-pasteable
  models and tuple sets for common patterns.
