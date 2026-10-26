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
 *   - `union`             set-union of children
 *   - `intersection`      set-intersection of children
 *   - `difference`        base set minus subtract set
 *
 * Returns `null` when the relation is undefined on the type so the
 * route can surface a clean 400.
 */
import type { Userset, User, UserTypeFilter } from '@openfga/sdk'
import type { ModelIndex } from './model-index'
import type { TupleStore } from './tuple-store'
import { check } from './check'

export async function listUsers(
  model: ModelIndex,
  store: TupleStore,
  objectType: string,
  objectId: string,
  relation: string,
  userFilter: UserTypeFilter,
  context: Record<string, unknown> = {},
): Promise<User[] | null> {
  if (!model.getRelation(objectType, relation)) return null
  const reachable = await gatherForRelation(model, store, objectType, objectId, relation, new Set())
  const out: User[] = []
  for (const candidate of reachable) {
    const user = toUser(candidate)
    if (matchesFilter(user, userFilter) && await check(model, store, candidate, relation, `${objectType}:${objectId}`, context)) out.push(user)
  }
  return out
}

async function gather(
  model: ModelIndex,
  store: TupleStore,
  objectType: string,
  objectId: string,
  relation: string,
  rewrite: Userset,
  visited: Set<string>,
): Promise<Set<string>> {
  // Note: cycle detection lives in gatherForRelation, not here. Union /
  // intersection / difference children recurse with the SAME
  // (objectType, objectId, relation) but a different child rewrite —
  // those are subtrees of the same node, not new visit edges. Putting
  // the visit check at this layer would short-circuit those legitimate
  // recursions.
  if (rewrite.this !== undefined) {
    const users = await store.listUsersForRelation(objectType, objectId, relation)
    const out = new Set<string>()
    for (const u of users) {
      // Always include the raw user_str so userset and wildcard
      // filters (e.g. user_filters: [{type: 'group', relation:
      // 'member'}]) still find their match shapes.
      out.add(u)
      // OpenFGA ListUsers expands userset references when the
      // requested filter targets the underlying user type. So for
      // a tuple like (doc:1, viewer, group:eng#member), a request
      // with user_filters: [{type: 'user'}] should return the
      // concrete users members of group:eng — not nothing. Recurse
      // into the referenced (type, id, relation) and merge its
      // users into the gather set; matchesFilter at the call site
      // picks the right shape based on the filter. See openfga-6e6.
      const hashIdx = u.indexOf('#')
      if (hashIdx > 0) {
        const left = u.slice(0, hashIdx)
        const usRelation = u.slice(hashIdx + 1)
        const colonIdx = left.indexOf(':')
        if (colonIdx > 0) {
          const usType = left.slice(0, colonIdx)
          const usId = left.slice(colonIdx + 1)
          // Skip if the referenced object is itself a wildcard
          // (`group:*#member` is unusual but defensively guarded).
          if (usId !== '*' && usId.length > 0) {
            const expanded = await gatherForRelation(
              model,
              store,
              usType,
              usId,
              usRelation,
              visited,
            )
            for (const e of expanded) out.add(e)
          }
        }
      }
    }
    return out
  }

  if (rewrite.computedUserset?.relation) {
    return gatherForRelation(model, store, objectType, objectId, rewrite.computedUserset.relation, visited)
  }

  if (rewrite.tupleToUserset) {
    const tuplesetRel = rewrite.tupleToUserset.tupleset?.relation
    const computedRel = rewrite.tupleToUserset.computedUserset?.relation
    if (!tuplesetRel || !computedRel) return new Set()
    const parents = await store.listUsersForRelation(objectType, objectId, tuplesetRel)
    const out = new Set<string>()
    for (const parent of parents) {
      // Skip wildcards/usersets — tupleset refs must be concrete objects.
      if (parent.endsWith(':*') || parent.includes('#')) continue
      const idx = parent.indexOf(':')
      if (idx <= 0) continue
      const [pt, pid] = [parent.slice(0, idx), parent.slice(idx + 1)]
      const childUsers = await gatherForRelation(model, store, pt, pid, computedRel, visited)
      for (const u of childUsers) out.add(u)
    }
    return out
  }

  if (rewrite.union) {
    const out = new Set<string>()
    for (const child of rewrite.union.child ?? []) {
      const childUsers = await gather(model, store, objectType, objectId, relation, child, new Set(visited))
      for (const u of childUsers) out.add(u)
    }
    return out
  }

  if (rewrite.intersection) {
    // Gather a superset; Check applies intersection and conditions per candidate.
    const out = new Set<string>()
    for (const child of rewrite.intersection.child ?? []) {
      for (const user of await gather(model, store, objectType, objectId, relation, child, new Set(visited))) out.add(user)
    }
    return out
  }
  if (rewrite.difference?.base) {
    return gather(model, store, objectType, objectId, relation, rewrite.difference.base, new Set(visited))
  }

  return new Set()
}

async function gatherForRelation(
  model: ModelIndex,
  store: TupleStore,
  objectType: string,
  objectId: string,
  relation: string,
  visited: Set<string>,
): Promise<Set<string>> {
  const visitKey = `${objectType}:${objectId}#${relation}`
  if (visited.has(visitKey)) return new Set()
  const def = model.getRelation(objectType, relation)
  if (!def) return new Set()
  const next = new Set(visited)
  next.add(visitKey)
  return gather(model, store, objectType, objectId, relation, def.rewrite, next)
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
