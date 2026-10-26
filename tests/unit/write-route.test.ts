import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TypeDefinition } from '@openfga/sdk'
import { ModelIndex } from '../../src/evaluator/model-index'

const applyTupleMutations = vi.fn()
const loadModelIndex = vi.fn()

vi.mock('../../src/storage/stores', () => ({
  createStore: vi.fn(),
  getStore: vi.fn(),
}))

vi.mock('../../src/storage/authorization-models', () => ({
  getAuthorizationModel: vi.fn(),
  listAuthorizationModels: vi.fn(),
  writeAuthorizationModel: vi.fn(),
}))

vi.mock('../../src/storage/tuples', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/tuples')>()
  return {
    ...actual,
    applyTupleMutations,
    readTuples: vi.fn(),
    writeTuples: vi.fn(),
    deleteTuples: vi.fn(),
  }
})

vi.mock('../../src/storage/engine-context', () => ({
  loadModelIndex,
  pgTupleStore: vi.fn(),
}))

const { DuplicateTupleError } = await import('../../src/storage/tuples')
const { buildApp } = await import('../../src/routes/index')

const userType: TypeDefinition = { type: 'user' }
const modelIndex = new ModelIndex([
  userType,
  {
    type: 'doc',
    relations: { viewer: { this: {} } },
    metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'user' }] } } },
  },
])

function writeRequest(body: unknown): Request {
  return new Request('http://localhost/stores/store-1/write', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('write route', () => {
  beforeEach(async () => {
    applyTupleMutations.mockReset()
    loadModelIndex.mockReset()
    loadModelIndex.mockResolvedValue({ modelId: '01M5X4VSFEV23X0B26DAJ26CW2', index: modelIndex })
    // requireStore middleware (openfga-rv0) calls getStore on every
    // /stores/:storeId/* request. Default to a non-null stub so the
    // existing happy-path tests don't 404 at the middleware.
    const { getStore } = await import('../../src/storage/stores')
    vi.mocked(getStore).mockResolvedValue({
      id: 'store-1',
      name: 'store-1',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      deleted_at: null,
    })
    delete process.env['OPENFGA_AUTH_MODE']
    delete process.env['OPENFGA_IDEMPOTENCY_MODE']
  })

  it('loads the requested authorization model and rejects tuple keys outside the model', async () => {
    const app = buildApp()

    const res = await app.fetch(writeRequest({
      authorization_model_id: '01M5X4VSFEV23X0B26DAJ26CW2',
      writes: {
        tuple_keys: [{ user: 'user:alice', relation: 'editor', object: 'doc:1' }],
      },
    }))

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      code: 'invalid_argument',
      message: 'relation "editor" is not defined for type "doc"',
    })
    expect(loadModelIndex).toHaveBeenCalledWith('store-1', '01M5X4VSFEV23X0B26DAJ26CW2')
    expect(applyTupleMutations).not.toHaveBeenCalled()
  })

  it('returns not found when the requested authorization model is missing', async () => {
    loadModelIndex.mockResolvedValueOnce(null)
    const app = buildApp()

    const res = await app.fetch(writeRequest({
      authorization_model_id: '01M5X4VSFEV23X0B26DAJ26CW3',
      writes: {
        tuple_keys: [{ user: 'user:alice', relation: 'viewer', object: 'doc:1' }],
      },
    }))

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ code: 'not_found', message: 'authorization model not found' })
    expect(applyTupleMutations).not.toHaveBeenCalled()
  })

  it('rejects malformed delete tuple keys before storage mutation', async () => {
    const app = buildApp()

    const res = await app.fetch(writeRequest({
      deletes: {
        tuple_keys: [{ user: 'user:alice', relation: 'viewer', object: 'missing-colon' }],
      },
    }))

    expect(res.status).toBe(400)
    // The Zod validator rejects malformed object refs at the request
    // boundary before storage. The exact error text is implementation
    // detail; the public contract is the OpenFGA invalid_argument
    // envelope plus the guarantee that storage was not invoked.
    const body = await res.json() as { code: string }
    expect(body.code).toBe('invalid_argument')
    expect(applyTupleMutations).not.toHaveBeenCalled()
  })

  it('does not require authorization model lookup for delete-only requests without a model id', async () => {
    const app = buildApp()

    const res = await app.fetch(writeRequest({
      deletes: {
        tuple_keys: [{ user: 'user:alice', relation: 'viewer', object: 'doc:1' }],
        on_missing: 'ignore',
      },
    }))

    expect(res.status).toBe(200)
    expect(loadModelIndex).not.toHaveBeenCalled()
    expect(applyTupleMutations).toHaveBeenCalledWith('store-1', {
      writes: [],
      deletes: [{ user: 'user:alice', relation: 'viewer', object: 'doc:1' }],
      onDuplicate: 'error',
      onMissing: 'ignore',
    })
  })

  it('passes conflict options to the transactional tuple mutation boundary', async () => {
    const app = buildApp()

    const res = await app.fetch(writeRequest({
      writes: {
        tuple_keys: [{ user: 'user:alice', relation: 'viewer', object: 'doc:1' }],
        on_duplicate: 'ignore',
      },
      deletes: {
        tuple_keys: [{ user: 'user:bob', relation: 'viewer', object: 'doc:2' }],
        on_missing: 'ignore',
      },
    }))

    expect(res.status).toBe(200)
    expect(applyTupleMutations).toHaveBeenCalledWith('store-1', {
      writes: [{ user: 'user:alice', relation: 'viewer', object: 'doc:1' }],
      deletes: [{ user: 'user:bob', relation: 'viewer', object: 'doc:2' }],
      onDuplicate: 'ignore',
      onMissing: 'ignore',
    })
  })

  it('maps duplicate tuple conflicts to a conflict response', async () => {
    applyTupleMutations.mockRejectedValueOnce(
      new DuplicateTupleError({ user: 'user:alice', relation: 'viewer', object: 'doc:1' }),
    )
    const app = buildApp()

    const res = await app.fetch(writeRequest({
      writes: {
        tuple_keys: [{ user: 'user:alice', relation: 'viewer', object: 'doc:1' }],
      },
    }))

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      code: 'write_failed_due_to_invalid_input',
      message: 'tuple already exists: user:alice viewer doc:1',
    })
  })
})
