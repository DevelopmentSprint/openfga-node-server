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
