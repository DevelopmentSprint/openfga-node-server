# Migrate to Upstream OpenFGA

NodeFGA implements the [OpenFGA](https://openfga.dev) model for supported
authorization features. Project-owned SDK tests exercise implemented endpoints;
upstream OpenFGA conformance has not been verified. Validate your application's
models and API calls against the upstream server before a cutover. See
[compatibility evidence](/guide/getting-started#compatibility-evidence).

## What's compatible

| Surface | Compatibility |
|---|---|
| HTTP API contract | Project-owned tests cover implemented endpoints through `@openfga/sdk`; complete API parity is not verified. |
| Authorization model DSL (`.fga`) | Parsed with `@openfga/syntax-transformer`; evaluator support is limited to NodeFGA's supported features. |
| Tuple shape | `(user, relation, object)`. Standard model-defined conditional tuples are supported; experimental dynamic conditions are not. |
| Store / model ids | ULID; same format both servers. |

## What's NOT compatible

| Surface | Why |
|---|---|
| Postgres schema | Different. Upstream uses a Go-migrations schema; this server uses a Kysely-managed schema. Tables are not directly interchangeable. |
| Pre-shared-key format | Upstream accepts the same `Authorization: Bearer …` shape, but the key allowlist is configured differently. |
| OIDC claims handling | Logically identical; flag names differ. |
| Operational metrics | This server uses OpenTelemetry; upstream emits Prometheus-formatted metrics. |

## Migration approach

The cutover is **API-replay** rather than database-copy. Don't try
to pg_dump from this server into upstream's schema.

### Step 1 — Stand up upstream OpenFGA alongside

Deploy upstream OpenFGA in parallel against an empty database.
Configure it identically to your current NodeFGA
deployment (same auth mode, same TLS, same hostname strategy).

```sh
docker run --rm \
  -e OPENFGA_DATASTORE_ENGINE=postgres \
  -e OPENFGA_DATASTORE_URI='postgres://…' \
  openfga/openfga migrate
```

Then run the server. See the upstream
[deployment docs](https://openfga.dev/docs/getting-started/setup-openfga)
for the full env-var map.

### Step 2 — Replay stores and models

For each store on the source server:

```sh
# Source: list stores via the node-server API
STORES=$(curl -sS http://openfga-source/stores | jq -r '.stores[].id')

for STORE_ID in $STORES; do
  # Read store metadata
  STORE=$(curl -sS http://openfga-source/stores/$STORE_ID)

  # Recreate on upstream
  NEW_STORE=$(curl -sS -X POST http://openfga-target/stores \
    -H 'Content-Type: application/json' \
    -d "$(echo $STORE | jq '{name}')")

  NEW_STORE_ID=$(echo "$NEW_STORE" | jq -r '.id')

  # Replay models (in order)
  curl -sS "http://openfga-source/stores/$STORE_ID/authorization-models" \
    | jq -r '.authorization_models | reverse | .[]' \
    | while read -r MODEL; do
        curl -sS -X POST http://openfga-target/stores/$NEW_STORE_ID/authorization-models \
          -H 'Content-Type: application/json' \
          -d "$MODEL"
      done

  echo "store $STORE_ID → $NEW_STORE_ID"
done
```

(This is the structure. Production-grade replay handles pagination,
backpressure, and concurrent writes. Bundle as a script appropriate
for your scale.)

### Step 3 — Replay tuples

For each store, page through `/read-changes` from the beginning of
time and replay each change against the target:

```sh
CONTINUATION=""
while :; do
  RESP=$(curl -sS "http://openfga-source/stores/$STORE_ID/changes?page_size=100&continuation_token=$CONTINUATION")
  echo "$RESP" | jq -r '.changes[] | @json' | while read -r CHG; do
    OP=$(echo "$CHG" | jq -r '.operation')
    TUPLE=$(echo "$CHG" | jq -c '.tuple_key')
    if [ "$OP" = "TUPLE_OPERATION_WRITE" ]; then
      curl -sS -X POST "http://openfga-target/stores/$NEW_STORE_ID/write" \
        -H 'Content-Type: application/json' \
        -d "{\"writes\":{\"tuple_keys\":[$TUPLE]}}"
    elif [ "$OP" = "TUPLE_OPERATION_DELETE" ]; then
      curl -sS -X POST "http://openfga-target/stores/$NEW_STORE_ID/write" \
        -H 'Content-Type: application/json' \
        -d "{\"deletes\":{\"tuple_keys\":[$TUPLE]}}"
    fi
  done
  CONTINUATION=$(echo "$RESP" | jq -r '.continuation_token // ""')
  [ -z "$CONTINUATION" ] && break
done
```

Replaying from the changelog (rather than dumping the tuple table)
preserves the eventual state correctly even if your source had
intermediate writes-then-deletes for the same tuple.

### Step 4 — Cut over

Once the target is caught up:

1. **Pause writes** at the source. Either stop the source server,
   or DNS-route writes to an error page.
2. **Drain the source changelog** to the target one final time.
3. **Switch DNS / load balancer** to the target.
4. **Resume traffic.**

The cutover window is bounded by step 2's drain — typically seconds
to minutes depending on tuple-change rate.

## Going the other direction

NodeFGA can also receive a replay from upstream
OpenFGA. The same script structure works in reverse — the API
contracts are symmetric.

## Why no schema-level dump?

Two reasons:

1. **Different table shapes.** The migrations diverge in indexing,
   constraint placement, and (for some tables) column types. A SQL
   dump would not import cleanly.
2. **No verification step.** The API-replay path naturally exercises
   the target's evaluator. Schema dump + import would leave a class
   of "the schema accepted it but the evaluator misreads it" bugs
   silent until production traffic hits them.

## See also

- [Wire compatibility](https://openfga.dev/docs/getting-started/setup-openfga) — upstream docs
- [Database Backends](/guide/database) — this server's schema layout
