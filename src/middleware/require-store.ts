/**
 * Store-existence guard middleware.
 *
 * Mounts on `/stores/:storeId/*` so every store-scoped route inherits
 * a 404 store_id_not_found check before any handler logic runs. The
 * OpenFGA spec returns `store_id_not_found` for requests that
 * reference an unknown store; without this guard, /read /changes
 * /list-objects /check /list-users /expand /batch-check /assertions
 * and the delete-only path of /write returned 200 with empty bodies
 * for non-existent stores — see openfga-rv0.
 *
 * Position in the chain: AFTER auth (don't leak existence to
 * unauthenticated callers) and BEFORE idempotency (don't create
 * idempotency-key entries for non-existent stores).
 */
import type { MiddlewareHandler } from 'hono'
import { getStore } from '../storage/stores'

export function requireStore(): MiddlewareHandler {
  return async (c, next) => {
    const storeId = c.req.param('storeId')
    if (!storeId) {
      // Defensive — Hono routing guarantees this for /:storeId/* but
      // a misconfigured mount would still surface a clean error
      // instead of a runtime crash.
      return c.json(
        { code: 'store_id_not_found', message: 'storeId path parameter missing' },
        404,
      )
    }
    if (c.req.path === `/stores/${storeId}` && !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(storeId)) {
      return c.json({ code: 'validation_error', message: 'invalid store id' }, 400)
    }
    // Upstream DELETE is idempotent even for an absent/deleted store.
    if (c.req.method === 'DELETE' && c.req.path === `/stores/${storeId}`) {
      await next()
      return
    }
    const store = await getStore(storeId)
    if (!store) {
      return c.json(
        { code: 'store_id_not_found', message: `store ${storeId} not found` },
        404,
      )
    }
    await next()
  }
}
