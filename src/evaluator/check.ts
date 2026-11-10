import type { Userset } from '@openfga/sdk'
import type { ModelIndex } from './model-index'
import type { TupleStore, TupleEdge } from './tuple-store'
import { tupleEdges } from './tuple-store'
import { ConditionError } from './conditions'
import { CHECK_NODE_BUDGET, Deadline, REQUEST_TIMEOUT_MS, RESOLVE_NODE_LIMIT, ResolutionTooComplexError } from './limits'
import type { LimitOverrides } from './limits'

export type EvaluationContext = Record<string, unknown>

/**
 * CEL errors participate in the algebra: true OR error and false AND error are decisive.
 * Any other error (including ResolutionLimitError) aborts immediately.
 */
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
  if (!edge.condition && refs.length === 0) return true
  const [object, userset] = edge.user.split('#')
  const [userType, id] = object!.split(':')
  return refs.some(ref => ref.type === userType && (ref.condition || undefined) === edge.condition?.name
    && (userset ? ref.relation === userset : id === '*' ? ref.wildcard !== undefined : !ref.relation && !ref.wildcard))
}

type Outcome = { value: boolean } | { error: ConditionError }

/**
 * Per-request Check evaluator. Shares a memo across every Check it runs
 * (list-objects / list-users call it once per candidate), a request
 * deadline, and a node budget that resets per top-level Check.
 *
 * Evaluation is a sequential depth-first walk, so one stack describes
 * the current path. Memoization is cycle-aware: a node whose subtree
 * was cut short by a cycle back to an ancestor depends on that path and
 * is not cached (Tarjan-style low-link). Results are cached per user
 * and node only for this request's context; nothing outlives it.
 */
export class CheckResolver {
  private readonly memo = new Map<string, Outcome>()
  private readonly stack = new Map<string, number>()
  private readonly deadline: Deadline
  private readonly nodeBudget: number
  private nodes = 0
  private low = Infinity

  constructor(
    private readonly model: ModelIndex,
    private readonly store: TupleStore,
    private readonly context: EvaluationContext = {},
    limits: LimitOverrides = {},
  ) {
    this.deadline = new Deadline(limits.deadlineMs ?? REQUEST_TIMEOUT_MS)
    this.nodeBudget = limits.nodeBudget ?? CHECK_NODE_BUDGET
  }

  checkDeadline(): void { this.deadline.check() }

  async check(user: string, relation: string, object: string): Promise<boolean> {
    this.nodes = 0
    this.low = Infinity
    const target = splitObject(object)
    return this.relationCheck(user, target.type, target.id, relation)
  }

  private async relationCheck(user: string, type: string, id: string, rel: string): Promise<boolean> {
    const key = `${type}:${id}#${rel}`
    if (key === user) return true
    const memoKey = `${user}\0${key}`
    const cached = this.memo.get(memoKey)
    if (cached) {
      if ('error' in cached) throw cached.error
      return cached.value
    }
    const onStack = this.stack.get(key)
    if (onStack !== undefined) {
      this.low = Math.min(this.low, onStack)
      return false
    }
    if (this.stack.size >= RESOLVE_NODE_LIMIT || ++this.nodes > this.nodeBudget) throw new ResolutionTooComplexError()
    this.deadline.check()
    const def = this.model.getRelation(type, rel)
    if (!def) return false
    const depth = this.stack.size
    const outerLow = this.low
    this.stack.set(key, depth)
    this.low = Infinity
    try {
      const value = await this.rewriteCheck(user, type, id, rel, def.rewrite)
      if (this.low >= depth) this.memo.set(memoKey, { value })
      return value
    }
    catch (error) {
      if (error instanceof ConditionError && this.low >= depth) this.memo.set(memoKey, { error })
      throw error
    }
    finally {
      this.stack.delete(key)
      this.low = Math.min(outerLow, this.low)
    }
  }

  private async rewriteCheck(user: string, type: string, id: string, rel: string, rewrite: Userset): Promise<boolean> {
    const { model, store, context } = this
    if (rewrite.this !== undefined) {
      const userType = splitObject(user).type
      const edges = await tupleEdges(store, type, id, rel)
      return combineChecks(edges.filter(edge => edgeAllowed(model, type, rel, edge)).map(edge => async () => {
        const u = edge.user
        if (u === user || (u === `${userType}:*` && !user.includes('#'))) return model.conditions.evaluate(edge.condition, context)
        const hash = u.indexOf('#')
        if (hash < 0) return false
        const target = splitObject(u.slice(0, hash))
        return combineChecks([
          async () => model.conditions.evaluate(edge.condition, context),
          () => this.relationCheck(user, target.type, target.id, u.slice(hash + 1)),
        ], true)
      }))
    }
    if (rewrite.computedUserset?.relation) return this.relationCheck(user, type, id, rewrite.computedUserset.relation)
    if (rewrite.tupleToUserset) {
      const tupleset = rewrite.tupleToUserset.tupleset?.relation
      const computed = rewrite.tupleToUserset.computedUserset?.relation
      if (!tupleset || !computed) return false
      const edges = await tupleEdges(store, type, id, tupleset)
      return combineChecks(edges.filter(edge => !edge.user.includes('#') && !edge.user.endsWith(':*') && edgeAllowed(model, type, tupleset, edge)).map(edge => async () => {
        const target = splitObject(edge.user)
        return combineChecks([
          async () => model.conditions.evaluate(edge.condition, context),
          () => this.relationCheck(user, target.type, target.id, computed),
        ], true)
      }))
    }
    if (rewrite.union) return combineChecks((rewrite.union.child ?? []).map(child => () => this.rewriteCheck(user, type, id, rel, child)))
    if (rewrite.intersection) return combineChecks((rewrite.intersection.child ?? []).map(child => () => this.rewriteCheck(user, type, id, rel, child)), true)
    if (rewrite.difference?.base && rewrite.difference.subtract) {
      const { base, subtract } = rewrite.difference
      return combineChecks([
        () => this.rewriteCheck(user, type, id, rel, base),
        async () => !(await this.rewriteCheck(user, type, id, rel, subtract)),
      ], true)
    }
    return false
  }
}

export async function check(
  model: ModelIndex,
  store: TupleStore,
  user: string,
  relation: string,
  object: string,
  context: EvaluationContext = {},
  limits: LimitOverrides = {},
): Promise<boolean> {
  return new CheckResolver(model, store, context, limits).check(user, relation, object)
}

function splitObject(value: string): { type: string, id: string } {
  const colon = value.indexOf(':')
  if (colon < 0) throw new Error(`Invalid object reference: ${value}`)
  return { type: value.slice(0, colon), id: value.slice(colon + 1) }
}
