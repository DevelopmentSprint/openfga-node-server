/**
 * OpenFGA `expand` evaluator.
 *
 * Walks the rewrite tree for a given (object, relation) and emits a
 * UsersetTree shaped per the OpenFGA wire format. Unlike `check`,
 * expand does NOT recursively resolve tuples with userset-style users
 * (e.g. `group:eng#member`); those are reported as-is in the leaf,
 * and the client may recursively expand them itself.
 *
 * Rewrite handling:
 *   - `this`              leaf with `users` (direct + userset + wildcard refs)
 *   - `computedUserset`   leaf with `computed: { userset: "<object>#<rel>" }`
 *   - `tupleToUserset`    leaf with `tupleToUserset: { tupleset, computed[] }`
 *   - `union`             node with `union: { nodes: [...] }`
 *   - `intersection`      node with `intersection: { nodes: [...] }`
 *   - `difference`        node with `difference: { base, subtract }`
 *
 * Returns `null` when the relation is not defined on the type, so
 * the route handler can surface a clean 404 to the caller.
 */
import type { Node, Userset } from '@openfga/sdk'
import type { ModelIndex } from './model-index'
import type { TupleStore } from './tuple-store'
import { tupleEdges } from './tuple-store'
import { edgeAllowed } from './check'

export async function expand(
  model: ModelIndex,
  store: TupleStore,
  objectType: string,
  objectId: string,
  relation: string,
): Promise<Node | null> {
  const def = model.getRelation(objectType, relation)
  if (!def) return null
  return expandUserset(model, store, objectType, objectId, relation, def.rewrite)
}

async function expandUserset(
  model: ModelIndex,
  store: TupleStore,
  objectType: string,
  objectId: string,
  relation: string,
  rewrite: Userset,
): Promise<Node> {
  const name = `${objectType}:${objectId}#${relation}`

  if (rewrite.this !== undefined) {
    const users = (await tupleEdges(store, objectType, objectId, relation))
      .filter(edge => edgeAllowed(model, objectType, relation, edge)).map(edge => edge.user)
    return { name, leaf: { users: { users } } }
  }

  if (rewrite.computedUserset?.relation) {
    return {
      name,
      leaf: { computed: { userset: `${objectType}:${objectId}#${rewrite.computedUserset.relation}` } },
    }
  }

  if (rewrite.tupleToUserset) {
    const tuplesetRel = rewrite.tupleToUserset.tupleset?.relation
    const computedRel = rewrite.tupleToUserset.computedUserset?.relation
    if (!tuplesetRel || !computedRel) {
      // Malformed rewrite; emit an empty users leaf rather than throwing.
      return { name, leaf: { users: { users: [] } } }
    }
    const relatedUsers = (await tupleEdges(store, objectType, objectId, tuplesetRel))
      .filter(edge => edgeAllowed(model, objectType, tuplesetRel, edge)).map(edge => edge.user)
    const computed: Array<{ userset: string }> = []
    for (const ref of relatedUsers) {
      // Tupleset entries should be plain `type:id` object refs; skip
      // wildcards or userset-style entries that don't describe an
      // expandable target.
      if (ref.endsWith(':*') || ref.includes('#')) continue
      computed.push({ userset: `${ref}#${computedRel}` })
    }
    return {
      name,
      leaf: {
        tupleToUserset: {
          tupleset: `${objectType}:${objectId}#${tuplesetRel}`,
          computed,
        },
      },
    }
  }

  if (rewrite.union) {
    const children = rewrite.union.child ?? []
    const nodes = await Promise.all(
      children.map((c) => expandUserset(model, store, objectType, objectId, relation, c)),
    )
    return { name, union: { nodes } }
  }

  if (rewrite.intersection) {
    const children = rewrite.intersection.child ?? []
    const nodes = await Promise.all(
      children.map((c) => expandUserset(model, store, objectType, objectId, relation, c)),
    )
    return { name, intersection: { nodes } }
  }

  if (rewrite.difference) {
    const base = rewrite.difference.base
    const subtract = rewrite.difference.subtract
    if (!base || !subtract) {
      return { name, leaf: { users: { users: [] } } }
    }
    const [baseNode, subtractNode] = await Promise.all([
      expandUserset(model, store, objectType, objectId, relation, base),
      expandUserset(model, store, objectType, objectId, relation, subtract),
    ])
    return { name, difference: { base: baseNode, subtract: subtractNode } }
  }

  // Unknown rewrite shape — emit an empty leaf so callers always get a
  // well-formed Node rather than a runtime crash.
  return { name, leaf: { users: { users: [] } } }
}
