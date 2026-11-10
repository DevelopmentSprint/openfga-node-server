# Durable write fences

Write fencing is an optional extension for callers that serialize tuple projection under expiring leases. Requests without fence headers retain the standard OpenFGA write contract. All extension endpoints use the store's existing authentication and store-existence checks.

## Acquire a generation

Send `PUT /stores/{storeId}/write-fences/{key}` with:

```json
{ "generation": "1", "not_after": "2030-01-01T00:00:00.000Z" }
```

The key is a stable opaque identifier for one serialization queue: 1–128 ASCII letters, digits, dots, underscores, colons or hyphens, starting with a letter or digit. The generation is a canonical positive decimal string no greater than 9223372036854775807. The timestamp is RFC 3339 UTC. Responses contain `key`, `generation` and the normalized `not_after` timestamp.

The caller allocates generations monotonically in its authoritative queue transaction. Acquisition waits for older writes holding this destination fence to finish, then durably advances its generation. Start processing only after acquisition succeeds and the caller still owns its local lease. Retrying the same generation and expiry preserves the acquisition; changing the expiry under the same generation or sending a lower generation returns `409 write_fence_rejected`. Renewals require a new generation. Keep fence records for the store's lifetime; deleting or resetting them would permit old generations to be reused.

## Write under the fence

Every `POST /stores/{storeId}/write` for that queue carries:

- `X-Write-Fence-Key`: the acquired key.
- `X-Write-Fence-Generation`: the acquired generation.
- `X-Not-After`: the lease's expiry.

The server locks and validates the fence in the same database transaction as tuple changes and their change-log entries. A superseded or unacquired generation returns `409 write_fence_rejected`. A successor cannot finish acquiring its generation while an older tuple transaction still holds the fence, and an older generation cannot mutate tuples after that acquisition commits. Every writer for a queue must use its same stable key; an unfenced legacy writer does not participate in this guarantee.

Expired requests return `409 write_deadline_exceeded`, and transactions check deadlines again before finishing. The stored lease expiry caps a caller's requested deadline. A standalone `X-Not-After` is also accepted for deadline admission without generation fencing. Malformed or incomplete fence headers return `400 invalid_argument`. Deadline and stale-generation checks precede idempotency-cache replay, and actual tuple transactions independently recheck their fence.

## Clock and commit semantics

Not-after guards admission and cooperative cancellation. It is not a promise that the database cannot commit after that wall-clock instant: a process, network or database pause can occur between the last deadline check and commit. Generation fencing provides the ordering guarantee independently of clock skew. Local lease expiry alone does not prove destination quiescence; takeover and model-activation barriers must acquire successor destination fences first.

The implementation uses transaction-held database locks, not a process-local mutex. PostgreSQL locks the fence row; SQLite takes its write lock before reading the generation. Fence metadata follows the configured database namespace and remains operational state, separate from upstream model/tuple export. Stock upstream OpenFGA does not implement this extension; a timeout-only proxy does not establish equivalent fencing.
