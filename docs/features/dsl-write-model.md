# DSL acceptance on POST /stores/:storeId/authorization-models

## Status

Proposed.

## Source of Truth

- PRD: `docs/PRD.md`, "Endpoints" and "Design principles".
- External protocol: OpenFGA HTTP API for the authorization-models POST endpoint.
- Transform library: `@openfga/syntax-transformer` (`transformer.transformDSLToJSONObject`), already used by `src/cli/load-model.ts`.

## Business Intent

Consumer applications (notably the Red Planet project) deploy their authorization model from an `.fga` DSL source file at startup. Today the only path is to compile DSL → JSON in the consumer process, then POST the JSON. That couples every consumer to the transformer dependency and forces the consumer to redeploy whenever the transformer is upgraded.

The transformer already lives server-side in this project (it backs `pnpm load-model`). Adding wire support for the DSL representation lets consumers POST `model.fga` bytes directly and removes the duplicate dependency on the consumer side. Consumers that prefer the JSON path keep working unchanged — the JSON path is the default and is unmodified.

## Goals

- Accept DSL bodies on `POST /stores/:storeId/authorization-models` when the request advertises a DSL content type.
- Preserve the existing JSON path byte-for-byte. `@openfga/sdk` clients must continue to work unchanged. Wire compatibility for the JSON shape is non-negotiable.
- Surface DSL parse errors as `400` with a useful, structured message including line/column when the transformer provides them.
- Keep the change contained to the single route handler and the request-time content-type branch. No storage, evaluator, or other route changes.

## Non-Goals

- Do not add DSL acceptance to other endpoints (`check`, `write`, `read`, `list-objects`, etc.). Only the authorization-models POST gets the new content-type branch.
- Do not introduce a new endpoint path (e.g. `/authorization-models/dsl`). The cleaner shape is a single endpoint with content-type negotiation.
- Do not change `src/cli/load-model.ts`. The CLI compiles DSL → JSON client-side; that path keeps working. Consumers can opt into the new server-side path independently.
- Do not return the original DSL on `GET /stores/:storeId/authorization-models/:id`. Reads remain in OpenFGA's JSON shape.

## Wire Behavior

### Content-Type negotiation

The endpoint inspects the request `Content-Type` header. The match ignores parameters such as `; charset=utf-8`.

| `Content-Type` | Body | Path |
|---|---|---|
| `application/x-openfga-dsl` (preferred) | DSL text | DSL → transformer → existing JSON path |
| `text/plain` (acceptable fallback) | DSL text | DSL → transformer → existing JSON path |
| `application/json` (default) | JSON model | Existing JSON path, unchanged |
| anything else, or absent | JSON model | Existing JSON path, unchanged |

The default when no `Content-Type` is provided remains JSON, matching today's behavior and the OpenFGA wire contract.

### Response shape

Successful writes return HTTP `201` with:

```json
{ "authorization_model_id": "<id>" }
```

`Content-Type` of the response is `application/json`. Reads via `GET /stores/:storeId/authorization-models/:id` remain in the OpenFGA JSON shape regardless of which content type was used to write the model.

### Error behavior

| Situation | Status | Body |
|---|---|---|
| DSL body cannot be read as text | `400` | `{ "code": "invalid_argument", "message": "..." }` |
| DSL parse failure (transformer throws) | `400` | `{ "code": "invalid_argument", "message": "<line/column included when available>" }` |
| Model-semantic validation failure (JSON or transformed DSL) | `400` | `{ "code": "invalid_authorization_model", "message": "..." }` |
| Store not found | `404` (unchanged) | `{ "code": "store_id_not_found", ... }` |

DSL parse failures are client errors, not server errors. They must surface as `400`, never `5xx`.

## Acceptance Criteria

- POSTing a valid `.fga` body with `Content-Type: application/x-openfga-dsl` returns `201` with `authorization_model_id` and a subsequent `GET /stores/:storeId/authorization-models/:id` returns the expected `type_definitions`.
- POSTing a valid `.fga` body with `Content-Type: text/plain` works the same way.
- POSTing the existing JSON shape with `Content-Type: application/json` continues to work unchanged.
- POSTing without a `Content-Type` header continues to be treated as JSON.
- POSTing invalid DSL returns `400` with a structured `invalid_argument` error envelope. The message includes line/column when the transformer surfaces them.
- Content-Type parameter handling is tolerant — `application/x-openfga-dsl; charset=utf-8` matches the DSL branch.
- DSL transformation remains at the route boundary. Both content types share model-semantic validation before storage.
- Tests cover all four acceptance scenarios above. The DSL fixture is `tests/fixtures/github.fga`.
- Quality gates pass: `pnpm typecheck`, `pnpm test`, `pnpm build`.
- README endpoint table notes the dual content-type acceptance on `POST /stores/:storeId/authorization-models`.

## Open Questions

- Should DSL acceptance be advertised in the OpenAPI spec or only in the README? Out of scope for v1; revisit if the project publishes an OpenAPI document.
- Is there a future need for a corresponding `Accept: application/x-openfga-dsl` content negotiation on the GET endpoint to return DSL? Out of scope; not requested by Red Planet, and reads remain in JSON for SDK compatibility.
