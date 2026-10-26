/**
 * OpenFGA `list-objects` (reverse expansion) evaluator.
 *
 * Strategy: walk the rewrite tree forward to gather a candidate set of
 * object_ids that could possibly match, then filter by `check()` to
 * pick up `intersection` / `difference` correctness.
 *
 * O(candidates × check) — acceptable at prototype scale. If
 * `list-objects` becomes a hot path, replace with a proper
 * reverse-expansion algorithm (Zanzibar §5.2).
 */
import type { Userset } from '@openfga/sdk'
import { check } from './check'
import { ConditionError } from './conditions'
import type { ModelIndex } from './model-index'
import type { TupleStore } from './tuple-store'

export async function listObjects(
  model: ModelIndex,
  store: TupleStore,
  user: string,
  relation: string,
  objectType: string,
  context: Record<string, unknown> = {},
): Promise<string[]> {
  if (!model.hasType(objectType)) return []
  const candidates = await gather(model, store, user, objectType, relation, new Set())
  const out: string[] = []
  for (const oid of candidates) {
    if (await check(model, store, user, relation, `${objectType}:${oid}`, context)) {
      out.push(oid)
    }
  }
  return out
}

async function gather(
  model: ModelIndex,
  store: TupleStore,
  user: string,
  objectType: string,
  relation: string,
  visited: Set<string>,
): Promise<Set<string>> {
  const visitKey = `${objectType}#${relation}`
  if (visited.has(visitKey)) return new Set()
  visited.add(visitKey)

  const def = model.getRelation(objectType, relation)
  if (!def) return new Set()
  return gatherForRewrite(model, store, user, objectType, relation, def.rewrite, visited)
}

async function gatherForRewrite(
  model: ModelIndex,
  store: TupleStore,
  user: string,
  objectType: string,
  relation: string,
  rewrite: Userset,
  visited: Set<string>,
): Promise<Set<string>> {
  if (rewrite.this !== undefined) {
    return gatherDirect(model, store, user, objectType, relation)
  }
  if (rewrite.computedUserset?.relation) {
    return gather(model, store, user, objectType, rewrite.computedUserset.relation, visited)
  }
  if (rewrite.tupleToUserset) {
    const tuplesetRel = rewrite.tupleToUserset.tupleset?.relation
    const computedRel = rewrite.tupleToUserset.computedUserset?.relation
    if (!tuplesetRel || !computedRel) return new Set()
    return gatherTupleToUserset(model, store, user, objectType, tuplesetRel, computedRel, visited)
  }
  if (rewrite.union) {
    const out = new Set<string>()
    for (const child of rewrite.union.child ?? []) {
      const childIds = await gatherForRewrite(model, store, user, objectType, relation, child, new Set(visited))
      for (const id of childIds) out.add(id)
    }
    return out
  }
  if (rewrite.intersection) {
    // Take the union — `check()` filters down to true intersection.
    const out = new Set<string>()
    for (const child of rewrite.intersection.child ?? []) {
      const childIds = await gatherForRewrite(model, store, user, objectType, relation, child, new Set(visited))
      for (const id of childIds) out.add(id)
    }
    return out
  }
  if (rewrite.difference?.base) {
    return gatherForRewrite(model, store, user, objectType, relation, rewrite.difference.base, visited)
  }
  return new Set()
}

async function gatherDirect(
  model: ModelIndex,
  store: TupleStore,
  user: string,
  objectType: string,
  relation: string,
): Promise<Set<string>> {
  const out = new Set<string>()

  // Direct user reference.
  for (const oid of await store.listObjectIdsForUser(objectType, relation, user)) {
    out.add(oid)
  }

  // Typed wildcard `<userType>:*`.
  const userType = parseObject(user).type
  for (const oid of await store.listObjectIdsForUser(objectType, relation, `${userType}:*`)) {
    out.add(oid)
  }

  // Userset references — scan tuples for this relation, recurse into
  // each `<type>:<id>#<rel>` user_str.
  const all = await store.listAllForRelation(objectType, relation)
  for (const { object_id, user_str } of all) {
    const hashIdx = user_str.indexOf('#')
    if (hashIdx < 0) continue
    if (out.has(object_id)) continue
    const refObject = user_str.slice(0, hashIdx)
    const refRelation = user_str.slice(hashIdx + 1)
    const { type: refType, id: refId } = parseObject(refObject)
    try {
      if (await check(model, store, user, refRelation, `${refType}:${refId}`)) out.add(object_id)
    }
    catch (error) {
      if (!(error instanceof ConditionError)) throw error
      // Candidate discovery cannot decide an edge without request context.
      // The final Check uses the complete context and error algebra.
      out.add(object_id)
    }
  }

  return out
}

async function gatherTupleToUserset(
  model: ModelIndex,
  store: TupleStore,
  user: string,
  objectType: string,
  tuplesetRel: string,
  computedRel: string,
  visited: Set<string>,
): Promise<Set<string>> {
  const tuplesetDef = model.getRelation(objectType, tuplesetRel)
  if (!tuplesetDef) return new Set()
  const out = new Set<string>()

  for (const ref of tuplesetDef.directlyRelatedUserTypes) {
    if (!ref.type) continue
    const type2 = ref.type
    // Find every type2 object the user has `computedRel` on, recursively.
    const reachable = await gather(model, store, user, type2, computedRel, new Set(visited))
    for (const type2Id of reachable) {
      // Find object_ids of objectType where (objectType:?, tuplesetRel, type2:type2Id).
      for (const oid of await store.listObjectIdsForUser(objectType, tuplesetRel, `${type2}:${type2Id}`)) {
        out.add(oid)
      }
    }
  }

  return out
}

function parseObject(s: string): { type: string, id: string } {
  const idx = s.indexOf(':')
  if (idx < 0) throw new Error(`Invalid object reference: ${s}`)
  return { type: s.slice(0, idx), id: s.slice(idx + 1) }
}
