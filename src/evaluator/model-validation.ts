import type { AuthorizationModel, RelationReference, Userset } from '@openfga/sdk'
import { z } from 'zod'
import { Conditions } from './conditions'

export class ModelValidationError extends Error {}
const name = z.string().min(1).max(50).regex(/^[^:#@\s]+$/)
const typeName = z.string().min(1).max(254).regex(/^[^:#@\s]+$/)
const reference = z.object({ relation: name, object: z.literal('').optional() })
const rewrite: z.ZodType<Userset> = z.lazy(() => z.union([
  z.object({ this: z.object({}) }).strict(),
  z.object({ computedUserset: reference }).strict(),
  z.object({ tupleToUserset: z.object({ tupleset: reference, computedUserset: reference }) }).strict(),
  z.object({ union: z.object({ child: z.array(rewrite).min(2) }) }).strict(),
  z.object({ intersection: z.object({ child: z.array(rewrite).min(2) }) }).strict(),
  z.object({ difference: z.object({ base: rewrite, subtract: rewrite }) }).strict(),
]))
const relationReference = z.object({
  type: typeName, relation: name.optional(), wildcard: z.object({}).optional(), condition: z.string().optional(),
}).refine(r => !(r.relation && r.wildcard))
const modelSchema = z.object({
  schema_version: z.enum(['1.1', '1.2']),
  type_definitions: z.array(z.object({
    type: typeName,
    relations: z.record(name, rewrite).optional(),
    metadata: z.object({ relations: z.record(z.string(), z.object({
      directly_related_user_types: z.array(relationReference).optional(),
    })).optional() }).nullish(),
  })).min(1).max(100),
  conditions: z.record(z.string(), z.unknown()).optional(),
})

function children(r: Userset): Userset[] {
  return r.union?.child ?? r.intersection?.child ?? (r.difference ? [r.difference.base!, r.difference.subtract!] : [])
}
function containsThis(r: Userset): boolean { return r.this !== undefined || children(r).some(containsThis) }

/** Validate before indexing or persisting, following the reference type-system invariants. */
export function validateAuthorizationModel(input: unknown): asserts input is Omit<AuthorizationModel, 'id'> {
  // Bound nesting before the recursive schema runs, including untrusted JSON extensions.
  const pending: Array<[unknown, number]> = [[input, 0]]
  let nodes = 0
  while (pending.length) {
    const [v, depth] = pending.pop()!
    if (++nodes > 100000 || depth > 100) throw new ModelValidationError('authorization model is too complex')
    if (v && typeof v === 'object') for (const child of Object.values(v)) pending.push([child, depth + 1])
  }
  const result = modelSchema.safeParse(input)
  if (!result.success) throw new ModelValidationError('invalid authorization model structure')
  const model = result.data
  const conditions = new Conditions((input as AuthorizationModel).conditions)
  const types = new Map(model.type_definitions.map(td => [td.type, td]))
  const fail = (message: string): never => { throw new ModelValidationError(message) }
  if (types.size !== model.type_definitions.length) fail('duplicate type definitions')
  const has = (type: string, rel: string): boolean => Object.hasOwn(types.get(type)?.relations ?? {}, rel)
  const get = (type: string, rel: string): Userset => has(type, rel) ? types.get(type)!.relations![rel]! : fail(`relation '${type}#${rel}' is not defined`)
  const refs = (type: string, rel: string): RelationReference[] => types.get(type)?.metadata?.relations?.[rel]?.directly_related_user_types ?? []
  const tuplesets = new Set<string>()
  function validateRewrite(type: string, rel: string, r: Userset): void {
    if (r.computedUserset) {
      if (r.computedUserset.relation === rel) fail(`relation '${type}#${rel}' references itself`)
      get(type, r.computedUserset.relation!)
    }
    if (r.tupleToUserset) {
      const parent = r.tupleToUserset.tupleset!.relation!
      const target = r.tupleToUserset.computedUserset!.relation!
      if (get(type, parent).this === undefined) fail(`tupleset '${type}#${parent}' must be direct`)
      tuplesets.add(`${type}#${parent}`)
      if (!refs(type, parent).some(ref => has(ref.type, target))) fail(`tupleset target relation '${target}' is not defined`)
    }
    for (const child of children(r)) validateRewrite(type, rel, child)
  }
  for (const td of types.values()) {
    if (['self', 'this'].includes(td.type)) fail(`reserved type '${td.type}'`)
    for (const [rel, r] of Object.entries(td.relations ?? {})) {
      if (['self', 'this'].includes(rel)) fail(`reserved relation '${rel}'`)
      validateRewrite(td.type, rel, r)
      const allowed = refs(td.type, rel)
      if (containsThis(r) !== (allowed.length > 0)) fail(`invalid type restrictions for '${td.type}#${rel}'`)
      for (const ref of allowed) {
        if (!types.has(ref.type)) fail(`type '${ref.type}' is not defined`)
        if (ref.relation) get(ref.type, ref.relation)
        if (ref.condition && !conditions.has(ref.condition)) fail(`condition '${ref.condition}' is not defined`)
      }
    }
  }
  for (const key of tuplesets) {
    const [type, rel] = key.split('#')
    if (refs(type!, rel!).some(ref => ref.relation || ref.wildcard)) fail(`tupleset '${key}' must reference concrete objects`)
  }
  // Computed aliases must be acyclic. Tuple/userset recursion is legal when grounded.
  const checkedAliases = new Set<string>()
  function aliases(type: string, rel: string, r: Userset, path: Set<string>): void {
    if (r.computedUserset) {
      const target = r.computedUserset.relation!
      if (path.has(target)) fail(`cycle in '${type}#${rel}'`)
      const key = `${type}#${target}`
      if (!checkedAliases.has(key)) {
        aliases(type, target, get(type, target), new Set([...path, target]))
        checkedAliases.add(key)
      }
    }
    for (const child of children(r)) aliases(type, rel, child, path)
  }
  const grounded = new Set<string>()
  function entry(type: string, rel: string, r: Userset): boolean {
    if (r.this) return refs(type, rel).some(ref => !ref.relation || grounded.has(`${ref.type}#${ref.relation}`))
    if (r.computedUserset) return grounded.has(`${type}#${r.computedUserset.relation}`)
    if (r.tupleToUserset) return refs(type, r.tupleToUserset.tupleset!.relation!).some(ref => grounded.has(`${ref.type}#${r.tupleToUserset!.computedUserset!.relation}`))
    return r.union ? children(r).some(child => entry(type, rel, child)) : children(r).every(child => entry(type, rel, child))
  }
  const relations = [...types.values()].flatMap(td => Object.entries(td.relations ?? {}).map(([rel, r]) => ({ type: td.type, rel, r })))
  for (const { type, rel, r } of relations) aliases(type, rel, r, new Set([rel]))
  let changed = true
  while (changed) {
    changed = false
    for (const { type, rel, r } of relations) {
      const key = `${type}#${rel}`
      if (!grounded.has(key) && entry(type, rel, r)) { grounded.add(key); changed = true }
    }
  }
  for (const { type, rel } of relations) if (!grounded.has(`${type}#${rel}`)) fail(`relation '${type}#${rel}' has no entrypoint`)
}
