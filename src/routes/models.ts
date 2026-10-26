/**
 * Authorization-model routes:
 *
 *   POST /stores/:storeId/authorization-models       create model
 *                                                    (JSON or DSL body)
 *   GET  /stores/:storeId/authorization-models       list models
 *   GET  /stores/:storeId/authorization-models/:id   read model
 */
import { ModelIndex } from '../evaluator/model-index'
import { ConditionError } from '../evaluator/conditions'
import { Hono } from 'hono'
import type { AuthorizationModel } from '@openfga/sdk'
import { transformer } from '@openfga/syntax-transformer'
import {
  getAuthorizationModel,
  listAuthorizationModels,
  writeAuthorizationModel,
} from '../storage/authorization-models'
import { validate } from '../middleware/validation'
import { PageSizeQuery, WriteAuthorizationModelBody } from './schemas'
import { formatDslError, isDslContentType } from './_helpers/dsl'

export const modelsRoutes = new Hono()

modelsRoutes.post('/stores/:storeId/authorization-models', async (c) => {
  const storeId = c.req.param('storeId')
  // Store existence is enforced upstream by requireStore middleware.

  let model: Partial<AuthorizationModel>
  if (isDslContentType(c.req.header('content-type'))) {
    // DSL branch — driven by Red Planet's deploy-from-.fga use case.
    // The transformer is the same one src/cli/load-model.ts uses; the
    // resulting JSON feeds the existing JSON path verbatim, so the
    // storage layer never sees DSL.
    let dsl: string
    try {
      dsl = await c.req.text()
    }
    catch {
      return c.json({ code: 'invalid_argument', message: 'failed to read DSL request body' }, 400)
    }
    try {
      model = transformer.transformDSLToJSONObject(dsl) as Partial<AuthorizationModel>
    }
    catch (err) {
      return c.json({ code: 'invalid_argument', message: formatDslError(err) }, 400)
    }
  }
  else {
    const raw = await c.req.json().catch(() => ({}))
    const parsed = WriteAuthorizationModelBody.safeParse(raw)
    if (!parsed.success) {
      return c.json({ code: 'invalid_argument', message: 'request validation failed' }, 400)
    }
    model = parsed.data as Partial<AuthorizationModel>
  }

  if (!Array.isArray(model.type_definitions)) {
    return c.json({ code: 'invalid_argument', message: 'type_definitions required' }, 400)
  }
  try {
    const index = new ModelIndex(model.type_definitions, model.conditions)
    for (const td of model.type_definitions) {
      for (const metadata of Object.values(td.metadata?.relations ?? {})) {
        for (const ref of metadata.directly_related_user_types ?? []) {
          if (ref.condition && !index.conditions.has(ref.condition)) throw new ConditionError(`condition '${ref.condition}' is not defined`)
        }
      }
    }
  }
  catch (err) {
    return c.json({ code: 'invalid_authorization_model', message: err instanceof Error ? err.message : 'invalid model' }, 400)
  }
  const row = await writeAuthorizationModel(storeId, {
    schema_version: model.schema_version ?? '1.1',
    type_definitions: model.type_definitions,
    conditions: model.conditions,
  })
  return c.json({ authorization_model_id: row.id })
})

modelsRoutes.get(
  '/stores/:storeId/authorization-models',
  validate('query', PageSizeQuery),
  async (c) => {
    const storeId = c.req.param('storeId')
    const { page_size } = c.req.valid('query')
    const pageSize = Math.min(page_size ?? 50, 100)
    const rows = await listAuthorizationModels(storeId, pageSize)
    return c.json({
      authorization_models: rows.map(r => ({
        id: r.id,
        schema_version: r.schema_version,
        type_definitions: r.type_definitions,
        conditions: r.conditions ?? undefined,
      })),
      continuation_token: '',
    })
  },
)

modelsRoutes.get('/stores/:storeId/authorization-models/:id', async (c) => {
  const storeId = c.req.param('storeId')
  const id = c.req.param('id')
  const row = await getAuthorizationModel(storeId, id)
  if (!row) return c.json({ code: 'not_found', message: 'model not found' }, 404)
  return c.json({
    authorization_model: {
      id: row.id,
      schema_version: row.schema_version,
      type_definitions: row.type_definitions,
      conditions: row.conditions ?? undefined,
    },
  })
})
