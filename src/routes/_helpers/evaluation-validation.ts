import type { ModelIndex } from '../../evaluator/model-index'
import { ConditionError } from '../../evaluator/conditions'

export function validateRelation(model: ModelIndex, type: string, relation: string): void {
  if (!model.hasType(type)) throw new ConditionError(`invalid relation: type '${type}' not found`)
  if (!model.getRelation(type, relation)) throw new ConditionError(`invalid relation: relation '${type}#${relation}' not found`)
}

export function validateUser(model: ModelIndex, user: string): void {
  const type = user.slice(0, user.indexOf(':'))
  if (!model.hasType(type)) throw new ConditionError(`invalid relation: type '${type}' not found`)
  const hash = user.indexOf('#')
  if (hash >= 0) validateRelation(model, type, user.slice(hash + 1))
}

export function validateObject(object: string): void {
  const id = object.slice(object.indexOf(':') + 1)
  if (!id || id.includes('#')) throw new ConditionError("invalid relation: invalid 'object' field format")
  if (id === '*') throw new ConditionError("invalid relation: the 'object' field cannot reference a typed wildcard")
}

/**
 * Undefined target type / relation on expand, list-objects and list-users.
 * Upstream v1.22.0 reports these as `type_not_found` / `relation_not_found`
 * (pkg/server/commands/expand.go, list_objects.go, listusers/validate.go),
 * distinct from check's generic `validation_error`. HTTP 400 either way.
 */
export class ModelReferenceError extends Error {
  constructor(readonly code: 'type_not_found' | 'relation_not_found', message: string) {
    super(message)
  }
}

export function validateTarget(model: ModelIndex, type: string, relation?: string): void {
  if (!model.hasType(type)) throw new ModelReferenceError('type_not_found', `type '${type}' not found`)
  if (relation === undefined) return
  if (!model.getRelation(type, relation)) {
    throw new ModelReferenceError('relation_not_found', `relation '${type}#${relation}' not found`)
  }
}
