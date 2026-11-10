/**
 * OpenFGA `list-users` (reverse-expansion-by-user) evaluator.
 *
 * Strategy: forward-walk the rewrite tree from (object, relation),
 * gather every user_str reachable through the algebra, then convert
 * each into the right OpenFGA `User` shape (object / userset /
 * wildcard) and filter by the request's `user_filter`.
 *
 * Algorithm per rewrite type:
 *   - `this`              listUsersForRelation(...) — direct grants;
 *                         additionally expands any userset references
 *                         (`<type>:<id>#<relation>`) by recursing into
 *                         that userset's own users, so a request
 *                         filtered by the underlying user type
 *                         surfaces concrete users reached through
 *                         group memberships. See openfga-6e6.
 *   - `computedUserset`   recurse into the computed relation
 *   - `tupleToUserset`    listUsersForRelation(tupleset) for parent
 *                         refs, then recurse into `computedUserset`
 *                         on each parent
 *   - `union`, `intersection`, `difference`
 *                         union of every child (a superset); Check
 *                         applies the real set algebra per candidate
 *
 * Candidates are confirmed with Check (shared per-request memo). Limits
 * follow upstream defaults: at most LIST_USERS_MAX_RESULTS users, and
 * the results found so far once LIST_USERS_DEADLINE_MS passes.
 *
 * Returns `null` when the relation is undefined on the type so the
 * route can surface a clean 400.
 */
import type { Userset, User, UserTypeFilter } from '@openfga/sdk'
import type { ModelIndex } from './model-index'
import type { TupleStore } from './tuple-store'
import { CheckResolver } from './check'
import { DeadlineExceededError, LIST_USERS_DEADLINE_MS, LIST_USERS_MAX_RESULTS } from './limits'
import type { LimitOverrides } from './limits'

export async function listUsers(
  model: ModelIndex,
  store: TupleStore,
  objectType: string,
  objectId: string,
  relation: string,
  userFilter: UserTypeFilter,
  context: Record<string, unknown> = {},
  limits: LimitOverrides = {},
): Promise<User[] | null> {
  if (!model.getRelation(objectType, relation)) return null
  const maxResults = limits.maxResults ?? LIST_USERS_MAX_RESULTS
  const resolver = new CheckResolver(model, store, context, {
    deadlineMs: limits.deadlineMs ?? LIST_USERS_DEADLINE_MS,
    nodeBudget: limits.nodeBudget,
  })
  const out: User[] = []
  try {
    const reachable = new Set<string>()
    await visit(model, store, resolver, objectType, objectId, relation, new Set(), reachable)
    for (const candidate of reachable) {
      if (maxResults > 0 && out.length >= maxResults) break
      const user = toUser(candidate)
      if (matchesFilter(user, userFilter) && await resolver.check(candidate, relation, `${objectType}:${objectId}`)) out.push(user)
    }
  }
  catch (error) {
    // Upstream returns the results found within the deadline.
    if (!(error instanceof DeadlineExceededError)) throw error
  }
  return out
}

/**
 * Every rewrite operator gathers a superset (Check filters per
 * candidate), so the candidate set is simply the union of the users and
 * userset nodes reachable from the root. A node-level visited set makes
 * each (object, relation) expand once, so diamonds and cycles cost
 * O(nodes) instead of O(paths).
 */
async function visit(
  model: ModelIndex,
  store: TupleStore,
  resolver: CheckResolver,
  objectType: string,
  objectId: string,
  relation: string,
  visited: Set<string>,
  out: Set<string>,
): Promise<void> {
  const key = `${objectType}:${objectId}#${relation}`
  if (visited.has(key)) return
  visited.add(key)
  // Upstream ListUsers emits every expanded userset that matches the filter.
  out.add(key)
  const def = model.getRelation(objectType, relation)
  if (!def) return
  resolver.checkDeadline()
  await walk(model, store, resolver, objectType, objectId, relation, def.rewrite, visited, out)
}

async function walk(
  model: ModelIndex,
  store: TupleStore,
  resolver: CheckResolver,
  objectType: string,
  objectId: string,
  relation: string,
  rewrite: Userset,
  visited: Set<string>,
  out: Set<string>,
): Promise<void> {
  if (rewrite.this !== undefined) {
    for (const u of await store.listUsersForRelation(objectType, objectId, relation)) {
      // Keep the raw user_str so userset and wildcard filters match, and
      // expand userset references so filters on the underlying user type
      // surface concrete members (openfga-6e6).
      out.add(u)
      const ref = parseUserset(u)
      if (ref && ref.id !== '*' && ref.id.length > 0) await visit(model, store, resolver, ref.type, ref.id, ref.relation, visited, out)
    }
    return
  }
  if (rewrite.computedUserset?.relation) {
    await visit(model, store, resolver, objectType, objectId, rewrite.computedUserset.relation, visited, out)
    return
  }
  if (rewrite.tupleToUserset) {
    const tuplesetRel = rewrite.tupleToUserset.tupleset?.relation
    const computedRel = rewrite.tupleToUserset.computedUserset?.relation
    if (!tuplesetRel || !computedRel) return
    for (const parent of await store.listUsersForRelation(objectType, objectId, tuplesetRel)) {
      // Tupleset refs must be concrete objects.
      if (parent.endsWith(':*') || parent.includes('#')) continue
      const idx = parent.indexOf(':')
      if (idx <= 0) continue
      await visit(model, store, resolver, parent.slice(0, idx), parent.slice(idx + 1), computedRel, visited, out)
    }
    return
  }
  // Union, intersection and both sides of a difference contribute
  // candidates: exclusions can become grants under a nested difference.
  const children = rewrite.union?.child ?? rewrite.intersection?.child
    ?? (rewrite.difference ? [rewrite.difference.base, rewrite.difference.subtract].filter(c => c !== undefined) : [])
  for (const child of children) await walk(model, store, resolver, objectType, objectId, relation, child, visited, out)
}

function parseUserset(u: string): { type: string, id: string, relation: string } | null {
  const hashIdx = u.indexOf('#')
  if (hashIdx <= 0) return null
  const left = u.slice(0, hashIdx)
  const colonIdx = left.indexOf(':')
  if (colonIdx <= 0) return null
  return { type: left.slice(0, colonIdx), id: left.slice(colonIdx + 1), relation: u.slice(hashIdx + 1) }
}

function toUser(userStr: string): User {
  // Wildcard: `type:*`
  if (userStr.endsWith(':*')) {
    return { wildcard: { type: userStr.slice(0, -2) } }
  }
  // Userset: `type:id#relation`
  const hashIdx = userStr.indexOf('#')
  if (hashIdx > 0) {
    const left = userStr.slice(0, hashIdx)
    const relation = userStr.slice(hashIdx + 1)
    const colonIdx = left.indexOf(':')
    if (colonIdx > 0) {
      return { userset: { type: left.slice(0, colonIdx), id: left.slice(colonIdx + 1), relation } }
    }
  }
  // Concrete object: `type:id`
  const colonIdx = userStr.indexOf(':')
  if (colonIdx > 0) {
    return { object: { type: userStr.slice(0, colonIdx), id: userStr.slice(colonIdx + 1) } }
  }
  // Malformed entry; emit empty object form so callers always get a
  // well-shaped User. Should not happen with valid storage.
  return { object: { type: '', id: userStr } }
}

function matchesFilter(user: User, filter: UserTypeFilter): boolean {
  if (user.object) {
    return user.object.type === filter.type && filter.relation === undefined
  }
  if (user.userset) {
    if (user.userset.type !== filter.type) return false
    if (filter.relation === undefined) return false
    return user.userset.relation === filter.relation
  }
  if (user.wildcard) {
    return user.wildcard.type === filter.type && filter.relation === undefined
  }
  return false
}
