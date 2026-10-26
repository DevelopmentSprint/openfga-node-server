# Database-Agnostic Storage Layer

## Status

Proposed.

## Source of Truth

- PRD: `docs/PRD.md`, "Storage", "Operational shape".
- Parent bead: `openfga-8ri` (acceptance criteria + child decomposition).
- Existing storage surface: `src/storage/{pool,stores,authorization-models,tuples,idempotency,assertions,engine-context,ids}.ts`.
- Existing migrations: `migrations/*.sql` run by `node-pg-migrate`.

## Business Intent

The storage layer is hard-bound to Postgres: every module under `src/storage/` emits raw pg-flavored SQL, and `migrations/` uses `node-pg-migrate` which is Postgres-only. Two consequences:

1. **Unit tests can't cover storage.** `pnpm test:unit` exercises the evaluator against an in-memory `TupleStore` but covers ~0% of `src/storage/*`. The integration job is the only contract test for the storage layer, and it requires a real Postgres container.
2. **Third-party adopters can't pick a backend.** Adopters who don't run Postgres — small SaaS, single-binary deployments, embedded use cases — must fork the codebase to swap engines.

A database-agnostic storage layer delivers two compounding wins:

1. Storage tests run in-process against SQLite for fast no-container feedback, lifting unit-only coverage of `src/storage/*` from ~25% toward ~90% and shifting the integration job from "is anything tested at all" to "are the Postgres-specific behaviors right."
2. Adopters select a backend via a configuration surface without forking. Postgres remains the production-recommended backend; SQLite becomes the supported test backend and a viable embedded-deployment option.

## Goals

- Expose a single typed query surface that the route handlers and evaluator consume, with backing implementations for at least Postgres (production) and SQLite (tests).
- Preserve every behavior of the current Postgres path byte-for-byte, including the timestamp-microsecond-precision fix from `openfga-5uv` and the clock-skew-safe idempotency claim from `openfga-how`.
- Replace `node-pg-migrate` with a multi-dialect migration runner that ships migrations as TypeScript so a single source generates the correct SQL per engine.
- Add a fast unit-only test path that exercises the storage layer against in-memory SQLite.
- Document the supported engines, the configuration surface, the operational tradeoffs, and the explicit upstream-conversion contract for both backends.

## Non-Goals

- Distributed-database backends (CockroachDB, Yugabyte, etc.). Postgres-wire-protocol-compatible engines should work transparently with the Postgres driver path; that is incidental, not designed-for.
- MySQL/MariaDB. Kysely supports it via dialect plugin and Phase 2 could add it cheaply, but it is not part of the v1 acceptance.
- Per-tenant database selection.
- Mid-flight migration between engines (adopters pick one and stay).
- A generic "BYO storage" plugin SDK — the abstraction targets Kysely-supported engines, not arbitrary user-supplied backends.
- Production-grade SQLite. SQLite is positioned as the test backend and an embedded-deployment option, not a recommended multi-instance production backend.

## Architectural Decision: Kysely

Three options were on the table in `openfga-8ri`:

- **Option A** — Repository pattern with raw SQL: separate `pg` and `sqlite` implementations per repository interface, each owning its SQL.
- **Option B** — Kysely query builder: type-safe SQL builder with first-party Postgres / SQLite / MySQL dialect plugins.
- **Option C** — Drizzle ORM: schema-first, type-safe, multi-dialect.

**Decision: Option B (Kysely).**

Rationale:

- The storage surface is small (8 modules, mostly CRUD + cursor pagination + UPSERT). Option A doubles the SQL maintenance burden across drivers and invites drift; Option C imports a heavier ORM than the surface justifies.
- Kysely renders `INSERT ... ON CONFLICT DO NOTHING RETURNING` portably between Postgres 9.5+ and SQLite 3.35+ — both modern enough that no fallback path is needed.
- Kysely's TypeScript types stay tight without imposing a schema-DSL or a code-generation step.
- Kysely's `sql` template tag provides a clean escape hatch for the few unavoidable dialect-specific fragments (timestamp interval arithmetic, schema-namespace handling).
- Kysely ships a first-party `Migrator` that runs the same TypeScript migration source against any supported dialect.
- ESM-first, ~10 kB. No transitive runtime dependencies.

## Engine Configuration

Engine selection is inferred from the `OPENFGA_DB_URL` scheme rather than a separate `OPENFGA_DB_DRIVER` env var. This matches Kysely conventions and avoids two-source-of-truth bugs (a mismatched scheme + driver pair).

| Scheme prefix on `OPENFGA_DB_URL` | Backend | Driver |
|---|---|---|
| `postgres://`, `postgresql://` | Postgres | `pg` (current driver, unchanged) |
| `sqlite:`, `file:`, `:memory:` | SQLite | `better-sqlite3` |

Defaults preserve current behavior: any operator running today with `OPENFGA_DB_URL=postgres://...` sees no behavior change.

The pool-tuning environment variables (`OPENFGA_DB_POOL_MAX`, `OPENFGA_DB_POOL_MIN`, etc.) remain Postgres-only and are ignored under the SQLite backend, which has a single-process per-connection model. `.env.example` documents this.

### Namespace

Operators control the namespace under which every table this server owns lives, via:

- `OPENFGA_DB_NAMESPACE` — default `openfga`. Validated against `/^[a-z][a-z0-9_]{0,62}$/` so it is a safe SQL identifier in both engines without requiring quoting. Reject and refuse to start on invalid values.

The same value is interpreted per-engine:

- **Postgres** — used as a schema name. The migration runs `CREATE SCHEMA IF NOT EXISTS <namespace>`; every query references `<namespace>.<table>`. Default `openfga` preserves the current NodeFGA layout. Upstream migration requires explicit conversion, as specified in the PRD.
- **SQLite** — used as a table-name prefix joined by underscore. Every query references `<namespace>_<table>`. Default `openfga` produces `openfga_store`, `openfga_tuple`, etc.

The namespace covers **every table this server owns**, with no exceptions:

- The three OpenFGA-contract tables: `store`, `authorization_model`, `tuple`.
- The three operational tables: `idempotency_keys`, `tuple_change`, `assertions`.
- The Kysely `Migrator` tracking tables: `kysely_migration` and `kysely_migration_lock` (the Migrator is configured with the namespace at construction time so the tables it creates respect the operator's setting).

Rationale: operators dropping this server into an existing Postgres instance need the freedom to pick a non-default schema (`openfga` may collide with an existing schema, or they may want everything under `app_authz`); SQLite operators sharing a database file need the same freedom for the prefix. Backup and conversion tools must honor the configured namespace.

## Storage Abstraction Boundaries

A new `src/storage/db.ts` exposes `getDb(): Kysely<Database>`. The `Database` type union is generated by hand (the storage surface is small enough that hand-written types are cleaner than a code-generator, and we already maintain the row interfaces inline in each repository).

Existing modules — `stores.ts`, `authorization-models.ts`, `tuples.ts`, `idempotency.ts`, `assertions.ts` — are rewritten to use `getDb()` instead of `getPool().query(...)`. The exported function signatures stay identical so route handlers and the evaluator are not touched. `engine-context.ts` and `ids.ts` are engine-agnostic and need no changes.

`pool.ts` is renamed to `db.ts` and becomes responsible for selecting the dialect, instantiating the underlying driver (pg `Pool` or better-sqlite3 `Database`), and constructing the `Kysely` instance. The `resetDb()` test hook replaces `resetPool()`.

The evaluator's `TupleStore` interface (`src/evaluator/tuple-store.ts`) is unaffected — the abstraction sits below the evaluator. Unit tests already swap an in-memory `TupleStore`; this spec adds a second path where unit tests can also exercise the real storage layer through SQLite.

## Dialect Portability Hot Spots

Each row below names a Postgres-specific construct currently in the storage layer, the SQLite equivalent, and the abstraction strategy.

### Timestamp microsecond precision

- **Current Postgres**: `pool.ts` overrides `pgTypes.setTypeParser(1184/1114, v => v)` so timestamptz/timestamp return as raw text. JS `Date` truncates to milliseconds, which broke cursor pagination on tables where multiple rows share a wall-clock millisecond (`openfga-5uv`).
- **SQLite**: better-sqlite3 returns columns by their declared affinity. Storing timestamps as ISO-8601 text (`TEXT`) preserves arbitrary precision _at the storage level_, but SQLite's `'now'` clock itself is millisecond-resolution — `STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')` yields three decimals regardless of the `subsec` modifier (tested SQLite 3.53). Same-millisecond inserts therefore share a `created_at` value. The Kysely `ColumnType` mapping returns `string` for both engines.
- **Abstraction**: declare timestamp columns as `string` in the `Database` type. Postgres-side: keep the `setTypeParser` override at driver-construction time. SQLite-side: store timestamps as ISO-8601 text via `STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')` defaults. Cursor comparisons work identically in both engines because both compare ISO-8601 strings lexicographically when the format is fixed-width. Same-millisecond ordering ties on SQLite are resolved at the next layer:
  - For `tuple_change`, the `seq` column (bigserial on Postgres, `rowid`-trigger on SQLite — see `migrations/1778083200000_tuple-change-seq.ts`) provides a strictly monotonic per-insert tiebreaker that the changes query orders by alongside `inserted_at`.
  - For `store` and `authorization_model`, the application-side ULID generator in `src/storage/ids.ts` is monotonic-within-millisecond (`openfga-sp5`): same-ms calls increment the random suffix instead of regenerating it, so `ORDER BY id DESC` produces insertion-order results without a schema-level seq column.

### Clock-skew-safe idempotency claim

- **Current Postgres**: `idempotency.ts` runs `DELETE ... WHERE created_at <= now() - $::int * interval '1 millisecond'` so the cutoff is computed in SQL and shares the clock that wrote `created_at` (`openfga-how`).
- **SQLite**: `STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || $ || ' milliseconds')` produces an equivalent cutoff using SQLite's modifier syntax.
- **Boundary semantics**: the comparison is `<=` (and the lookup mirror is `>`) rather than `<` / `>=`, so a `ttlMs=0` sweep clears every existing row even on dialects whose cutoff and `created_at` resolve to the same millisecond instant. Postgres microsecond `now()` effectively never lands on the equality boundary in practice, so this is a no-op there; SQLite millisecond `now()` does land on the boundary, and `<` would silently leave the row in place (`openfga-sp5`).
- **Abstraction**: a thin `dialectNowMinus(ms: number)` helper in `src/storage/dialect.ts` returns a Kysely `RawBuilder<string>` rendering the engine-appropriate expression. The idempotency module imports the helper rather than embedding SQL.

### UPSERT and RETURNING

- Both Postgres 9.5+ and SQLite 3.24+ support `INSERT ... ON CONFLICT (col) DO NOTHING`. RETURNING is Postgres-standard and SQLite-3.35+. Kysely renders both portably via `.onConflict(oc => oc.column('key').doNothing()).returning('key')`. No abstraction layer needed beyond Kysely.

### Row-tuple comparison for cursor pagination

- Both Postgres and SQLite 3.15+ support `(a, b) > ($1, $2)` row-value comparisons. Kysely emits this via `eb.tuple([...]) > eb.tuple([...])` or via the `sql` tag. The 5-field comparison in `tuples.readTuplesPage` and the 2-field in `tuples.listChangesPage` and `stores.listStoresPage` port directly.

### Schema namespacing

- **Current Postgres**: every query references `openfga.<table>` and migrations begin with `CREATE SCHEMA IF NOT EXISTS openfga`. RLS is enabled per-table.
- **SQLite**: no schema concept. Two viable strategies:
  - **(a) Table prefix**: `openfga_store`, `openfga_authorization_model`, etc. — the abstraction layer maps the logical table name `store` to the physical name `openfga.store` (Postgres) or `openfga_store` (SQLite).
  - **(b) ATTACH DATABASE**: `ATTACH DATABASE ':memory:' AS openfga` lets queries reference `openfga.store` literally.
- **Decision**: **(a) table prefix**. ATTACH semantics differ across SQLite environments (in particular, the prefix-as-database-name only persists for the connection lifetime, which conflicts with the Migrator's per-step connection reuse). The Kysely `Database` type uses unprefixed logical names (`store`, `tuple`, `authorization_model`, etc.); the dialect adapter prepends `<namespace>.` for Postgres and `<namespace>_` for SQLite at query construction time, where `<namespace>` is the value of `OPENFGA_DB_NAMESPACE` (default `openfga`). See §Namespace.
- RLS is Postgres-only and remains in the Postgres migration. SQLite has no equivalent; the unit-test path runs in-process so the boundary is the test process, not a database role.

### JSON storage

- **Current Postgres**: `authorization_model.model jsonb`, `assertions.assertions jsonb`, `idempotency_keys.response_body jsonb`. Inserts use `$N::jsonb` casts.
- **SQLite**: stores JSON as text. Kysely's `JSONColumnType<T>` maps to `jsonb` on Postgres and `text` on SQLite, with parse/stringify happening at the driver boundary.
- **Abstraction**: declare JSON columns with Kysely's `JSONColumnType` and remove the manual `JSON.stringify(...)` + `::jsonb` cast at call sites. Net code simplification, not just a portability move.

### Connection pool semantics

- **Postgres**: `pg.Pool` with conservative defaults (max 10, idle 30s).
- **SQLite**: better-sqlite3 is synchronous and per-process. There is no pool; the Kysely SqliteDialect wraps a single `Database` handle. Concurrent `await` callers serialize on the JS event loop, which is fine for the scale the SQLite backend targets (tests + embedded).
- **Abstraction**: dialect adapter constructs the appropriate underlying client. Pool tuning env vars are silently ignored under SQLite (the `.env.example` documents this).

### Postgres-specific features that do not port

- **Row-Level Security**: Postgres-only. Stays in the Postgres migration only. SQLite parity is not in scope.
- **`COMMENT ON SCHEMA`**: Postgres-only. Stays in the Postgres migration only.

## Migrations Strategy

Replace `node-pg-migrate` with Kysely's first-party `Migrator` + `FileMigrationProvider`. Migrations move from `.sql` to `.ts`:

- `migrations/<timestamp>_<name>.ts` exports `up(db: Kysely<any>)` and `down(db: Kysely<any>)`.
- Each migration is dialect-agnostic where possible. Where it isn't (RLS, schema namespacing, jsonb, types), the migration uses `db.introspection.dialect.adapter` or runtime branches via the `sql` template tag plus a small `isPostgres(db)` helper.
- The five existing SQL migrations get one-time-translated to TypeScript. The migration timestamps stay numerically ordered; the table that records applied migrations (`migrations` by default) is created in both engines.

The `pnpm migrate up` and `pnpm migrate down` scripts call into the new runner. The CLI surface stays the same so operator runbooks and CI jobs do not change.

The Migrator is constructed with the `OPENFGA_DB_NAMESPACE` value (default `openfga`) so its tracking tables (`kysely_migration` and `kysely_migration_lock`) live under the same namespace as the OpenFGA tables — `<namespace>.kysely_migration` on Postgres, `<namespace>_kysely_migration` on SQLite. This keeps `pg_dump --schema=<namespace> --exclude-table=...` recipes self-contained and prevents the Migrator from polluting the operator's `public` schema (or the SQLite database's top-level table namespace).

NodeFGA does not mirror upstream physical schemas. The PRD now requires a tested conversion or API export/import workflow; a direct dump/restore is unsupported.

## CI / Test Strategy

- The default **test+coverage job** runs `pnpm coverage` against SQLite `:memory:` and needs no service container. It exercises the unit project plus the integration project (`tests/integration/*`), which `openfga-5y9` migrated off Postgres so the entire suite runs in-process. The Codecov upload stays on this job.
- A separate **integration-pg job** brings up a Postgres service container, runs `pnpm migrate up`, and re-runs the integration specs against pg via the `integration-pg` vitest project. This is a dialect-portability check, not a coverage source — same specs, different dialect — so a few specs gated `itIfPg` (e.g. ordering tests that depend on monotonic timestamps) only fire here. Postgres-specific behavior guards (`openfga-5uv` timestamptz precision, `openfga-how` clock-anchored idempotency cutoff, RLS posture) are scoped to a follow-up bead (`openfga-bwu`) that adds new tests under this same `integration-pg` project.
- A **fast unit-only path** runs `pnpm test:unit` against SQLite `:memory:` per-suite. The unit project covers storage-layer tests that previously could not run without Postgres. Faster than the full coverage path; intended for tight local feedback.
- The `OPENFGA_DB_URL` for the unit and integration projects is `:memory:` by default in `vitest.config.ts`; tests can override per-suite.
- Coverage thresholds in `vitest.config.ts` were re-baselined under `openfga-5y9` against the SQLite-default `pnpm coverage` run. Measured baseline: 85.59 / 74.45 / 94.14 / 87.75 (statements / branches / functions / lines). Floors: 80 / 70 / 89 / 82 (~5% headroom). Statements and branches sit slightly below the original target of 85/78/82/85 because the realized coverage distribution includes route-level integration paths in addition to unit-only storage coverage; functions and lines are at or above target.

## Operational Tradeoffs

| Concern | Postgres backend | SQLite backend |
|---|---|---|
| Production deployment | Recommended | Single-process / embedded only |
| Concurrent writers across instances | Yes | No (single process owns the DB file) |
| Durability | fsync via WAL | WAL mode supported; fsync semantics are filesystem-dependent |
| Row-Level Security | Enabled | Not available |
| Direct dump/restore to upstream OpenFGA | Unsupported; conversion required | Unsupported; conversion required |
| Hot backups | Standard pg tooling | File copy (with WAL checkpoint) |
| Pool tuning env vars | Honored | Ignored |

Upstream conversion must be tested for both backends before being advertised as supported.

## Phasing

`openfga-8ri`'s child decomposition is preserved (with this spec replacing child #1):

1. ~~Feature spec~~ — this document.
2. Introduce Kysely + SQLite driver, port `pool.ts` → `db.ts`, no semantic change to the Postgres path. Add `Database` type and dialect adapter.
3. Port `stores.ts` + `authorization-models.ts` + `ids.ts` to Kysely; tests against both engines.
4. Port `tuples.ts` + `idempotency.ts` (the dialect-specific hot spots) to Kysely; tests against both engines.
5. Port `assertions.ts` to Kysely; tests against both engines.
6. Port migrations from `node-pg-migrate` `.sql` to Kysely `Migrator` `.ts`; verify `pnpm migrate up` runs cleanly against a fresh Postgres and a fresh SQLite.
7. Wire SQLite `:memory:` into the vitest unit project; add storage-layer unit tests; revise coverage thresholds upward.
8. Update CI: keep the Postgres test+coverage job; the unit job gains the SQLite-backed storage tests automatically once they're in the unit project.
9. Update README, `.env.example`, and PRD §Storage / §Operational shape to document the new configuration surface and operational tradeoffs.

Each step ships on its own bead off `feature/openfga-8ri_db-agnosticism` (or a child branch under an `integration/openfga-8ri_db-agnosticism` epic branch if any step warrants subagent parallelism).

## Acceptance Criteria

- A `Kysely<Database>` instance is the single query surface used by every module under `src/storage/`. No route handler or evaluator function references `pg` directly.
- Both Postgres and SQLite backends are runnable. The backend is selected by the `OPENFGA_DB_URL` scheme.
- The table namespace is configurable via `OPENFGA_DB_NAMESPACE` (default `openfga`), validated as a safe SQL identifier, and applied to **every** table this server owns: the OpenFGA-contract tables, the operational tables, and the Kysely Migrator's tracking tables. No table escapes the namespace.
- Migrations are runnable against both engines via `pnpm migrate up` / `pnpm migrate down`.
- The vitest `unit` project exercises storage against in-memory SQLite without requiring `OPENFGA_DB_URL` to point at a service.
- The vitest `integration` project continues to exercise Postgres against a real container.
- The Postgres path preserves byte-for-byte the behaviors fixed under `openfga-5uv` (timestamp microsecond precision) and `openfga-how` (SQL-side TTL cutoff for idempotency claim).
- The README documents the supported engines, the connection-string-based engine selection, and the operational tradeoffs (concurrency, durability, RLS, explicit upstream conversion requirements).
- The PRD's §Storage and §Operational shape sections are updated to reflect the dual-backend reality.
- Coverage thresholds in `vitest.config.ts` reflect the post-port baseline (target: 85/78/82/85, revise after measurement).

## Open Questions

- Should the SQLite backend be promoted from "test + embedded only" to a tier-1 production option for single-node deployments, with explicit guidance on backup, durability, and concurrency? Defer until at least one operator asks; the current scope keeps Postgres as the production-recommended target.
- Should the SQLite backend support WAL mode by default? Likely yes for any non-`:memory:` URL; flag in step 2 of the phasing.
- Does this epic warrant introducing a `docs/architecture/` tree with a storage-architecture document? Probably yes — the storage abstraction is the first piece of cross-cutting architecture this project has acquired. File a separate bead if so.
