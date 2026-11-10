/**
 * Kysely plugin that prepends a configured prefix to every table name
 * at query-compile time. Used on the SQLite path to apply
 * `OPENFGA_DB_NAMESPACE` (default `openfga`) so a logical query against
 * the `store` table compiles to `openfga_store`.
 *
 * The Postgres path applies the namespace via `db.withSchema(ns)`
 * (schema-qualified table names are native to Postgres). SQLite has no
 * schema concept, so a query-AST plugin is the cleanest equivalent.
 *
 * Edge cases:
 *   - The migrator's physical tracking-table names are skipped (exact
 *     match only). Logical tables are always prefixed, so the plugin is
 *     NOT idempotent over already-prefixed logical names.
 *   - Identifiers carrying an explicit schema (e.g. `'sqlite_master'`
 *     via SchemableIdentifierNode.schema) are skipped. The Database
 *     type uses unqualified logical names, so this only fires on
 *     defensive pass-through queries.
 */
import {
  type KyselyPlugin,
  OperationNodeTransformer,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type ReferencesNode,
  type QueryResult,
  type RootOperationNode,
  type SchemableIdentifierNode,
  TableNode,
  type UnknownRow,
} from 'kysely'

/**
 * Identifiers that look like table references but aren't physical
 * tables — `EXCLUDED` is the virtual row available inside ON CONFLICT
 * DO UPDATE in both Postgres and SQLite. Adding the namespace prefix
 * to these would emit `<ns>_excluded.col` which doesn't exist.
 */
const PREFIX_SKIP_IDENTIFIERS = new Set(['excluded'])

/**
 * Kysely's Migrator is configured with the already-prefixed physical
 * names of its tracking tables (see `buildMigrator`), and its queries
 * flow through this plugin. Only those exact names are skipped; a
 * blanket `startsWith(prefix)` check would leave a logical table such
 * as `tuple_change` unprefixed under namespace `tuple`.
 */
const PHYSICAL_TABLE_SUFFIXES = ['kysely_migration', 'kysely_migration_lock'] as const

class TablePrefixTransformer extends OperationNodeTransformer {
  readonly #physicalNames: ReadonlySet<string>

  constructor(private readonly prefix: string) {
    super()
    this.#physicalNames = new Set(PHYSICAL_TABLE_SUFFIXES.map(suffix => `${prefix}${suffix}`))
  }

  /**
   * Foreign-key `references()` targets are written by migrations as
   * already-physical names (`openfga_store.id`, see
   * migrations/1777680000000_initial-openfga-schema.ts), because the
   * string form of `references()` cannot carry the namespace any other
   * way. Leave them untouched; prefixing here would double-prefix.
   */
  protected override transformReferences(node: ReferencesNode): ReferencesNode {
    return node
  }

  protected override transformTable(node: TableNode): TableNode {
    const transformed = super.transformTable(node)
    const ident: SchemableIdentifierNode = transformed.table
    if (ident.schema !== undefined) return transformed
    const original = ident.identifier.name
    if (PREFIX_SKIP_IDENTIFIERS.has(original.toLowerCase())) return transformed
    if (this.#physicalNames.has(original)) return transformed
    return TableNode.create(`${this.prefix}${original}`)
  }
}

export class TablePrefixPlugin implements KyselyPlugin {
  readonly #transformer: TablePrefixTransformer

  constructor(prefix: string) {
    this.#transformer = new TablePrefixTransformer(prefix)
  }

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return this.#transformer.transformNode(args.node)
  }

  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return args.result
  }
}
