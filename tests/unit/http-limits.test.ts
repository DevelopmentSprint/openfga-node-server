/**
 * Unit tests for HTTP request limits and validation hardening
 * (openfga-k2a.2): body size cap, /write batch cap, /read page_size
 * cap, store name length, model id path param, JSON 404 fallback.
 */
import { describe, expect, it, vi } from 'vitest'

const getStore = vi.fn().mockResolvedValue({
  id: 'stub',
  name: 'stub',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  deleted_at: null,
})

vi.mock('../../src/storage/stores', () => ({
  getStore,
  createStore: vi.fn(),
  listStoresPage: vi.fn(),
}))

const { buildApp } = await import('../../src/routes/index')
const app = buildApp()

const tuple = (i: number) => ({ user: `user:u${i}`, relation: 'viewer', object: `doc:d${i}` })
const tuples = (n: number) => Array.from({ length: n }, (_, i) => tuple(i))

function postJson(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function envelope(res: Response): Promise<{ code: string, message: string }> {
  expect(res.headers.get('content-type')).toContain('application/json')
  return await res.json() as { code: string, message: string }
}

describe('body size limit', () => {
  const oversized = JSON.stringify({ name: 'x'.repeat(1024 * 1024 + 1) })

  it('rejects an oversized body with 413 and the JSON envelope (content-length)', async () => {
    getStore.mockClear()
    const res = await app.fetch(new Request('http://localhost/stores/abc/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: oversized,
    }))
    expect(res.status).toBe(413)
    const body = await envelope(res)
    expect(body.code).toBe('payload_too_large')
    // Rejected before the store guard / validation ran.
    expect(getStore).not.toHaveBeenCalled()
  })

  it('rejects an oversized streamed body that carries no content-length', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new Uint8Array(512 * 1024).fill(97)
        controller.enqueue(chunk)
        controller.enqueue(chunk)
        controller.enqueue(chunk)
        controller.close()
      },
    })
    const res = await app.fetch(new Request('http://localhost/stores', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stream,
      duplex: 'half',
    }))
    expect(res.status).toBe(413)
    expect((await envelope(res)).code).toBe('payload_too_large')
  })

  it('accepts a body at the limit boundary region (small bodies unaffected)', async () => {
    const res = await app.fetch(postJson('/stores/abc/write', {}))
    expect(res.status).toBe(400)
  })
})

describe('POST /stores/:storeId/write tuple cap', () => {
  it('rejects writes+deletes combined above 100 with 400 exceeded_entity_limit', async () => {
    const res = await app.fetch(postJson('/stores/abc/write', {
      writes: { tuple_keys: tuples(60) },
      deletes: { tuple_keys: tuples(41) },
    }))
    expect(res.status).toBe(400)
    expect((await envelope(res)).code).toBe('exceeded_entity_limit')
  })

  it('rejects a single oversized writes list', async () => {
    const res = await app.fetch(postJson('/stores/abc/write', { writes: { tuple_keys: tuples(101) } }))
    expect(res.status).toBe(400)
    expect((await envelope(res)).code).toBe('exceeded_entity_limit')
  })

  it('rejects a single oversized deletes list', async () => {
    const res = await app.fetch(postJson('/stores/abc/write', { deletes: { tuple_keys: tuples(101) } }))
    expect(res.status).toBe(400)
    expect((await envelope(res)).code).toBe('exceeded_entity_limit')
  })
})

describe('POST /stores/:storeId/read page_size cap', () => {
  it('rejects page_size above 100', async () => {
    const res = await app.fetch(postJson('/stores/abc/read', { page_size: 101 }))
    expect(res.status).toBe(400)
    expect((await envelope(res)).code).toBe('invalid_argument')
  })

  it('rejects absurd page_size', async () => {
    const res = await app.fetch(postJson('/stores/abc/read', { page_size: 2_000_000_000 }))
    expect(res.status).toBe(400)
  })
})

describe('POST /stores name length', () => {
  it('rejects a name longer than 64 characters', async () => {
    const res = await app.fetch(postJson('/stores', { name: 'n'.repeat(65) }))
    expect(res.status).toBe(400)
    expect((await envelope(res)).code).toBe('invalid_argument')
  })
})

describe('GET /stores/:storeId/authorization-models/:id', () => {
  it('rejects a malformed model id with 400 invalid_argument', async () => {
    const res = await app.fetch(new Request('http://localhost/stores/abc/authorization-models/not-a-ulid'))
    expect(res.status).toBe(400)
    expect((await envelope(res)).code).toBe('invalid_argument')
  })
})

describe('unmatched routes', () => {
  it('returns the JSON envelope 404 under /stores/*', async () => {
    const res = await app.fetch(new Request('http://localhost/stores/abc/no-such-thing'))
    expect(res.status).toBe(404)
    expect((await envelope(res)).code).toBe('undefined_endpoint')
  })

  it('returns the JSON envelope 404 for an unknown method on a known store path', async () => {
    const res = await app.fetch(new Request('http://localhost/stores/abc/check', { method: 'GET' }))
    expect(res.status).toBe(404)
    expect((await envelope(res)).code).toBe('undefined_endpoint')
  })
})
