/**
 * Per-request engine context — pairs the storage layer with a cached
 * `ModelIndex` keyed on (storeId, modelId).
 *
 * Every check/list-objects call needs the model. Re-reading the model
 * row + rebuilding the index per request would be wasteful — the model
 * is immutable once written, so we cache by id.
 */
import { ModelIndex } from '../evaluator/model-index'
import { traced } from '../observability/otel'
import { getAuthorizationModel, getLatestAuthorizationModel } from './authorization-models'
import {
  listAllForRelation,
  listTuplesForRelation,
  listObjectIdsForUser,
  listUsersForRelation,
} from './tuples'
import type { TupleStore } from '../evaluator/tuple-store'

const _modelCache = new Map<string, ModelIndex>()

export async function loadModelIndex(
  storeId: string,
  modelId: string | undefined,
): Promise<{ modelId: string, index: ModelIndex } | null> {
  return traced(
    'storage',
    'openfga.storage.load_model_index',
    () => ({ 'openfga.store_id': storeId, 'openfga.model_id': modelId ?? '' }),
    async (span) => {
      const row = modelId
        ? await getAuthorizationModel(storeId, modelId)
        : await getLatestAuthorizationModel(storeId)
      if (!row) return null
      span.setAttribute('openfga.model_id', row.id)
      const cacheKey = `${storeId}:${row.id}`
      let index = _modelCache.get(cacheKey)
      if (!index) {
        index = new ModelIndex(row.type_definitions, row.conditions ?? {})
        _modelCache.set(cacheKey, index)
      }
      return { modelId: row.id, index }
    },
  )
}

/** Test-only. */
export function clearModelCache(): void {
  _modelCache.clear()
}

/**
 * Postgres-backed `TupleStore` adapter. Closes over `storeId` so the
 * evaluator does not need to know which store it's serving.
 */
export function pgTupleStore(storeId: string): TupleStore {
  return {
    listTuplesForRelation: (objectType, objectId, relation) =>
      listTuplesForRelation(storeId, objectType, objectId, relation),
    listUsersForRelation: (objectType, objectId, relation) =>
      listUsersForRelation(storeId, objectType, objectId, relation),
    listObjectIdsForUser: (objectType, relation, userStr) =>
      listObjectIdsForUser(storeId, objectType, relation, userStr),
    listAllForRelation: (objectType, relation) =>
      listAllForRelation(storeId, objectType, relation),
  }
}
