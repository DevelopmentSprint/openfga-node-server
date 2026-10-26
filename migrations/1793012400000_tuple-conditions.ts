import type { Kysely } from 'kysely'
import { getDialect } from '../src/storage/db'
import { dialectJsonColumn } from '../src/storage/dialect'

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const table of ['tuple', 'tuple_change']) {
    await db.schema.alterTable(table).addColumn('condition_name', 'text').execute()
    await db.schema.alterTable(table).addColumn('condition_context', dialectJsonColumn(getDialect())).execute()
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of ['tuple_change', 'tuple']) {
    await db.schema.alterTable(table).dropColumn('condition_context').execute()
    await db.schema.alterTable(table).dropColumn('condition_name').execute()
  }
}
