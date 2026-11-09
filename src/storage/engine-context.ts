/**
 * Per-request engine context — pairs the storage layer with a cached
 * `ModelIndex` keyed on (storeId, modelId).
 *
 * Every check/list-objects call needs the model. Re-reading the model
 * row + rebuilding the index per request would be wasteful — the model
 * is immutable once written, so we cache by id.
 */
import { DEFAULT_READ_CONTEXT, type ReadContext } from './read-context'
import { ModelIndex } from '../evaluator/model-index'
import { traced } from '../observability/otel'
import { getAuthorizationModel, getLatestAuthorizationModelId } from './authorization-models'
import {
  listAllForRelation,
  listTuplesForRelation,
  listObjectIdsForUser,
  listUsersForRelation,
} from './tuples'
import type { TupleStore } from '../evaluator/tuple-store'

const _modelCache = new Map<string, ModelIndex>()
const _modelLoads = new Map<string, Promise<ModelIndex | null>>()
let cacheGeneration = 0

async function loadPinnedModel(storeId: string, modelId: string): Promise<ModelIndex | null> {
  const key = `${storeId}:${modelId}`
  const cached = _modelCache.get(key)
  if (cached) return cached
  const pending = _modelLoads.get(key)
  if (pending) return pending

  const generation = cacheGeneration
  const load = (async () => {
    const row = await getAuthorizationModel(storeId, modelId)
    if (!row) return null
    const index = new ModelIndex(row.type_definitions, row.conditions ?? {})
    // A cache reset during an in-flight load must not repopulate the cache.
    if (cacheGeneration === generation) _modelCache.set(key, index)
    return index
  })()
  _modelLoads.set(key, load)
  try {
    return await load
  }
  finally {
    // A failed or missing load is retried on the next request.
    if (_modelLoads.get(key) === load) _modelLoads.delete(key)
  }
}

export async function loadModelIndex(
  storeId: string,
  modelId: string | undefined,
): Promise<{ modelId: string, index: ModelIndex } | null> {
  return traced(
    'storage',
    'openfga.storage.load_model_index',
    () => ({ 'openfga.store_id': storeId, 'openfga.model_id': modelId ?? '' }),
    async (span) => {
      const resolvedId = modelId || await getLatestAuthorizationModelId(storeId)
      if (!resolvedId) return null
      span.setAttribute('openfga.model_id', resolvedId)
      const index = await loadPinnedModel(storeId, resolvedId)
      return index ? { modelId: resolvedId, index } : null
    },
  )
}

/** Test-only. */
export function clearModelCache(): void {
  cacheGeneration++
  _modelCache.clear()
  _modelLoads.clear()
}

/**
 * Request-scoped `TupleStore` adapter for both database dialects. The wrapper
 * carries the read preference through recursive evaluation and contextual
 * overlays without exposing storage policy to the evaluator.
 */
export function pgTupleStore(storeId: string, context: ReadContext = DEFAULT_READ_CONTEXT): TupleStore {
  return {
    listTuplesForRelation: (objectType, objectId, relation) =>
      listTuplesForRelation(storeId, objectType, objectId, relation, context),
    listUsersForRelation: (objectType, objectId, relation) =>
      listUsersForRelation(storeId, objectType, objectId, relation, context),
    listObjectIdsForUser: (objectType, relation, userStr) =>
      listObjectIdsForUser(storeId, objectType, relation, userStr, context),
    listAllForRelation: (objectType, relation) =>
      listAllForRelation(storeId, objectType, relation, context),
  }
}
