// Reproducible local latency benchmark for two OpenFGA-compatible servers on the same machine,
// the same PostgreSQL server and an identical, seeded data set.
//
//   COMPOSE_PROJECT=conf-ev CONF_PG_PASSWORD=... \
//   NODEFGA_URL=... REFERENCE_URL=... \
//   node tests/conformance/bench/bench.mjs --engine nodefga --size 100000 [--no-restart]
//
// Model: organization -> workspace -> project inheritance. Data is generated deterministically from
// the size, so both engines receive exactly the same tuples and the same query sets. Results are
// written to results/bench-<engine>-<size>.json. Timings are measured at the client, so they
// include the loopback hop and Docker port forwarding; they are comparative, not absolute.
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : (process.argv[i + 1]?.startsWith('--') || i + 1 >= process.argv.length ? true : process.argv[i + 1]); };
const engine = arg('engine'); const size = Number(arg('size', 100000)); const restart = !process.argv.includes('--no-restart');
const base = '';
const project = process.env.COMPOSE_PROJECT; const service = engine === 'nodefga' ? 'nodefga' : 'reference';
if (!['nodefga', 'reference'].includes(engine) || !project) throw new Error('--engine nodefga|reference and the matching COMPOSE_PROJECT are required');
let baseUrl = base;

const DSL = `model
  schema 1.1

type user

type organization
  relations
    define admin: [user]
    define member: [user] or admin

type workspace
  relations
    define org: [organization]
    define admin: [user] or admin from org
    define member: [user] or member from org or admin

type project
  relations
    define workspace: [workspace]
    define owner: [user]
    define viewer: [user] or owner or member from workspace
    define editor: [user] or owner or admin from workspace
`;

// ---- deterministic data ---------------------------------------------------------------------
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const PER_ORG = 372; // tuples per organization in the generator below
const ORGS = Math.max(2, Math.round(size / PER_ORG));
function* tuples() {
  const T = (user, relation, object) => ({ user, relation, object });
  for (let i = 0; i < ORGS; i++) {
    for (let k = 0; k < 2; k++) yield T(`user:o${i}a${k}`, 'admin', `organization:org${i}`);
    for (let k = 0; k < 20; k++) yield T(`user:o${i}m${k}`, 'member', `organization:org${i}`);
    for (let j = 0; j < 5; j++) {
      const ws = `workspace:ws${i}-${j}`;
      yield T(`organization:org${i}`, 'org', ws);
      for (let k = 0; k < 3; k++) yield T(`user:o${i}m${(j + k) % 20}`, 'admin', ws);
      for (let k = 0; k < 6; k++) yield T(`user:o${i}m${(j * 3 + k + 5) % 20}`, 'member', ws);
      for (let p = 0; p < 20; p++) {
        const pr = `project:pr${i}-${j}-${p}`;
        yield T(ws, 'workspace', pr);
        yield T(`user:o${i}m${(j * 20 + p) % 20}`, 'owner', pr);
        yield T(`user:o${i}m${(p * 7 + j) % 20}`, 'viewer', pr);
      }
    }
  }
}
function querySets() {
  const r = rng(42);
  const pick = () => { const i = Math.floor(r() * ORGS); const j = Math.floor(r() * 5), p = Math.floor(r() * 20); const same = r() < 0.5; const ui = same ? i : (i + 1 + Math.floor(r() * (ORGS - 1))) % ORGS; return { user: `user:o${ui}m${Math.floor(r() * 20)}`, relation: r() < 0.7 ? 'viewer' : 'editor', object: `project:pr${i}-${j}-${p}` }; };
  const mk = (n) => Array.from({ length: n }, pick);
  return { checkA: mk(500), checkB: mk(500), batches: Array.from({ length: 100 }, () => mk(50)), batchesFresh: Array.from({ length: 100 }, () => mk(50)), lists: Array.from({ length: 50 }, () => `user:o${Math.floor(r() * ORGS)}m${Math.floor(r() * 20)}`), listsFresh: Array.from({ length: 50 }, () => `user:o${Math.floor(r() * ORGS)}m${Math.floor(r() * 20)}`) };
}

// ---- http -----------------------------------------------------------------------------------
async function call(path, body, method = 'POST') {
  const t0 = performance.now();
  const res = await fetch(baseUrl + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { ms: performance.now() - t0, status: res.status, text };
}
const pct = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return +a[Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1))].toFixed(2); };
const stats = (arr, errors = 0) => ({ n: arr.length, errors, p50: pct(arr, 50), p95: pct(arr, 95), p99: pct(arr, 99), max: +Math.max(...arr).toFixed(2), mean: +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) });
async function pool(items, c, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: c }, async () => { for (;;) { const k = i++; if (k >= items.length) return; out[k] = await fn(items[k], k); } })); return out; }
const dockerPort = (svc) => execFileSync('docker', ['compose', '--env-file', '/dev/null', '-p', project, '-f', join(here, '..', 'docker', 'compose.yaml'), 'port', svc, '8080'], { encoding: 'utf8', env: process.env }).trim().replace(/.*:/, '');
async function waitReady() { for (let i = 0; i < 120; i++) { try { const r = await fetch(`${baseUrl}/${engine === 'nodefga' ? 'ready' : 'healthz'}`); if (r.ok) return; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 500)); } throw new Error('not ready'); }
const compose = (...a) => execFileSync('docker', ['compose', '--env-file', '/dev/null', '-p', project, '-f', join(here, '..', 'docker', 'compose.yaml'), ...a], { stdio: 'pipe', env: process.env });

// ---- run ------------------------------------------------------------------------------------
const out = { engine, size, orgs: ORGS, started: new Date().toISOString(), host: { cpu: os.cpus()[0].model, cores: os.cpus().length, mem_gb: Math.round(os.totalmem() / 2 ** 30), loadavg_start: os.loadavg().map((x) => +x.toFixed(1)), node: process.version }, docker: JSON.parse(execFileSync('docker', ['info', '--format', '{{json .}}'], { encoding: 'utf8' })) };
out.docker = { ncpu: out.docker.NCPU, mem_gb: Math.round(out.docker.MemTotal / 2 ** 30), server: out.docker.ServerVersion };
// Published ports change when a container restarts; always resolve the current one.
baseUrl = `http://127.0.0.1:${dockerPort(service)}`;
const { id: storeId } = JSON.parse((await call('/stores', { name: `bench-${size}-${Date.now()}` })).text);
const { transformer } = (await import('node:module')).createRequire(import.meta.url)('@openfga/syntax-transformer');
const mr = await call(`/stores/${storeId}/authorization-models`, transformer.transformDSLToJSONObject(DSL));
if (mr.status !== 201) throw new Error(`model: ${mr.text}`);
const modelId = JSON.parse(mr.text).authorization_model_id;

// load
const batches = []; let cur = []; let total = 0;
for (const t of tuples()) { cur.push(t); total++; if (cur.length === 100) { batches.push(cur); cur = []; } }
if (cur.length) batches.push(cur);
const tLoad = performance.now(); let loadErrors = 0;
await pool(batches, 8, async (b) => { const r = await call(`/stores/${storeId}/write`, { writes: { tuple_keys: b }, authorization_model_id: modelId }); if (r.status !== 200) { loadErrors++; if (loadErrors < 4) console.error('load error', r.status, r.text.slice(0, 200)); } });
out.load = { tuples: total, seconds: +((performance.now() - tLoad) / 1000).toFixed(1), tuples_per_second: Math.round(total / ((performance.now() - tLoad) / 1000)), errors: loadErrors, concurrency: 8, batch: 100 };
console.error(`[${engine} ${size}] loaded ${total} tuples in ${out.load.seconds}s (errors ${loadErrors})`);

if (restart) {
  compose('restart', 'postgres'); for (let i = 0; i < 60; i++) { try { compose('exec', '-T', 'postgres', 'pg_isready', '-U', 'postgres'); break; } catch { await new Promise((r) => setTimeout(r, 1000)); } }
  compose('restart', service); baseUrl = `http://127.0.0.1:${dockerPort(service)}`; await waitReady();
  out.cold_definition = 'PostgreSQL and the engine process restarted immediately before measurement; the Docker VM page cache is not dropped';
} else out.cold_definition = 'no restart requested; "cold" rows are the first pass only';

const Q = querySets();
const checkBody = (q) => ({ tuple_key: q, authorization_model_id: modelId });
const sig = createHash('sha256');
async function seq(items, mk) { const lat = []; let errors = 0; const res = []; for (const it of items) { const r = await mk(it); lat.push(r.ms); if (r.status !== 200) errors++; res.push(r.text); } return { lat, errors, res }; }
const singleCheck = (q) => call(`/stores/${storeId}/check`, checkBody(q));
const batchCheck = (qs) => call(`/stores/${storeId}/batch-check`, { checks: qs.map((q, i) => ({ tuple_key: q, correlation_id: `c${i}` })), authorization_model_id: modelId });
const listObj = (u) => call(`/stores/${storeId}/list-objects`, { type: 'project', relation: 'viewer', user: u, authorization_model_id: modelId });

const r = {};
const cold = await seq(Q.checkA, singleCheck); r.check_cold = stats(cold.lat, cold.errors); r.check_cold_first_request_ms = +cold.lat[0].toFixed(2);
for (const t of cold.res) sig.update(JSON.parse(t).allowed ? '1' : '0');
out.check_allowed_ratio = +(cold.res.filter((t) => JSON.parse(t).allowed).length / cold.res.length).toFixed(2);
out.check_decisions_sha256 = sig.digest('hex');
const rep = []; let repErr = 0; for (let k = 0; k < 3; k++) { const s2 = await seq(Q.checkA, singleCheck); rep.push(...s2.lat); repErr += s2.errors; } r.check_warm_repeat = stats(rep, repErr);
const fresh = await seq(Q.checkB, singleCheck); r.check_warm_fresh = stats(fresh.lat, fresh.errors);
const conc = []; let concErr = 0; const t0c = performance.now(); await pool([...Q.checkA, ...Q.checkB, ...Q.checkA, ...Q.checkB], 8, async (q) => { const x = await singleCheck(q); conc.push(x.ms); if (x.status !== 200) concErr++; }); r.check_warm_concurrency8 = { ...stats(conc, concErr), throughput_rps: Math.round(conc.length / ((performance.now() - t0c) / 1000)) };

const bcold = await seq(Q.batches, batchCheck); r.batch50_cold = stats(bcold.lat, bcold.errors); r.batch50_cold_first_request_ms = +bcold.lat[0].toFixed(2);
const bsig = createHash('sha256'); for (const t of bcold.res) { const j = JSON.parse(t).result ?? {}; bsig.update(Object.keys(j).sort().map((k) => (j[k].allowed ? '1' : '0')).join('')); } out.batch_decisions_sha256 = bsig.digest('hex');
const brep = []; let brepErr = 0; for (let k = 0; k < 3; k++) { const s2 = await seq(Q.batches, batchCheck); brep.push(...s2.lat); brepErr += s2.errors; } r.batch50_warm_repeat = stats(brep, brepErr);
const bfresh = await seq(Q.batchesFresh, batchCheck); r.batch50_warm_fresh = stats(bfresh.lat, bfresh.errors);

const lcold = await seq(Q.lists, listObj); r.list_objects_first_pass = stats(lcold.lat, lcold.errors);
const lsizes = lcold.res.map((t) => (JSON.parse(t).objects ?? []).length); out.list_objects_result_size = { min: Math.min(...lsizes), max: Math.max(...lsizes), mean: +(lsizes.reduce((a, b) => a + b, 0) / lsizes.length).toFixed(1) };
const lrep = []; for (let k = 0; k < 3; k++) { const s2 = await seq(Q.lists, listObj); lrep.push(...s2.lat); } r.list_objects_warm_repeat = stats(lrep);
const lfresh = await seq(Q.listsFresh, listObj); r.list_objects_warm_fresh = stats(lfresh.lat, lfresh.errors);
out.latency_ms = r;
out.finished = new Date().toISOString(); out.host.loadavg_end = os.loadavg().map((x) => +x.toFixed(1));
mkdirSync(join(here, '..', 'results'), { recursive: true });
writeFileSync(join(here, '..', 'results', `bench-${engine}-${size}.json`), JSON.stringify(out, null, 1));
console.log(JSON.stringify({ engine, size, load: out.load, ...r }, null, 1));
