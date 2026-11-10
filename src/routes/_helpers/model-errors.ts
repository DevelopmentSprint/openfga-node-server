import type { Context } from 'hono'

/**
 * Unknown-model response. Upstream OpenFGA (v1.22.0,
 * pkg/server/server.go resolveTypesystem) distinguishes a pinned model id
 * that does not exist (`authorization_model_not_found`) from a store with
 * no model at all when the request pins none
 * (`latest_authorization_model_not_found`). The HTTP status stays 404 as
 * before; upstream maps both codes into its 400 validation range, which is
 * tracked separately from the code rename.
 */
export function modelNotFound(c: Context, storeId: string, modelId?: string) {
  if (modelId === undefined || modelId === '') {
    return c.json({
      code: 'latest_authorization_model_not_found',
      message: `No authorization models found for store '${storeId}'`,
    }, 404)
  }
  return c.json({
    code: 'authorization_model_not_found',
    message: `Authorization Model '${modelId}' not found`,
  }, 404)
}

/**
 * Malformed continuation token. Upstream v1.22.0 returns
 * `ErrInvalidContinuationToken` (pkg/server/errors/errors.go:24) with this
 * message for every paginated endpoint.
 */
export const INVALID_CONTINUATION_TOKEN = {
  code: 'invalid_continuation_token',
  message: 'Invalid continuation token',
} as const
