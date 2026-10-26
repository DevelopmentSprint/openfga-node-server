import type { Userset } from '@openfga/sdk'
import type { ModelIndex } from './model-index'
import type { TupleStore, TupleEdge } from './tuple-store'
import { tupleEdges } from './tuple-store'
import { ConditionError } from './conditions'

export type EvaluationContext = Record<string, unknown>

/** CEL errors participate in the algebra: true OR error and false AND error are decisive. */
export async function combineChecks(children: Array<() => Promise<boolean>>, intersection = false): Promise<boolean> {
  let failure: ConditionError | undefined
  for (const child of children) {
    try {
      const result = await child()
      if (result !== intersection) return result
    }
    catch (err) {
      if (!(err instanceof ConditionError)) throw err
      failure = err
    }
  }
  if (failure) throw failure
  return intersection && children.length > 0
}

/** Invalid persisted edges under a selected model must never become grants. */
export function edgeAllowed(model: ModelIndex, type: string, relation: string, edge: TupleEdge): boolean {
  const refs = model.getRelation(type, relation)?.directlyRelatedUserTypes ?? []
  if (!edge.condition && !refs.some(ref => ref.condition)) return true
  const [object, userset] = edge.user.split('#')
  const [userType, id] = object!.split(':')
  return refs.some(ref => ref.type === userType && (ref.condition || undefined) === edge.condition?.name
    && (userset ? ref.relation === userset : id === '*' ? ref.wildcard !== undefined : !ref.relation && !ref.wildcard))
}

export async function check(model: ModelIndex, store: TupleStore, user: string, relation: string, object: string, context: EvaluationContext = {}): Promise<boolean> {
  const userType = splitObject(user).type
  async function relationCheck(type: string, id: string, rel: string, path: Set<string>): Promise<boolean> {
    const key = `${type}:${id}#${rel}`
    if (path.has(key)) return false
    if (path.size >= 25) throw new ConditionError('authorization model resolution too complex')
    const def = model.getRelation(type, rel)
    if (!def) return false
    return rewriteCheck(type, id, rel, def.rewrite, new Set([...path, key]))
  }
  async function rewriteCheck(type: string, id: string, rel: string, rewrite: Userset, path: Set<string>): Promise<boolean> {
    if (rewrite.this !== undefined) {
      const edges = await tupleEdges(store, type, id, rel)
      return combineChecks(edges.filter(edge => edgeAllowed(model, type, rel, edge)).map(edge => async () => {
        const u = edge.user
        if (u === user || (u === `${userType}:*` && !user.includes('#'))) return model.conditions.evaluate(edge.condition, context)
        const hash = u.indexOf('#')
        if (hash < 0) return false
        const target = splitObject(u.slice(0, hash))
        return combineChecks([
          async () => model.conditions.evaluate(edge.condition, context),
          () => relationCheck(target.type, target.id, u.slice(hash + 1), path),
        ], true)
      }))
    }
    if (rewrite.computedUserset?.relation) return relationCheck(type, id, rewrite.computedUserset.relation, path)
    if (rewrite.tupleToUserset) {
      const tupleset = rewrite.tupleToUserset.tupleset?.relation
      const computed = rewrite.tupleToUserset.computedUserset?.relation
      if (!tupleset || !computed) return false
      const edges = await tupleEdges(store, type, id, tupleset)
      return combineChecks(edges.filter(edge => !edge.user.includes('#') && !edge.user.endsWith(':*') && edgeAllowed(model, type, tupleset, edge)).map(edge => async () => {
        const target = splitObject(edge.user)
        return combineChecks([
          async () => model.conditions.evaluate(edge.condition, context),
          () => relationCheck(target.type, target.id, computed, path),
        ], true)
      }))
    }
    if (rewrite.union) return combineChecks((rewrite.union.child ?? []).map(child => () => rewriteCheck(type, id, rel, child, path)))
    if (rewrite.intersection) return combineChecks((rewrite.intersection.child ?? []).map(child => () => rewriteCheck(type, id, rel, child, path)), true)
    if (rewrite.difference?.base && rewrite.difference.subtract) {
      return combineChecks([
        () => rewriteCheck(type, id, rel, rewrite.difference!.base!, path),
        async () => !(await rewriteCheck(type, id, rel, rewrite.difference!.subtract!, path)),
      ], true)
    }
    return false
  }
  const target = splitObject(object)
  return relationCheck(target.type, target.id, relation, new Set())
}

function splitObject(value: string): { type: string, id: string } {
  const colon = value.indexOf(':')
  if (colon < 0) throw new Error(`Invalid object reference: ${value}`)
  return { type: value.slice(0, colon), id: value.slice(colon + 1) }
}
