/**
 * Unit tests for the route-level Zod validation boundary.
 *
 * These tests focus on validation rejection paths so they short-circuit
 * before reaching storage and don't need a live database. The acceptance
 * tests for valid-request behavior live alongside each endpoint's
 * existing integration test.
 *
 * Spec: docs/features/request-validation.md
 */
import { describe, expect, it, vi } from 'vitest'

// The requireStore middleware (openfga-rv0) calls getStore() on
// every /stores/:storeId/* request. These tests intentionally
// isolate the validation layer; mock storage so the middleware
// lets requests pass through to the validators.
vi.mock('../../src/storage/stores', () => ({
  getStore: vi.fn().mockResolvedValue({
    id: 'stub',
    name: 'stub',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    deleted_at: null,
  }),
  createStore: vi.fn(),
  listStoresPage: vi.fn(),
}))

const { buildApp } = await import('../../src/routes/index')
const app = buildApp()

function postJson(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function postRaw(path: string, raw: string): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw,
  })
}

async function expectInvalidArgument(res: Response): Promise<void> {
  expect(res.status).toBe(400)
  const body = await res.json() as { code: string, message: string }
  expect(body.code).toBe('invalid_argument')
  expect(typeof body.message).toBe('string')
}

describe('request validation — POST /stores', () => {
  it('rejects empty body (missing name)', async () => {
    await expectInvalidArgument(await app.fetch(postJson('/stores', {})))
  })

  it('rejects empty name', async () => {
    await expectInvalidArgument(await app.fetch(postJson('/stores', { name: '' })))
  })

  it('rejects whitespace-only name', async () => {
    await expectInvalidArgument(await app.fetch(postJson('/stores', { name: '   ' })))
  })

  it('rejects non-string name', async () => {
    await expectInvalidArgument(await app.fetch(postJson('/stores', { name: 42 })))
  })
})

describe('request validation — POST /stores/:storeId/check', () => {
  it('rejects empty body (missing tuple_key)', async () => {
    await expectInvalidArgument(await app.fetch(postJson('/stores/abc/check', {})))
  })

  it('rejects tuple_key with missing fields', async () => {
    await expectInvalidArgument(
      await app.fetch(postJson('/stores/abc/check', { tuple_key: { user: 'user:alice' } })),
    )
  })

  // Regression for openfga-vnl: prior schema accepted any non-empty
  // string for tuple_key.user, so malformed users like 'alice' (no
  // colon) reached the evaluator's parseObject and surfaced as 500
  // Internal Server Error instead of a client-safe 400.
  it('rejects malformed user reference (no colon) at the validation boundary', async () => {
    await expectInvalidArgument(
      await app.fetch(postJson('/stores/abc/check', {
        tuple_key: { user: 'alice', relation: 'viewer', object: 'doc:1' },
      })),
    )
  })

  it('rejects user reference with empty id portion', async () => {
    await expectInvalidArgument(
      await app.fetch(postJson('/stores/abc/check', {
        tuple_key: { user: 'user:', relation: 'viewer', object: 'doc:1' },
      })),
    )
  })

  it('rejects user reference with empty type portion', async () => {
    await expectInvalidArgument(
      await app.fetch(postJson('/stores/abc/check', {
        tuple_key: { user: ':alice', relation: 'viewer', object: 'doc:1' },
      })),
    )
  })

  it('rejects malformed object reference (no colon)', async () => {
    await expectInvalidArgument(
      await app.fetch(postJson('/stores/abc/check', {
        tuple_key: { user: 'user:alice', relation: 'viewer', object: 'missing-colon' },
      })),
    )
  })
})

describe('request validation — POST /stores/:storeId/write', () => {
  it('rejects body with neither writes nor deletes', async () => {
    await expectInvalidArgument(await app.fetch(postJson('/stores/abc/write', {})))
  })

  it('rejects writes with empty tuple_keys array', async () => {
    await expectInvalidArgument(
      await app.fetch(postJson('/stores/abc/write', { writes: { tuple_keys: [] } })),
    )
  })

  it('rejects malformed object reference in deletes', async () => {
    await expectInvalidArgument(
      await app.fetch(postJson('/stores/abc/write', {
        deletes: {
          tuple_keys: [{ user: 'user:alice', relation: 'viewer', object: 'no-colon' }],
        },
      })),
    )
  })

  it('rejects unknown on_duplicate value', async () => {
    await expectInvalidArgument(
      await app.fetch(postJson('/stores/abc/write', {
        writes: {
          tuple_keys: [{ user: 'user:alice', relation: 'viewer', object: 'doc:1' }],
          on_duplicate: 'replace',
        },
      })),
    )
  })
})

describe('request validation — POST /stores/:storeId/read', () => {
  it('rejects malformed object reference', async () => {
    await expectInvalidArgument(
      await app.fetch(postJson('/stores/abc/read', { tuple_key: { object: 'no-colon' } })),
    )
  })

  it('rejects negative page_size', async () => {
    await expectInvalidArgument(
      await app.fetch(postJson('/stores/abc/read', { page_size: -1 })),
    )
  })
})

describe('request validation — POST /stores/:storeId/list-objects', () => {
  it('rejects empty body (missing type, relation, user)', async () => {
    await expectInvalidArgument(await app.fetch(postJson('/stores/abc/list-objects', {})))
  })

  it('rejects body with only some required fields', async () => {
    await expectInvalidArgument(
      await app.fetch(postJson('/stores/abc/list-objects', { type: 'doc', relation: 'viewer' })),
    )
  })

  it('rejects malformed user reference (no colon) at the validation boundary', async () => {
    await expectInvalidArgument(
      await app.fetch(postJson('/stores/abc/list-objects', {
        type: 'doc',
        relation: 'viewer',
        user: 'alice',
      })),
    )
  })
})

describe('request validation — accepted user shapes pass the boundary', () => {
  // These cases exercise USER_REF on /check. Each request fails
  // somewhere downstream of validation (either the route's storeId
  // lookup or the model lookup), but the load-bearing assertion is
  // that none of them is rejected with a 400 invalid_argument from
  // the validation layer. The list covers the three structural
  // shapes (concrete, userset, wildcard) plus OpenFGA-spec example
  // identifiers that contain '/' and '.' — see the openfga-vnl
  // review that flagged the original regex as too tight.
  for (const user of [
    'user:alice',
    'group:eng#member',
    'user:*',
    'repository:auth0/express-jwt',
    'organization:auth0.com#member',
    'user:550e8400-e29b-41d4-a716-446655440000',
  ]) {
    it(`accepts a well-formed user '${user}' at the validation boundary`, async () => {
      const res = await app.fetch(postJson('/stores/abc/check', {
        tuple_key: { user, relation: 'viewer', object: 'doc:1' },
      }))
      expect(res.status).not.toBe(400)
    })
  }
})

describe('request validation — accepted object shapes pass the boundary', () => {
  // OBJECT_REF must accept the same generous id character class as
  // USER_REF for concrete refs. /read also admits the type-only
  // filter `<type>:`. Cases below exercise the route boundary on
  // /read because that endpoint is the one that takes object as a
  // standalone field; the load-bearing assertion is no 400 from
  // validation.
  for (const object of [
    'doc:1',
    'doc:',
    'doc:*',
    'doc:1#viewer',
    'repository:auth0/express-jwt',
    'organization:auth0.com#member',
  ]) {
    it(`accepts a well-formed object '${object}' at the validation boundary`, async () => {
      const res = await app.fetch(postJson('/stores/abc/read', {
        tuple_key: { object, user: 'user:alice' },
      }))
      expect(res.status).not.toBe(400)
    })
  }
})

describe('request validation — malformed JSON', () => {
  it('returns invalid_argument for unparseable JSON body on /stores', async () => {
    await expectInvalidArgument(await app.fetch(postRaw('/stores', '{ this is not json')))
  })
})

describe('request validation — unknown fields are passed through', () => {
  it('accepts forward-compatible OpenFGA fields without rejecting', async () => {
    // contextual_tuples, context, trace, consistency are part of the
    // OpenFGA wire contract that this server allows but does not yet
    // read. They must not be rejected by the validation boundary.
    const res = await app.fetch(postJson('/stores/abc/check', {
      tuple_key: { user: 'user:alice', relation: 'viewer', object: 'doc:1' },
      authorization_model_id: '01M5X4VSFEV23X0B26DAJ26CW2',
      contextual_tuples: { tuple_keys: [] },
      context: { ip: '127.0.0.1' },
      trace: true,
      consistency: 'MINIMIZE_LATENCY',
    }))
    // Validation passes — the request reaches the route handler, which
    // then 404s because the store/model doesn't exist. The test asserts
    // that we did NOT get a 400 invalid_argument from validation.
    expect(res.status).not.toBe(400)
  })
})
