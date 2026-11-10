/**
 * Assertion routes — per-model regression-test fixtures the SDK
 * conformance suite reads/writes:
 *
 *   GET /stores/:storeId/assertions/:authorizationModelId
 *   PUT /stores/:storeId/assertions/:authorizationModelId
 */
import { Hono } from 'hono'
import { getAssertions, writeAssertions } from '../storage/assertions'
import { getAuthorizationModel } from '../storage/authorization-models'
import { validate } from '../middleware/validation'
import { modelNotFound } from './_helpers/model-errors'
import { WriteAssertionsBody } from './schemas'

export const assertionsRoutes = new Hono()

assertionsRoutes.get('/stores/:storeId/assertions/:authorizationModelId', async (c) => {
  const storeId = c.req.param('storeId')
  const authorizationModelId = c.req.param('authorizationModelId')
  // Validate the model pin exists; the SDK expects 404 when an unknown
  // model is referenced rather than a silently-empty response.
  // getAuthorizationModel scopes by store too, so a mismatched store-id
  // surfaces as 404 here.
  const model = await getAuthorizationModel(storeId, authorizationModelId)
  if (!model) return c.json({ code: 'not_found', message: 'authorization model not found' }, 404)

  const assertions = await getAssertions(storeId, authorizationModelId)
  return c.json({ authorization_model_id: authorizationModelId, assertions })
})

assertionsRoutes.put(
  '/stores/:storeId/assertions/:authorizationModelId',
  validate('json', WriteAssertionsBody),
  async (c) => {
    const storeId = c.req.param('storeId')
    const authorizationModelId = c.req.param('authorizationModelId')
    const model = await getAuthorizationModel(storeId, authorizationModelId)
    if (!model) return modelNotFound(c, storeId, authorizationModelId)

    const body = c.req.valid('json')
    await writeAssertions(storeId, authorizationModelId, body.assertions)
    // OpenFGA returns 204 No Content on a successful PUT. Hono's
    // c.body(null, 204) sends an empty body with the status.
    return c.body(null, 204)
  },
)
