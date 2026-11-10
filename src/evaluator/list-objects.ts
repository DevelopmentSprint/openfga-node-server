/**
 * OpenFGA `list-objects` (reverse expansion) evaluator.
 *
 * Strategy: walk the rewrite tree forward to gather a candidate set of
 * object_ids that could possibly match, then filter by Check to pick up
 * `intersection` / `difference` / condition correctness.
 *
 * Candidate discovery is a monotone fixpoint over `type#relation`
 * nodes. A node reached again while it is still being computed (for
 * example `viewer from parent` on `folder`) reads the previous round's
 * result, and rounds repeat until no node's candidate set grows. Storage
 * reads are cached per request so later rounds only query new ids.
 *
 * Limits follow upstream defaults: results stop at LIST_OBJECTS_MAX_RESULTS
 * (0 = unlimited, used by streamed-list-objects) and the request returns
 * whatever was confirmed when LIST_OBJECTS_DEADLINE_MS passes. Resolution
 * depth/budget errors propagate.
 */
import type { Userset } from '@openfga/sdk'
import { CheckResolver } from './check'
import { ConditionError } from './conditions'
import { DeadlineExceededError, LIST_OBJECTS_DEADLINE_MS, LIST_OBJECTS_MAX_RESULTS } from './limits'
import type { LimitOverrides } from './limits'
import type { ModelIndex } from './model-index'
import type { TupleStore } from './tuple-store'

export async function listObjects(
  model: ModelIndex,
  store: TupleStore,
  user: string,
  relation: string,
  objectType: string,
  context: Record<string, unknown> = {},
  limits: LimitOverrides = {},
): Promise<string[]> {
  if (!model.hasType(objectType)) return []
  const maxResults = limits.maxResults ?? LIST_OBJECTS_MAX_RESULTS
  const resolver = new CheckResolver(model, store, context, {
    deadlineMs: limits.deadlineMs ?? LIST_OBJECTS_DEADLINE_MS,
    nodeBudget: limits.nodeBudget,
  })
  const out: string[] = []
  try {
    const candidates = await new CandidateGatherer(model, store, user, resolver).run(objectType, relation)
    // Usersets contain themselves even without a persisted membership tuple.
    if (user.startsWith(`${objectType}:`) && user.includes('#')) candidates.add(user.slice(objectType.length + 1, user.indexOf('#')))
    for (const oid of candidates) {
      if (maxResults > 0 && out.length >= maxResults) break
      if (await resolver.check(user, relation, `${objectType}:${oid}`)) out.push(oid)
    }
  }
  catch (error) {
    // Upstream returns the results found within the deadline.
    if (!(error instanceof DeadlineExceededError)) throw error
  }
  return out
}

class CandidateGatherer {
  private previous = new Map<string, Set<string>>()
  private current = new Map<string, Set<string>>()
  private readonly inProgress = new Set<string>()
  private readonly reads = new Map<string, Promise<string[]>>()
  private readonly direct = new Map<string, Promise<Set<string>>>()
  private grew = false

  constructor(
    private readonly model: ModelIndex,
    private readonly store: TupleStore,
    private readonly user: string,
    private readonly resolver: CheckResolver,
  ) {}

  async run(objectType: string, relation: string): Promise<Set<string>> {
    for (;;) {
      this.grew = false
      this.current = new Map()
      const result = await this.node(objectType, relation)
      this.previous = this.current
      if (!this.grew) return result
    }
  }

  private async node(objectType: string, relation: string): Promise<Set<string>> {
    const key = `${objectType}#${relation}`
    const done = this.current.get(key)
    if (done) return done
    const before = this.previous.get(key) ?? new Set<string>()
    if (this.inProgress.has(key)) return before
    this.resolver.checkDeadline()
    const def = this.model.getRelation(objectType, relation)
    if (!def) return new Set()
    this.inProgress.add(key)
    try {
      const found = await this.rewrite(objectType, relation, def.rewrite)
      // Sets only grow between rounds; keep earlier members explicitly.
      for (const id of before) found.add(id)
      if (found.size !== before.size) this.grew = true
      this.current.set(key, found)
      return found
    }
    finally {
      this.inProgress.delete(key)
    }
  }

  private async rewrite(objectType: string, relation: string, rewrite: Userset): Promise<Set<string>> {
    if (rewrite.this !== undefined) return new Set(await this.directCandidates(objectType, relation))
    if (rewrite.computedUserset?.relation) return new Set(await this.node(objectType, rewrite.computedUserset.relation))
    if (rewrite.tupleToUserset) {
      const tuplesetRel = rewrite.tupleToUserset.tupleset?.relation
      const computedRel = rewrite.tupleToUserset.computedUserset?.relation
      if (!tuplesetRel || !computedRel) return new Set()
      return this.tupleToUserset(objectType, tuplesetRel, computedRel)
    }
    // Intersection and difference gather a superset; Check decides.
    const children = rewrite.union?.child ?? rewrite.intersection?.child
      ?? (rewrite.difference?.base ? [rewrite.difference.base] : [])
    const out = new Set<string>()
    for (const child of children) {
      for (const id of await this.rewrite(objectType, relation, child)) out.add(id)
    }
    return out
  }

  /** Direct, wildcard and userset grants. Independent of the fixpoint, so computed once. */
  private directCandidates(objectType: string, relation: string): Promise<Set<string>> {
    const key = `${objectType}#${relation}`
    let pending = this.direct.get(key)
    if (!pending) {
      pending = this.gatherDirect(objectType, relation)
      this.direct.set(key, pending)
    }
    return pending
  }

  private async gatherDirect(objectType: string, relation: string): Promise<Set<string>> {
    const out = new Set<string>()
    for (const oid of await this.objectIdsFor(objectType, relation, this.user)) out.add(oid)
    const userType = parseObject(this.user).type
    for (const oid of await this.objectIdsFor(objectType, relation, `${userType}:*`)) out.add(oid)

    // Userset references: keep objects whose referenced userset contains the user.
    for (const { object_id, user_str } of await this.store.listAllForRelation(objectType, relation)) {
      const hashIdx = user_str.indexOf('#')
      if (hashIdx < 0 || out.has(object_id)) continue
      this.resolver.checkDeadline()
      try {
        if (await this.resolver.check(this.user, user_str.slice(hashIdx + 1), user_str.slice(0, hashIdx))) out.add(object_id)
      }
      catch (error) {
        if (!(error instanceof ConditionError)) throw error
        // The final Check applies the condition error algebra.
        out.add(object_id)
      }
    }
    return out
  }

  private async tupleToUserset(objectType: string, tuplesetRel: string, computedRel: string): Promise<Set<string>> {
    const tuplesetDef = this.model.getRelation(objectType, tuplesetRel)
    if (!tuplesetDef) return new Set()
    const out = new Set<string>()
    for (const ref of tuplesetDef.directlyRelatedUserTypes) {
      if (!ref.type) continue
      for (const parentId of await this.node(ref.type, computedRel)) {
        this.resolver.checkDeadline()
        for (const oid of await this.objectIdsFor(objectType, tuplesetRel, `${ref.type}:${parentId}`)) out.add(oid)
      }
    }
    return out
  }

  private objectIdsFor(objectType: string, relation: string, userStr: string): Promise<string[]> {
    const key = `${objectType}\0${relation}\0${userStr}`
    let pending = this.reads.get(key)
    if (!pending) {
      pending = this.store.listObjectIdsForUser(objectType, relation, userStr)
      this.reads.set(key, pending)
    }
    return pending
  }
}

function parseObject(s: string): { type: string, id: string } {
  const idx = s.indexOf(':')
  if (idx < 0) throw new Error(`Invalid object reference: ${s}`)
  return { type: s.slice(0, idx), id: s.slice(idx + 1) }
}
