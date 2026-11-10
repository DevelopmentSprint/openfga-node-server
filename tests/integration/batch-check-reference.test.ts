// Focused wire comparisons against the pinned OpenFGA v1.22.0 reference.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/routes/index'
import { createStore } from '../../src/storage/stores'
import { writeAuthorizationModel } from '../../src/storage/authorization-models'
import { bootstrapIntegrationDb } from '../_helpers/integration-bootstrap'

const reference = process.env['OPENFGA_REFERENCE_URL']
const bootstrap = await bootstrapIntegrationDb()
afterAll(() => bootstrap.teardown())
const tuple_key = { user: 'user:alice', relation: 'viewer', object: 'doc:1' }
const item = (correlation_id: string) => ({ tuple_key, correlation_id })
const checks = (count: number) => Array.from({ length: count }, (_, i) => item(`c_${i}`))
const cases = [
  { name: 'underscore', checks: [item('check_1')] },
  { name: 'prototype key', checks: [item('__proto__'), item('constructor'), item('toString')] },
  { name: 'maximum ID length', checks: [item('a'.repeat(36))] },
  { name: 'empty ID', checks: [item('')] },
  { name: 'oversize ID', checks: [item('a'.repeat(37))] },
  { name: 'space in ID', checks: [item('bad space')] },
  { name: 'trailing newline in ID', checks: [item('bad\n')] },
  { name: 'unicode ID', checks: [item('é')] },
  { name: 'duplicate IDs', checks: [item('duplicate'), item('duplicate')] },
  { name: 'empty batch', checks: [] },
  { name: 'oversize batch', checks: checks(51) },
  { name: 'limit before duplicate validation', checks: Array.from({ length: 51 }, () => item('same')) },
  { name: '50 results with an item error', checks: [
    ...checks(49), { tuple_key: { ...tuple_key, relation: 'missing' }, correlation_id: 'error' },
  ] },
  { name: 'unknown type item error', checks: [{ tuple_key: { ...tuple_key, object: 'missing:1' }, correlation_id: 'error' }] },
]

describe.skipIf(!reference || !bootstrap.ready)('BatchCheck wire contract against pinned reference', () => {
  const app = buildApp()
  let localPath: string
  let remotePath: string

  beforeAll(async () => {
    const model = {
      schema_version: '1.1', type_definitions: [
        { type: 'user' },
        { type: 'doc', relations: { viewer: { this: {} } }, metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'user' }] } } } },
      ],
    }
    const local = await createStore('batch-reference')
    await writeAuthorizationModel(local.id, model)
    localPath = `/stores/${local.id}/batch-check`
    const created = await fetch(`${reference}/stores`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'batch-reference' }),
    })
    expect(created.status).toBe(201)
    const remote = await created.json() as { id: string }
    const written = await fetch(`${reference}/stores/${remote.id}/authorization-models`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(model),
    })
    expect(written.status).toBe(201)
    remotePath = `/stores/${remote.id}/batch-check`
  })

  it.each(cases)('$name', async ({ checks }) => {
    const request = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ checks }) }
    const [local, remote] = await Promise.all([app.request(localPath, request), fetch(`${reference}${remotePath}`, request)])
    expect(local.status).toBe(remote.status)
    expect(await local.json()).toEqual(await remote.json())
  })
})
