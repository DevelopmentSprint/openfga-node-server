/**
 * Store routes:
 *
 *   GET  /stores  list stores, cursor-paginated
 *   POST /stores  create store
 */
import { Hono } from 'hono'
import { createStore, listStoresPage, getStore, deleteStore } from '../storage/stores'
import { validate } from '../middleware/validation'
import { CreateStoreBody, ListStoresQuery } from './schemas'
import { decodeStoreCursor, encodeStoreCursor, type StoreCursor } from './_helpers/cursors'

export const storesRoutes = new Hono()

storesRoutes.get('/stores', validate('query', ListStoresQuery), async (c) => {
  const { page_size, continuation_token } = c.req.valid('query')
  const pageSize = Math.min(Math.max(page_size ?? 50, 1), 100)
  let cursor: StoreCursor | null = null
  if (continuation_token !== undefined && continuation_token.length > 0) {
    cursor = decodeStoreCursor(continuation_token)
    if (cursor === null) {
      return c.json({ code: 'invalid_argument', message: 'continuation_token is malformed' }, 400)
    }
  }
  const page = await listStoresPage(pageSize, cursor)
  return c.json({
    stores: page.rows.map(r => ({
      id: r.id,
      name: r.name,
      created_at: r.created_at,
      updated_at: r.updated_at,
    })),
    continuation_token: page.nextCursor === null ? '' : encodeStoreCursor(page.nextCursor),
  })
})

storesRoutes.post('/stores', validate('json', CreateStoreBody), async (c) => {
  const body = c.req.valid('json')
  const row = await createStore(body.name.trim())
  return c.json({
    id: row.id,
    name: row.name,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }, 201)
})

storesRoutes.get('/stores/:storeId', async (c) => {
  const store = await getStore(c.req.param('storeId'))
  if (!store) return c.json({ code: 'store_id_not_found', message: 'Store ID not found' }, 404)
  return c.json(store)
})

storesRoutes.delete('/stores/:storeId', async (c) => {
  await deleteStore(c.req.param('storeId'))
  return c.body(null, 204)
})
