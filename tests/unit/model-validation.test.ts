import { describe, expect, it } from 'vitest'
import { validateAuthorizationModel } from '../../src/evaluator/model-validation'
import { modelCases } from '../_helpers/parity-models'

describe('authorization model semantic validation', () => {
  it.each(modelCases)('$name', ({ model, valid }) => {
    if (valid) expect(() => validateAuthorizationModel(model)).not.toThrow()
    else expect(() => validateAuthorizationModel(model)).toThrow()
  })
  it('bounds adversarial nesting before recursive parsing', () => {
    let value: unknown = {}
    for (let n = 0; n < 110; n++) value = { extra: value }
    expect(() => validateAuthorizationModel(value)).toThrow('too complex')
  })
})
