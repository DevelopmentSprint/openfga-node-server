# Standard conditional tuples

## Status and source of truth

Scope approved by the user on 2026-10-26. Implemented on the feature branch;
review and integration are pending.
The user approved portable storage with explicit upstream conversion. The runtime choice and validation evidence are recorded below.
Business intent: `../PRD.md`, Design principles and Conditional tuples.
Existing architectural boundaries: `db-agnosticism.md`, Storage Abstraction
Boundaries and Migrations Strategy.

Comparison baseline: NodeFGA commit `01b77bd`; OpenFGA
[v1.22.0](https://github.com/openfga/openfga/releases/tag/v1.22.0).
The API revision is the one pinned by that server's
[go.mod](https://github.com/openfga/openfga/blob/v1.22.0/go.mod):
`f153694bfc20`. The broad inventory is from source inspection; focused
condition comparisons against the running reference are recorded below.

## Required behavior

- Validate model-defined condition names, parameter declarations, expression
  syntax, referenced variables, and boolean result types before model storage.
  Relation metadata must reference existing conditions.
- Match a tuple's condition against the exact allowed relation facet:
  concrete object, typed wildcard, or userset. A conditional restriction must
  not admit an unconditional tuple merely because the user type matches.
- Persist condition name and context with tuples and write changelog events.
  Read and ReadChanges must round-trip metadata. Tuple identity remains
  object/relation/user; conditions do not create a second identity. Preserve
  existing transactional duplicate-write and missing-delete semantics.
- Apply the same validation to contextual tuples. Contextual tuple precedence
  must match upstream when a persisted tuple has the same identity; condition-aware
  overlays replace matching persisted edges rather than unioning their payloads.
- Merge request context with tuple context, with tuple values taking
  precedence. Keep request context isolated between requests and batch items.
- Support upstream standard condition parameter types, including numeric,
  string, boolean, timestamp, duration, IP address, list, and map types.
  Test conversion boundaries, missing parameters, and invalid values against
  the pinned server. Do not substitute JavaScript coercion for CEL semantics.
- Evaluate conditions on direct, wildcard, userset, and tuple-to-userset edges
  across Check, BatchCheck, ListObjects, and ListUsers. Preserve upstream
  true/false/error behavior for union, intersection, and difference; a generic
  filter that discards condition errors is insufficient.
- Keep Read as storage retrieval. Establish Expand's condition behavior from
  upstream fixtures rather than treating Expand as a permission decision.
- Bound expression evaluation and graph traversal. Never execute submitted
  CEL as JavaScript with eval or Function. Do not cache authorization results
  across request contexts. Compiled immutable model conditions may be cached.

Reference behavior: upstream
[condition compilation](https://github.com/openfga/openfga/blob/v1.22.0/internal/condition/condition.go),
[context merging and evaluation](https://github.com/openfga/openfga/blob/v1.22.0/internal/condition/eval/eval.go),
and [graph reducers](https://github.com/openfga/openfga/blob/v1.22.0/internal/graph/check.go).

## Architecture impact and resolved storage contract

Preserve the evaluator's dependency on TupleStore and Kysely's Postgres/SQLite
boundary. TupleStore must carry condition metadata instead of exposing only
user strings. ModelIndex must retain condition definitions. HTTP handlers
must supply request context to evaluation. Both databases require additive
migrations for tuple and changelog condition data; old rows remain unconditional.

Before this change, the PRD's Design principles said **“Schema-compatible byte-for-byte.”** Its
migration section promised a dump/restore and URL change. The database feature
spec also says the Postgres schema-mirroring constraint is preserved.

Actual NodeFGA migration `1777680000000_initial-openfga-schema.ts` uses
`tuple.store_id`, `tuple.user_str`, and JSON authorization models. Upstream's
[initial schema](https://github.com/openfga/openfga/blob/v1.22.0/assets/migrations/postgres/001_initialize_schema.sql)
uses `store`, `_user`, `user_type`, and `ulid` on tuples and binary model data.
Its [condition migration](https://github.com/openfga/openfga/blob/v1.22.0/assets/migrations/postgres/005_add_conditions_to_tuples.sql)
adds `condition_name` and binary `condition_context` to tuple and changelog.
NodeFGA has neither condition column. Excluding operational tables from a dump
does not resolve these column and serialization differences.

The alternatives considered were:

1. Keep portable NodeFGA storage, change the PRD to an explicit conversion or
   API export/import migration contract, and specify/test that migration in
   separate work. Recommended for the current Node/serverless intent.
2. Preserve the physical-compatibility promise and undertake schema and binary
   serialization alignment before condition persistence. This is larger scope.

The user approved option 1. The PRD now requires an explicitly tested conversion
contract and states that no migration tool has yet been delivered. Use additive
nullable condition name/context columns with JSON context in both supported
backends. This does not claim compatibility with upstream binary columns.

## CEL runtime decision

Upstream uses cel-go. NodeFGA uses `@marcbachmann/cel-js` 8.0.0 for static
checking only and `@bufbuild/cel` 0.6.1 for execution. This separation is
intentional: the former's Date-based evaluation loses nanoseconds; the latter
preserves protobuf timestamps/durations but does not supply the required static
checker. Both must accept a model before it is stored. Expressions must return
bool; unknown variables and invalid parameter declarations are rejected.

IP addresses use a private protobuf message and ipaddr.js for CIDR evaluation.
RE2JS supplies regex matching. No user expression executes as JavaScript.
Numeric strings use 64-bit binary significand rounding (matching big.ParseFloat),
with a decimal exponent magnitude limit of 10,000. Inexact string-to-double
conversions are rejected. Integer parameter conversion follows the pinned server's signed-64-bit
saturation, including its unsigned upper-bound behavior. JSON numbers already
carry IEEE-754 precision; use strings for large integer inputs.

Resource limits are deliberately conservative and differ from cel-go's exact
runtime-cost accounting. Expressions are capped at 65,536 characters, 10,000
checker AST nodes, and depth 64. Context is capped at 100,000 aggregate
units (characters, members, and scalar values) and depth 32. Before execution,
AST size times aggregate input/AST size raised to the total comprehension count
(at least one) must not exceed 1,000,000. This bounds nested and chained macro
work; some expressions within upstream's configured budget can be rejected.
Graph Check paths are cycle-aware and bounded to depth 25. Compiled models are
cached; request contexts and condition decisions are never cached.

The focused differential suite checks decision/error parity against v1.22.0;
it is not the complete upstream CEL or OpenFGA conformance suite. Numeric-string
formats and compiler diagnostics beyond those fixtures remain compatibility
risks requiring additional differential coverage.

## Acceptance evidence required before release

Use identical valid and invalid requests against NodeFGA and the pinned
OpenFGA server, normalizing generated IDs and timestamps only. Include a
time-limited grant example, stored-context precedence, missing and incorrectly
typed parameters, condition-required restrictions, wildcards, usersets,
tuple-to-userset, all set operators, and independent BatchCheck item errors.
Exercise all four evaluation endpoints and tuple/changelog round trips.

Run existing unit/integration gates plus both SQLite and isolated Postgres
migration tests on fresh and populated databases. Verify unchanged unconditional
behavior. Report any intentional divergence explicitly; the existing SDK suite
does not constitute upstream conformance.

## Other reference-server gaps at baseline

This inventory does not approve implementation of additional features. This
change addresses conditional metadata loss and Check traversal bounds, and
corrects the migration contract. Other entries remain separate work; wildcard
ListUsers behavior still needs a full upstream algebra comparison.

| Priority | Gap and local evidence | Reference and implication |
|---|---|---|
| Highest | Conditional contextual tuples lose their condition in `src/routes/_helpers/contextual-tuples.ts`; `ModelIndex` drops model conditions. Persisted conditional writes are rejected by `write-validation.ts`. | Condition metadata can be ignored on contextual evaluation paths. Differential security regression tests should lead the condition work. |
| Highest | Physical migration incompatibility described above. | Direct dump/restore is not supported by the inspected schema; resolve the product contract. |
| High | `src/routes/models.ts` checks only the outer array and stores arbitrary definitions/schema versions. | Upstream `pkg/typesystem/typesystem.go` validates model semantics. Invalid references, malformed rewrites, and condition declarations need rejection. |
| High | `src/evaluator/check.ts` recurses without visited-path, depth, or cancellation controls. | Upstream graph checker has cycle/depth and request limits. Cyclic tuple graphs can keep NodeFGA evaluation running. |
| High | `src/evaluator/list-users.ts` intersects/subtracts literal strings. | Wildcard set algebra needs differential verification: `{user:*} intersect {user:anne}` currently becomes empty; `{user:*} minus {user:anne}` retains `user:*`. Exact upstream response semantics remain to be tested. |
| Medium | `src/routes/stores.ts` implements only create/list. | The pinned API includes GetStore, DeleteStore, and UpdateStore (GET/DELETE/PATCH `/stores/{id}`). |
| Medium | `src/routes/models.ts` always returns an empty continuation token and ignores supplied continuation tokens. | The pinned API supports paginated ReadAuthorizationModels. Models after the first limited page are inaccessible through listing. |
| Medium | `src/routes/schemas.ts` passes through consistency without enum validation; handlers do not propagate it. | Existing `check-consistency.md` already specifies part of the missing contract. Direct uncached reads alone are not a freshness defect. |
| Medium | Validation and error compatibility are partial: Check returns false for undefined relations; read-filter fields are individually optional; model IDs and request limits are not comprehensively validated. | Compare invalid requests, status codes, and error envelopes with the pinned API; successful SDK calls do not establish these semantics. |
| Optional scope | No streamed-list-objects route or gRPC server. | Both exist in the upstream service; streaming REST is a wire-surface gap, while gRPC exceeds the present REST-focused scope. |
| Optional scope | No equivalent Check query/iterator cache, optimized planner, replica routing, or MySQL backend. | Upstream has these operational capabilities. They are not all required by NodeFGA's current product goals; a model-index cache already exists locally. |
| Separate assessment | AuthZEN and experimental dynamic conditions. | v1.22.0 server includes AuthZEN wiring; v1.21.0 introduced experimental dynamic conditions. Do not bundle them into standard conditional tuples. |

Endpoint and request contract reference:
[pinned OpenFGA service API](https://github.com/openfga/api/blob/f153694bfc20/openfga/v1/openfga_service.proto).
Model validation reference:
[upstream type system](https://github.com/openfga/openfga/blob/v1.22.0/pkg/typesystem/typesystem.go).
Operational reference:
[upstream server](https://github.com/openfga/openfga/blob/v1.22.0/pkg/server/server.go)
and [release history](https://github.com/openfga/openfga/releases).

Recommended order after this change: extend differential fixtures; address model validation, traversal bounds, and wildcard
semantics; complete REST endpoints/pagination; evaluate operational extras only
against demonstrated deployment requirements.

## Validation commands and observed differences

Run normal checks with `pnpm verify`. Focused tests are
`tests/unit/conditions.test.ts` and `tests/integration/conditions.test.ts`.
Point `OPENFGA_REFERENCE_URL` at an isolated v1.22.0 reference server and run
`pnpm exec vitest run --project integration tests/integration/conditions.test.ts tests/integration/condition-reference.test.ts`
to repeat the 24 reference-backed scenarios. The latter suite skips explicitly
without that environment variable. Point `OPENFGA_DB_URL` at isolated Postgres
and run migrations before the `integration-pg` condition suite.

The endpoint fixtures explicitly allow pre-existing creation-status (200 vs
201), duplicate-write status (409 vs 400), and Check `resolution` field
differences. They compare permission decisions, condition errors, context
precedence, and metadata, not byte-for-byte equality of every response.
Read/ReadChanges now emit `context: {}` for named conditions with no context,
as the reference does. Missing declared parameters always fail condition
evaluation, including unused or short-circuited parameters. Expand lists
valid conditional edges without evaluating their predicates.
