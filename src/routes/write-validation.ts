import type { TupleKey, TupleKeyWithoutCondition } from '@openfga/sdk'
import type { ModelIndex } from '../evaluator/model-index'
import { parseObject } from '../storage/tuples'

type WriteTupleKey = TupleKey | TupleKeyWithoutCondition

interface ParsedUserObject {
  kind: 'object'
  type: string
  id: string
}

interface ParsedUserUserset {
  kind: 'userset'
  type: string
  id: string
  relation: string
}

interface ParsedUserWildcard {
  kind: 'wildcard'
  type: string
}

type ParsedUser = ParsedUserObject | ParsedUserUserset | ParsedUserWildcard

function parseUser(user: string): ParsedUser | string {
  const usersetIdx = user.indexOf('#')
  if (usersetIdx >= 0) {
    const object = user.slice(0, usersetIdx)
    const relation = user.slice(usersetIdx + 1)
    if (!relation) return `invalid user reference "${user}"`
    try {
      const parsed = parseObject(object)
      if (!parsed.type || !parsed.id) return `invalid user reference "${user}"`
      return { kind: 'userset', type: parsed.type, id: parsed.id, relation }
    }
    catch {
      return `invalid user reference "${user}"`
    }
  }

  try {
    const parsed = parseObject(user)
    if (!parsed.type || !parsed.id) return `invalid user reference "${user}"`
    if (parsed.id === '*') return { kind: 'wildcard', type: parsed.type }
    return { kind: 'object', type: parsed.type, id: parsed.id }
  }
  catch {
    return `invalid user reference "${user}"`
  }
}

export function validateTupleKeyShape(tuple: WriteTupleKey): string | null {
  if (!tuple.user || !tuple.relation || !tuple.object) {
    return 'tuple_key.user, .relation, .object required'
  }
  try {
    const object = parseObject(tuple.object)
    if (!object.type || !object.id) return `invalid object reference "${tuple.object}"`
  }
  catch {
    return `invalid object reference "${tuple.object}"`
  }
  const user = parseUser(tuple.user)
  if (typeof user === 'string') return user
  return null
}

export function validateWriteTupleKey(model: ModelIndex, tuple: WriteTupleKey): string | null {
  const shapeError = validateTupleKeyShape(tuple)
  if (shapeError) return shapeError
  const condition = (tuple as TupleKey).condition
  if (condition) {
    try { model.conditions.validateContext(condition) }
    catch (error) { return error instanceof Error ? error.message : 'invalid condition' }
  }

  const object = parseObject(tuple.object)
  const relation = model.getRelation(object.type, tuple.relation)
  if (!relation) return `relation "${tuple.relation}" is not defined for type "${object.type}"`

  const user = parseUser(tuple.user) as ParsedUser
  if (user.kind === 'userset' && `${user.type}:${user.id}` === tuple.object && user.relation === tuple.relation) {
    return `cannot write implicit self-defining tuple "${tuple.user}" for ${tuple.object}#${tuple.relation}`
  }

  const allowed = relation.directlyRelatedUserTypes.some((ref) => {
    if (ref.type !== user.type || (ref.condition || undefined) !== condition?.name) return false
    if (user.kind === 'wildcard') return ref.wildcard !== undefined
    if (user.kind === 'userset') {
      return ref.relation === user.relation && model.getRelation(user.type, user.relation) !== null
    }
    return ref.relation === undefined && ref.wildcard === undefined
  })

  if (!allowed) return `user "${tuple.user}" is not allowed for ${object.type}#${tuple.relation}`
  return null
}
