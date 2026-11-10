// Embedding probe: runs NodeFGA's Hono application inside the current Node process (no listening
// socket) against in-memory SQLite, then measures Check latency through app.fetch.
//   OPENFGA_DB_URL=:memory: npx tsx tests/conformance/embed/embed.ts
// What it shows: the app is importable (src/index.ts is side-effect free), migrations can run
// in-process, and requests are served without HTTP. What it does not show: a published package
// surface (package.json is private, the build emits only dist/server.mjs, no types are shipped).
import { runMigrationsToLatest } from '../../../src/storage/migrator'
import app from '../../../src/index'

const call = async (path: string, body?: unknown, method = 'POST') => {
  const res = await app.fetch(new Request(`http://embedded${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }))
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }
}
await runMigrationsToLatest()
const store = (await call('/stores', { name: 'embedded-store' })).body.id as string
const model = await call(`/stores/${store}/authorization-models`, {
  schema_version: '1.1',
  type_definitions: [
    { type: 'user' },
    { type: 'doc', relations: { viewer: { this: {} } }, metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'user' }] } } } },
  ],
})
const writes = Array.from({ length: 100 }, (_, i) => ({ user: `user:u${i}`, relation: 'viewer', object: `doc:d${i}` }))
const w = await call(`/stores/${store}/write`, { writes: { tuple_keys: writes } })
const lat: number[] = []
let allowedCount = 0
for (let i = 0; i < 2000; i++) {
  const t0 = performance.now()
  const r = await call(`/stores/${store}/check`, { tuple_key: { user: `user:u${i % 100}`, relation: 'viewer', object: `doc:d${(i * 7) % 100}` } })
  lat.push(performance.now() - t0)
  if (r.body.allowed) allowedCount++
}
lat.sort((a, b) => a - b)
const p = (q: number) => +lat[Math.min(lat.length - 1, Math.ceil(q * lat.length) - 1)]!.toFixed(3)
console.log(JSON.stringify({ model: model.status, write: w.status, checks: lat.length, allowedCount, p50_ms: p(0.5), p95_ms: p(0.95), p99_ms: p(0.99), backend: process.env.OPENFGA_DB_URL }))
process.exit(0)
