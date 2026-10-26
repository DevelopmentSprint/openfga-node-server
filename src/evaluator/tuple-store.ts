import type { RelationshipCondition } from '@openfga/sdk'

export interface TupleEdge { user: string, condition?: RelationshipCondition }

/**
 * Storage interface the evaluator depends on.
 *
 * Pure dependency inversion — the evaluator doesn't know whether tuples
 * live in Postgres or in a Map. Production wires `TupleStore` to the
 * `storage/tuples.ts` repository; unit tests pass an in-memory
 * implementation so the evaluator can be exercised without I/O.
 */

export interface TupleStore {
  listTuplesForRelation?(objectType: string, objectId: string, relation: string): Promise<TupleEdge[]>
  /** Users (direct, userset, or wildcard refs) directly assigned to (object, relation). */
  listUsersForRelation(
    objectType: string,
    objectId: string,
    relation: string,
  ): Promise<string[]>

  /** Object_ids of `objectType` directly assigned to `userStr` via `relation`. */
  listObjectIdsForUser(
    objectType: string,
    relation: string,
    userStr: string,
  ): Promise<string[]>

  /** All (object_id, user_str) for (objectType, relation). For tupleToUserset reverse walks. */
  listAllForRelation(
    objectType: string,
    relation: string,
  ): Promise<Array<{ object_id: string, user_str: string }>>
}

/**
 * Combine two TupleStores into one whose query methods return the
 * union (deduplicated) of both. Order is base first, overlay second
 * so the overlay's listings append uniquely.
 *
 * Used to fold OpenFGA `contextual_tuples` from a single check or
 * list-objects request into the evaluator's view without persisting
 * them — the caller wraps `pgTupleStore` with the contextual overlay
 * for the duration of the request and discards the wrapper after.
 */
export function unionTupleStore(base: TupleStore, overlay: TupleStore): TupleStore {
  return {
    async listTuplesForRelation(objectType, objectId, relation) {
      const [a, b] = await Promise.all([
        tupleEdges(base, objectType, objectId, relation),
        tupleEdges(overlay, objectType, objectId, relation),
      ])
      const edges = new Map(a.map(edge => [edge.user, edge]))
      for (const edge of b) edges.set(edge.user, edge)
      return [...edges.values()]
    },
    async listUsersForRelation(objectType, objectId, relation) {
      const [a, b] = await Promise.all([
        base.listUsersForRelation(objectType, objectId, relation),
        overlay.listUsersForRelation(objectType, objectId, relation),
      ])
      return [...new Set([...a, ...b])]
    },
    async listObjectIdsForUser(objectType, relation, userStr) {
      const [a, b] = await Promise.all([
        base.listObjectIdsForUser(objectType, relation, userStr),
        overlay.listObjectIdsForUser(objectType, relation, userStr),
      ])
      return [...new Set([...a, ...b])]
    },
    async listAllForRelation(objectType, relation) {
      const [a, b] = await Promise.all([
        base.listAllForRelation(objectType, relation),
        overlay.listAllForRelation(objectType, relation),
      ])
      const seen = new Set<string>()
      const out: Array<{ object_id: string, user_str: string }> = []
      for (const item of [...a, ...b]) {
        const key = `${item.object_id}\0${item.user_str}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push(item)
      }
      return out
    },
  }
}

/**
 * In-memory implementation. Test-only. Production code uses the
 * pg-backed implementation in `../storage/tuples.ts`.
 */
export class InMemoryTupleStore implements TupleStore {
  // Tuples stored as an array; queries are linear scans. Fine for tests.
  private tuples: Array<{
    object_type: string
    object_id: string
    relation: string
    user_str: string
    condition?: RelationshipCondition
  }> = []

  add(objectRef: string, relation: string, userStr: string, condition?: RelationshipCondition): void {
    const idx = objectRef.indexOf(':')
    if (idx < 0) throw new Error(`Invalid object: ${objectRef}`)
    this.tuples.push({
      object_type: objectRef.slice(0, idx),
      object_id: objectRef.slice(idx + 1),
      relation,
      user_str: userStr,
      condition,
    })
  }

  async listTuplesForRelation(objectType: string, objectId: string, relation: string): Promise<TupleEdge[]> {
    return this.tuples.filter(t => t.object_type === objectType && t.object_id === objectId && t.relation === relation)
      .map(t => ({ user: t.user_str, ...(t.condition ? { condition: t.condition } : {}) }))
  }

  async listUsersForRelation(
    objectType: string,
    objectId: string,
    relation: string,
  ): Promise<string[]> {
    return this.tuples
      .filter(t => t.object_type === objectType && t.object_id === objectId && t.relation === relation)
      .map(t => t.user_str)
  }

  async listObjectIdsForUser(
    objectType: string,
    relation: string,
    userStr: string,
  ): Promise<string[]> {
    const set = new Set<string>()
    for (const t of this.tuples) {
      if (t.object_type === objectType && t.relation === relation && t.user_str === userStr) {
        set.add(t.object_id)
      }
    }
    return [...set]
  }

  async listAllForRelation(
    objectType: string,
    relation: string,
  ): Promise<Array<{ object_id: string, user_str: string }>> {
    return this.tuples
      .filter(t => t.object_type === objectType && t.relation === relation)
      .map(t => ({ object_id: t.object_id, user_str: t.user_str }))
  }
}

export async function tupleEdges(store: TupleStore, type: string, id: string, relation: string): Promise<TupleEdge[]> {
  if (store.listTuplesForRelation) return store.listTuplesForRelation(type, id, relation)
  return (await store.listUsersForRelation(type, id, relation)).map(user => ({ user }))
}
