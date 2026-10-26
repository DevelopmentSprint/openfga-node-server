/**
 * Per-request overlay that adds OpenFGA `contextual_tuples` on top of
 * the persistent `TupleStore` for the duration of a single
 * check / list-objects / list-users / expand call. Returns the base
 * store unchanged when no contextual tuples are present so the hot
 * path stays a single Postgres-backed store with no allocation.
 *
 * Contextual tuples are never persisted — the overlay is discarded
 * once the response is sent, and `add()` only mutates in-memory
 * state on the InMemoryTupleStore instance.
 */
import { validateWriteTupleKey } from '../write-validation'
import type { ModelIndex } from '../../evaluator/model-index'
import { ConditionError } from '../../evaluator/conditions'
import type { RelationshipCondition } from '@openfga/sdk'
import { InMemoryTupleStore, unionTupleStore } from '../../evaluator/tuple-store'
import type { TupleStore } from '../../evaluator/tuple-store'

export function withContextualTuples(
  base: TupleStore,
  contextual: ReadonlyArray<{ user: string, relation: string, object: string, condition?: RelationshipCondition }> | undefined,
  model?: ModelIndex,
): TupleStore {
  if (!contextual || contextual.length === 0) return base
  const overlay = new InMemoryTupleStore()
  for (const t of contextual) {
    if (model) {
      const invalid = validateWriteTupleKey(model, t)
      if (invalid) throw new ConditionError(invalid)
    }
    overlay.add(t.object, t.relation, t.user, t.condition)
  }
  return unionTupleStore(base, overlay)
}
