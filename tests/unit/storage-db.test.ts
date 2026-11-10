/**
 * Unit tests for the engine-agnostic Kysely entry point and its
 * supporting dialect helpers + table-prefix plugin (openfga-317).
 *
 * The Postgres path requires a real Postgres and is exercised by the
 * integration tests in subsequent children of openfga-8ri. These unit
 * tests cover:
 *
 *   - getNamespace() validation (pure)
 *   - getDialect() URL parsing + scheme rejection (pure)
 *   - dialectFromUrl / sqlitePathFromUrl edge cases (pure)
 *   - dialectNowMinus() emits the right SQL per dialect (compiled)
 *   - getDb() round-trips a query against in-memory SQLite
 *   - TablePrefixPlugin rewrites table names at compile time on SQLite
 *   - Postgres-flavored Kysely instance compiles queries with the
 *     namespace as a schema prefix (no live connection needed)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, sql } from 'kysely'
import { dialectFromUrl, dialectNowMinus, sqlitePathFromUrl } from '../../src/storage/dialect'
import type { Database } from '../../src/storage/db-schema'
import { TablePrefixPlugin } from '../../src/storage/table-prefix-plugin'
import { describeDb, getDb, getDialect, getNamespace, resetDb } from '../../src/storage/db'
import { reloadConfigForTests } from '../../src/config'

const ENV_KEYS = ['OPENFGA_DB_URL', 'OPENFGA_DB_NAMESPACE'] as const
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

beforeEach(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  await resetDb()
})

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  await reloadConfigForTests()
  await resetDb()
})

describe('dialectFromUrl', () => {
  it.each([
    ['postgres://u:p@h:5432/d', 'postgres' as const],
    ['postgresql://u:p@h:5432/d', 'postgres' as const],
    ['sqlite::memory:', 'sqlite' as const],
    ['sqlite:./openfga.db', 'sqlite' as const],
    ['file:./openfga.db', 'sqlite' as const],
    [':memory:', 'sqlite' as const],
  ])('parses %s as %s', (url, expected) => {
    expect(dialectFromUrl(url)).toBe(expected)
  })

  it.each(['mysql://x', 'http://x', 'redis://x', 'plain-string'])(
    'rejects unsupported scheme %s',
    (url) => {
      expect(() => dialectFromUrl(url)).toThrow(/must start with/)
    },
  )
})

describe('sqlitePathFromUrl', () => {
  it.each([
    [':memory:', ':memory:'],
    ['sqlite::memory:', ':memory:'],
    ['sqlite:./foo.db', './foo.db'],
    ['sqlite:/abs/path/foo.db', '/abs/path/foo.db'],
    ['file:./foo.db', './foo.db'],
    // Empty after the prefix is treated as `:memory:` so `sqlite:`
    // behaves the same as `sqlite::memory:`.
    ['sqlite:', ':memory:'],
    ['file:', ':memory:'],
  ])('extracts path from %s as %s', (url, expected) => {
    expect(sqlitePathFromUrl(url)).toBe(expected)
  })

  it('throws on a non-sqlite URL', () => {
    expect(() => sqlitePathFromUrl('postgres://x')).toThrow(/not a SQLite/)
  })
})

describe('getNamespace', () => {
  it('returns the default when unset', async () => {
    delete process.env['OPENFGA_DB_NAMESPACE']
    await reloadConfigForTests()
    expect(getNamespace()).toBe('openfga')
  })

  it.each(['app_authz', 'fga', 'a', 'a1', 'snake_case_123'])(
    'accepts valid identifier %s',
    async (ns) => {
      process.env['OPENFGA_DB_NAMESPACE'] = ns
      await reloadConfigForTests()
      expect(getNamespace()).toBe(ns)
    },
  )

  // Invalid-namespace validation now happens at config-load time via
  // the Zod schema; see tests/unit/config-schema.test.ts for the full
  // coverage of the namespace regex. This file keeps one downstream
  // assertion that getNamespace() returns the validated value when it
  // is valid.

  it('caches the validated value', async () => {
    process.env['OPENFGA_DB_NAMESPACE'] = 'app_authz'
    await reloadConfigForTests()
    expect(getNamespace()).toBe('app_authz')
    // Mutating after first read does not flip the cache (resetDb()
    // clears it; this test asserts the cache exists).
    process.env['OPENFGA_DB_NAMESPACE'] = 'something_else'
    await reloadConfigForTests()
    expect(getNamespace()).toBe('app_authz')
  })
})

describe('getDialect', () => {
  it('throws when db.url is unset', async () => {
    delete process.env['OPENFGA_DB_URL']
    await reloadConfigForTests()
    expect(() => getDialect()).toThrow(/OPENFGA_DB_URL is not set/)
  })

  it.each([
    ['postgres://u:p@h/d', 'postgres' as const],
    [':memory:', 'sqlite' as const],
    ['sqlite:./x.db', 'sqlite' as const],
  ])('infers dialect %s from %s', async (url, expected) => {
    process.env['OPENFGA_DB_URL'] = url
    await reloadConfigForTests()
    expect(getDialect()).toBe(expected)
  })
})

describe('TablePrefixPlugin', () => {
  // Compile queries via the Postgres dialect triplet on a DummyDriver
  // so we can assert SQL output without a live connection. The
  // TablePrefixPlugin operates on the OperationNode tree, which is
  // compiler-agnostic, so the choice of compiler does not affect the
  // assertions below.
  function buildCompiler(plugins: TablePrefixPlugin[]): Kysely<Database> {
    return new Kysely<Database>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: db => new PostgresIntrospector(db),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
      plugins,
    })
  }

  it('prepends the prefix to a SELECT FROM target', () => {
    const db = buildCompiler([new TablePrefixPlugin('openfga_')])
    const compiled = db.selectFrom('store').select('id').compile()
    expect(compiled.sql).toMatch(/from "openfga_store"/i)
  })

  it('prepends the prefix to INSERT INTO targets', () => {
    const db = buildCompiler([new TablePrefixPlugin('openfga_')])
    const compiled = db
      .insertInto('store')
      .values({ id: 'sid', name: 'n' })
      .compile()
    expect(compiled.sql).toMatch(/insert into "openfga_store"/i)
  })

  it('prepends to JOIN targets', () => {
    const db = buildCompiler([new TablePrefixPlugin('openfga_')])
    const compiled = db
      .selectFrom('store')
      .innerJoin('authorization_model', 'authorization_model.store_id', 'store.id')
      .select('store.id')
      .compile()
    expect(compiled.sql).toMatch(/openfga_store/)
    expect(compiled.sql).toMatch(/openfga_authorization_model/)
  })

  it('honours a configured non-default prefix', () => {
    const db = buildCompiler([new TablePrefixPlugin('app_authz_')])
    const compiled = db.selectFrom('tuple').select('store_id').compile()
    expect(compiled.sql).toMatch(/from "app_authz_tuple"/i)
  })

  it('prefixes logical tables whose names begin with the prefix (namespace `tuple`)', () => {
    // Regression: a startsWith(prefix) skip left `tuple_change` unprefixed
    // under namespace `tuple` (prefix `tuple_`), so queries hit a
    // non-existent or wrong physical table.
    const db = buildCompiler([new TablePrefixPlugin('tuple_')])
    const change = db.selectFrom('tuple_change').select('store_id').compile()
    expect(change.sql).toMatch(/from "tuple_tuple_change"/i)
    const tuple = db.selectFrom('tuple').select('store_id').compile()
    expect(tuple.sql).toMatch(/from "tuple_tuple"/i)
  })

  it('leaves the migrator tracking tables (exact physical names) untouched', () => {
    const db = buildCompiler([new TablePrefixPlugin('tuple_')])
    const sqlText = (name: string) =>
      db.selectFrom(name as never).select('name' as never).compile().sql
    expect(sqlText('tuple_kysely_migration')).toMatch(/from "tuple_kysely_migration"/i)
    expect(sqlText('tuple_kysely_migration_lock')).toMatch(/from "tuple_kysely_migration_lock"/i)
  })

  it('leaves already-physical foreign-key references() targets untouched', () => {
    const db = buildCompiler([new TablePrefixPlugin('openfga_')])
    const compiled = db.schema
      .createTable('child')
      .addColumn('store_id', 'text', col => col.references('openfga_store.id'))
      .compile()
    expect(compiled.sql).toMatch(/create table "openfga_child"/i)
    expect(compiled.sql).toMatch(/references "openfga_store" \("id"\)/i)
    expect(compiled.sql).not.toMatch(/openfga_openfga_/)
  })

  it('skips identifiers that carry an explicit schema', () => {
    const db = buildCompiler([new TablePrefixPlugin('openfga_')])
    // Dotted literal `'public.store'` produces a TableNode whose
    // SchemableIdentifierNode has `schema` set; the prefix plugin
    // must leave such identifiers untouched so callers can opt out
    // of namespacing for cross-schema references.
    const compiled = db.selectFrom('public.store' as never).select('id' as never).compile()
    expect(compiled.sql).not.toMatch(/openfga_/)
    expect(compiled.sql).toMatch(/"public"\."store"/)
  })
})

describe('dialectNowMinus', () => {
  // Compile via the Postgres dialect triplet — `dialectNowMinus`'s
  // SQL string is dialect-internal, so the surrounding compiler only
  // affects placeholder formatting (Postgres uses `$N`).
  function compileWith(dialect: 'postgres' | 'sqlite', ms: number): { sql: string, parameters: readonly unknown[] } {
    const db = new Kysely<Database>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: d => new PostgresIntrospector(d),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    })
    const compiled = sql`select ${dialectNowMinus(dialect, ms)}`.compile(db)
    return { sql: compiled.sql, parameters: compiled.parameters }
  }

  it('emits Postgres interval arithmetic with parameterized ms', () => {
    const { sql: sqlText, parameters } = compileWith('postgres', 60_000)
    expect(sqlText).toMatch(/now\(\)\s*-\s*\$\d+::int\s*\*\s*interval '1 millisecond'/i)
    expect(parameters).toEqual([60_000])
  })

  it('emits SQLite strftime with parameterized fractional-seconds modifier', () => {
    // SQLite has no `milliseconds` modifier — passing one returns
    // NULL silently. dialectNowMinus emits ms/1000 as fractional
    // seconds; openfga-8ys investigation pinned this down.
    const { sql: sqlText, parameters } = compileWith('sqlite', 60_000)
    expect(sqlText).toMatch(/strftime\('%Y-%m-%dT%H:%M:%fZ',\s*'now',\s*\$\d+\)/i)
    expect(parameters).toEqual(['-60.000 seconds'])
  })
})

describe('getDb (SQLite end-to-end smoke)', () => {
  beforeEach(async () => {
    process.env['OPENFGA_DB_URL'] = ':memory:'
    delete process.env['OPENFGA_DB_NAMESPACE']
    await reloadConfigForTests()
  })

  it('returns a Kysely instance that can execute a raw SELECT', async () => {
    const db = getDb()
    const row = await sql<{ v: number }>`select 1 as v`.execute(db)
    expect(row.rows).toEqual([{ v: 1 }])
  })

  it('honours the configured namespace via the prefix plugin', async () => {
    process.env['OPENFGA_DB_NAMESPACE'] = 'app_authz'
    await reloadConfigForTests()
    const db = getDb()
    // Create the prefixed physical table by hand. The prefix plugin
    // rewrites the logical name on the way to SQL, so a select on
    // 'store' compiles to a select on 'app_authz_store'.
    await sql`
      create table app_authz_store (
        id text primary key,
        name text not null,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        deleted_at text
      )
    `.execute(db)
    await db
      .insertInto('store')
      .values({ id: 's1', name: 'first' })
      .execute()
    const rows = await db.selectFrom('store').select(['id', 'name']).execute()
    expect(rows).toEqual([{ id: 's1', name: 'first' }])
  })

  it('isolates singletons across resetDb()', async () => {
    process.env['OPENFGA_DB_NAMESPACE'] = 'first'
    await reloadConfigForTests()
    const a = getDb()
    expect(a).toBe(getDb())
    await resetDb()
    process.env['OPENFGA_DB_NAMESPACE'] = 'second'
    await reloadConfigForTests()
    const b = getDb()
    expect(b).not.toBe(a)
    expect(getNamespace()).toBe('second')
  })
})

describe('describeDb (SQLite path)', () => {
  // Postgres-driver introspection requires a live pg.Pool that has
  // accepted at least one connection (the `pool.on('connect', …)`
  // snapshot fires on real connect events). That is exercised by the
  // integration suite which runs against a real Postgres. These unit
  // tests cover the SQLite branch — better-sqlite3 resolves all
  // driver state at construction time, so describeDb() is fully
  // populated as soon as getDb() returns.
  beforeEach(async () => {
    process.env['OPENFGA_DB_URL'] = ':memory:'
    delete process.env['OPENFGA_DB_NAMESPACE']
    await reloadConfigForTests()
  })

  it('reports dialect=sqlite with resolved driver state for :memory:', () => {
    getDb()
    const desc = describeDb()
    expect(desc).toEqual({
      dialect: 'sqlite',
      namespace: 'openfga',
      tablePrefix: 'openfga_',
      path: ':memory:',
      inMemory: true,
      readonly: false,
    })
  })

  it('reports the configured namespace as both namespace and tablePrefix', async () => {
    process.env['OPENFGA_DB_NAMESPACE'] = 'app_authz'
    await reloadConfigForTests()
    getDb()
    const desc = describeDb()
    if (desc.dialect !== 'sqlite') throw new Error('expected sqlite branch')
    expect(desc.namespace).toBe('app_authz')
    expect(desc.tablePrefix).toBe('app_authz_')
  })

  it('reports the resolved file path from the better-sqlite3 instance, not the raw URL', async () => {
    // `sqlite:./openfga-test.db` and `file:./openfga-test.db` both
    // round-trip through sqlitePathFromUrl() to `./openfga-test.db`.
    // describeDb() reads from `db.name`, so the prefix is gone in the
    // output regardless of which input form was used.
    process.env['OPENFGA_DB_URL'] = 'file::memory:'
    await reloadConfigForTests()
    getDb()
    const desc = describeDb()
    if (desc.dialect !== 'sqlite') throw new Error('expected sqlite branch')
    expect(desc.path).toBe(':memory:')
    expect(desc.inMemory).toBe(true)
  })

  it('never includes a password field on either branch (structural guarantee)', () => {
    // SQLite has no password concept; assert the field is absent.
    // The Postgres branch's DescribeDbResult type has no `password`
    // member by construction, so the assertion at the type level
    // covers that branch — this case nails the runtime shape down.
    getDb()
    const desc = describeDb()
    expect(Object.keys(desc)).not.toContain('password')
  })

  it('forces driver init when called before any other use', () => {
    // Calling describeDb() without a prior getDb() should still work
    // — describeDb() invokes getDb() internally to populate refs.
    const desc = describeDb()
    expect(desc.dialect).toBe('sqlite')
  })
})
