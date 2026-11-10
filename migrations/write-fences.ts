import type { Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable('write_fence')
    .addColumn('store_id', 'text', column => column.notNull().references('store.id').onDelete('cascade'))
    .addColumn('key', 'text', column => column.notNull())
    .addColumn('generation', 'text', column => column.notNull())
    .addColumn('not_after', 'text', column => column.notNull())
    .addPrimaryKeyConstraint('write_fence_pkey', ['store_id', 'key'])
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('write_fence').execute()
}
