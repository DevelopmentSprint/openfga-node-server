/**
 * Kysely `Database` type — the typed view of every table this server
 * owns, expressed in logical (unprefixed) names. The runtime namespace
 * is applied by `getDb()` via `withSchema()` on Postgres or via
 * `TablePrefixPlugin` on SQLite, so this type stays engine-neutral.
 *
 * Timestamp columns are typed as `string` because the Postgres path
 * overrides the default Date conversion via `pg.types.setTypeParser`
 * for OIDs 1184/1114 (timestamptz/timestamp) — Date truncates to
 * milliseconds and that broke cursor pagination on tables where
 * multiple rows share a wall-clock millisecond (openfga-5uv). The
 * SQLite path stores ISO-8601 text, which is also a `string`.
 *
 * JSON columns use Kysely's `JSONColumnType<T>` so the Postgres path
 * returns parsed objects (jsonb auto-parses) and the SQLite path can
 * be paired with `ParseJSONResultsPlugin` to get the same shape.
 *
 * `Generated<T>` marks columns the database fills (DEFAULT now(),
 * bigserial). Insert is `T | undefined`; select and update remain `T`.
 */
import type { ColumnType, Generated, JSONColumnType } from 'kysely'
import type { Assertion, Condition, TypeDefinition } from '@openfga/sdk'

export interface StoreTable {
  id: string
  name: string
  created_at: Generated<string>
  updated_at: Generated<string>
  deleted_at: ColumnType<string | null, string | null | undefined, string | null>
}

export interface AuthorizationModelTable {
  id: string
  store_id: string
  schema_version: string
  model: JSONColumnType<{
    schema_version?: string
    type_definitions?: TypeDefinition[]
    conditions?: { [k: string]: Condition }
  }>
  created_at: Generated<string>
}

export interface TupleTable {
  condition_name: ColumnType<string | null, string | null | undefined, string | null>
  condition_context: ColumnType<Record<string, unknown> | null, string | null | undefined, string | null>
  store_id: string
  object_type: string
  object_id: string
  relation: string
  user_str: string
  inserted_at: Generated<string>
}

export interface TupleChangeTable {
  condition_name: ColumnType<string | null, string | null | undefined, string | null>
  condition_context: ColumnType<Record<string, unknown> | null, string | null | undefined, string | null>
  id: string
  // bigserial on Postgres; INTEGER PRIMARY KEY equivalent on SQLite.
  // Postgres returns int8 as string by default; we keep that contract
  // so cursor tokens stringify consistently across engines. The
  // SQLite-side migration in child #6 will define this as TEXT or use
  // a CAST so the application sees a string regardless of dialect.
  seq: Generated<string>
  store_id: string
  object_type: string
  object_id: string
  relation: string
  user_str: string
  operation: 'TUPLE_OPERATION_WRITE' | 'TUPLE_OPERATION_DELETE'
  inserted_at: Generated<string>
}

export interface IdempotencyKeyTable {
  key: string
  request_hash: string
  status: 'in_flight' | 'completed'
  response_status: ColumnType<number | null, number | null | undefined, number | null>
  // ColumnType (not JSONColumnType) is deliberate here. Idempotency
  // response payloads are heterogeneous (any successful endpoint's
  // response shape), so the select type stays `unknown` for callers
  // to narrow. The current src/storage/idempotency.ts JSON.stringifies
  // on insert, so the insert type is the already-stringified form.
  response_body: ColumnType<unknown, string | null | undefined, string | null>
  created_at: Generated<string>
  completed_at: ColumnType<string | null, string | null | undefined, string | null>
}

export interface AssertionsTable {
  store_id: string
  authorization_model_id: string
  assertions: JSONColumnType<Assertion[]>
  updated_at: Generated<string>
}

export interface Database {
  store: StoreTable
  authorization_model: AuthorizationModelTable
  tuple: TupleTable
  tuple_change: TupleChangeTable
  idempotency_keys: IdempotencyKeyTable
  assertions: AssertionsTable
}
