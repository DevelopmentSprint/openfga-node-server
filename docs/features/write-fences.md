# Durable write fences

Write fencing is an optional, non-upstream extension for callers that serialize tuple projection under expiring leases (one active writer per queue, handed over between processes). It lets a writer acquire a monotonically increasing *generation* for a queue and attach it to its tuple writes, so that once a successor has acquired a newer generation, no write under an older generation can commit.

Upstream OpenFGA (reference version v1.22.0) has no equivalent. A timeout-only proxy in front of upstream does not provide the same guarantee.

## Enabling

| Config path | Env var | Type | Default |
|---|---|---|---|
| `writeFences.enabled` | `OPENFGA_WRITE_FENCES_ENABLED` | strict boolean (`true`/`false`) | `false` |

The flag is read when the server builds its routes, so changing it requires a restart.

**Disabled (default).** The HTTP surface is identical to upstream OpenFGA:

- The acquisition route is not mounted. `PUT /x-ext/...` (and every other `/x-ext/` path) returns `404 {"code":"undefined_endpoint","message":"Endpoint not enabled"}`.
- `X-Write-Fence-Key`, `X-Write-Fence-Generation` and `X-Not-After` on `POST /stores/{store_id}/write` are ignored entirely, whether well-formed or not.

**Enabled.** Requests without fence headers behave exactly as when disabled. Fence headers and the acquisition route behave as specified below.

The `write_fence` table is created by migration `1794500000000_write-fences` regardless of the flag, so enabling the extension later needs no schema change.

## Acquire a generation

```
PUT /x-ext/stores/{store_id}/write-fences/{key}
Content-Type: application/json

{ "generation": "42", "not_after": "2030-01-01T00:00:00Z" }
```

The route uses an extension prefix outside the upstream path space. It passes through the same middleware as `/stores/{store_id}/...` routes: authentication (`none`, `preshared` or `oidc`), the store-existence check, the request body limit, request validation and request logging. It is not subject to `Idempotency-Key` handling; acquisition is idempotent by itself.

- `key` (path): a stable, opaque identifier of one serialization queue. 1–128 characters from ASCII letters, digits, `.`, `_`, `:` and `-`, starting with a letter or digit.
- `generation` (body, string): canonical positive decimal, no sign, no leading zeros, at most `9223372036854775807`. Generations are compared numerically (`"10"` is newer than `"9"`).
- `not_after` (body, string): the lease expiry, RFC 3339 in UTC (`Z` suffix), optional fractional seconds. Normalized to millisecond precision (`YYYY-MM-DDTHH:mm:ss.sssZ`).
- No other body fields are accepted.

Success returns `200` with the acquired fence:

```json
{ "key": "queue-one", "generation": "42", "not_after": "2030-01-01T00:00:00.000Z" }
```

| Stored state for `(store_id, key)` | Request | Result |
|---|---|---|
| none | any generation | `200`, generation and expiry stored |
| generation G | generation > G | `200`, generation and expiry replaced |
| generation G, expiry E | generation G, expiry E (after normalization) | `200`, unchanged (safe retry) |
| generation G, expiry E | generation G, different expiry | `409 write_fence_rejected` |
| generation G | generation < G | `409 write_fence_rejected` |

A generation's expiry is immutable: renewing a lease requires a new generation. Acquisition waits until every older in-flight fenced write of the store has committed or rolled back (see Locking), then commits. The caller must start processing only after acquisition has succeeded and it still owns its local lease. Callers allocate generations monotonically in their own authoritative lease store.

## Write under the fence

Every `POST /stores/{store_id}/write` of a fenced queue carries:

| Header | Value |
|---|---|
| `X-Write-Fence-Key` | the acquired key |
| `X-Write-Fence-Generation` | the acquired generation |
| `X-Not-After` | RFC 3339 UTC deadline for this request, normally the lease expiry |

`X-Not-After` may also be sent alone, for deadline admission without generation fencing. A key without a generation, a generation without a key, or a key and generation without `X-Not-After` is malformed. The request body and response are the standard OpenFGA Write contract.

Order of checks for a write with fence headers:

1. Authentication and the store-existence check, as for every store route.
2. Header validation: malformed or incomplete fence headers return `400 validation_error`.
3. Admission pre-check: an already-passed deadline returns `409 write_deadline_exceeded`; a generation that is not the stored generation for the key (superseded, never acquired, or acquired for a different store) returns `409 write_fence_rejected`. The effective deadline is `min(X-Not-After, stored lease expiry)`.
4. `Idempotency-Key` handling (when enabled). Because the pre-check runs first, a cached `2xx` is never replayed to a late or superseded writer.
5. Standard request validation and the mutation transaction. Inside the transaction the server locks the fence row and validates the generation again, then checks the effective deadline again after acquiring its locks and once more before committing. A failure rolls back every tuple and change-log mutation of the request.

Postgres retries a write transaction that fails with a deadlock or serialization error (at most 3 attempts). Every attempt re-checks the caller's original deadline; a retry never restarts it.

The idempotency fingerprint covers method, path and body, not the fence headers. A retry under the current generation with the same `Idempotency-Key` may therefore receive the cached `2xx` of a mutation that already committed; it does not mutate again. Non-`2xx` responses are never cached.

Writers of one queue must all use the same key. Writes without fence headers are not blocked by fences and do not participate in the guarantee.

## Errors

| Status | `code` | When |
|---|---|---|
| `400` | `validation_error` | Malformed or incomplete fence headers; invalid key, generation, `not_after`, unknown body field or malformed JSON on acquisition |
| `401` / `403` | as for other store routes | Authentication failure |
| `404` | `store_id_not_found` | Unknown or deleted store (acquisition and write) |
| `404` | `undefined_endpoint` | Extension disabled, or unknown `/x-ext/` path |
| `409` | `write_fence_rejected` | Acquisition with a lower generation or a changed expiry for the same generation; write with a generation that is not current for the key |
| `409` | `write_deadline_exceeded` | Deadline (or stored lease expiry) passed at admission, after a lock wait, on a retry attempt or before commit; acquisition whose `not_after` has passed |
| `413` | `payload_too_large` | Body over the 1 MiB limit |

All errors use the standard flat `{ "code", "message" }` envelope.

## Safety invariant and clock semantics

**Invariant.** After a successor's acquisition of a newer generation has committed, no tuple mutation under a predecessor generation of the same `(store, key)` can commit. A predecessor transaction that already held the fence row when acquisition started commits first; acquisition waits for it.

This ordering is enforced by database locks only. It does not depend on wall clocks, clock skew or process-local state.

**Not-after is admission and cooperative cancellation, not a commit cutoff.** The server compares deadlines with its own wall clock (UTC). A process, network or database pause between the last deadline check and `COMMIT` can still let a write commit after the deadline. Callers must not treat `X-Not-After` as proof that nothing commits after that instant, and should leave a margin for clock skew between their lease clock and the server. Local lease expiry alone does not prove that the destination is quiescent; a takeover (or any barrier that needs quiescence) must acquire the successor generation first.

## Locking

Fenced writes and acquisitions take locks in one global order, so they cannot deadlock against each other:

1. Postgres: the per-store transaction-scoped advisory lock taken by every tuple write.
2. The store row (share lock on Postgres), re-verifying that the store is live.
3. The fence row: an UPDATE that matches the row takes its row lock on Postgres and the database write lock on SQLite before the generation is read. If the UPDATE matches no row the request is rejected, even if a row becomes visible later in the same transaction, because it would not be locked.
4. Tuple and change-log rows (writes only).

Postgres write transactions run at `READ COMMITTED`. SQLite serializes writers with its database write lock.

## Storage

Fence rows are operational metadata in table `write_fence` under the configured namespace (`<namespace>.write_fence` on Postgres, `<namespace>_write_fence` on SQLite), keyed by `(store_id, key)` with a foreign key to the store. They are kept for the store's lifetime: the API never deletes or resets them (deleting or resetting a fence would let an old generation be reused). Deleting a store through the API is a soft delete, so its fence rows remain; they are removed only together with the store row (`ON DELETE CASCADE`). Fence rows are never part of model or tuple reads, the change log, or the upstream migration path.
