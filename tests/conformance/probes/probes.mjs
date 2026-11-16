// Side-by-side capability probes against two OpenFGA-compatible servers with identical inputs.
//   NODEFGA_URL=http://... REFERENCE_URL=http://... node tests/conformance/probes/probes.mjs [probeId ...]
// Output: tests/conformance/results/probes.json (observations per engine, agreement flag).
// Each probe records observed behaviour (status, error code, decision/result summary); it does not
// assert. Where the two engines differ the `agree` flag is false and the diff is in the output.
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const { transformer } = require('@openfga/syntax-transformer');
const { OpenFgaClient } = require('@openfga/sdk');
const here = dirname(fileURLToPath(import.meta.url));

const engines = [
  { name: 'nodefga', base: process.env.NODEFGA_URL },
  { name: 'reference', base: process.env.REFERENCE_URL },
];
for (const e of engines) if (!e.base) throw new Error(`${e.name.toUpperCase()}_URL is required`);

// ---- helpers -------------------------------------------------------------------------------
async function call(base, method, path, body) {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, body: json };
}
const sum = (r, ...pick) => ({ status: r.status, ...(r.body.code ? { code: r.body.code } : {}), ...Object.fromEntries(pick.filter((k) => k in r.body).map((k) => [k, r.body[k]])) });
async function store(b) { return (await call(b, 'POST', '/stores', { name: `probe-${Math.random().toString(36).slice(2, 8)}` })).body.id; }
async function model(b, s, jsonOrDsl) {
  const m = typeof jsonOrDsl === 'string' ? transformer.transformDSLToJSONObject(jsonOrDsl) : jsonOrDsl;
  const r = await call(b, 'POST', `/stores/${s}/authorization-models`, m);
  if (r.status !== 201) throw new Error(`model write failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.authorization_model_id;
}
const modelTry = async (b, s, jsonOrDsl) => {
  const m = typeof jsonOrDsl === 'string' ? transformer.transformDSLToJSONObject(jsonOrDsl) : jsonOrDsl;
  return call(b, 'POST', `/stores/${s}/authorization-models`, m);
};
const w = (b, s, writes = [], deletes = [], extra = {}) => call(b, 'POST', `/stores/${s}/write`, { ...(writes.length ? { writes: { tuple_keys: writes } } : {}), ...(deletes.length ? { deletes: { tuple_keys: deletes } } : {}), ...extra });
const check = (b, s, t, extra = {}) => call(b, 'POST', `/stores/${s}/check`, { tuple_key: t, ...extra });
const lo = (b, s, body) => call(b, 'POST', `/stores/${s}/list-objects`, body);
const T = (user, relation, object, condition) => ({ user, relation, object, ...(condition ? { condition } : {}) });
const sorted = (a) => [...(a ?? [])].sort();
const allowed = (r) => (r.status === 200 ? r.body.allowed : `${r.status}:${r.body.code}`);

// ---- probes --------------------------------------------------------------------------------
const probes = {};

probes.a_modular_models = {
  title: 'Modular models: two modules in one store, a module referencing a type owned by another, extend type',
  async run(b) {
    const files = [
      { name: 'core.fga', contents: 'module core\n\ntype user\n\ntype organization\n  relations\n    define member: [user]\n' },
      { name: 'docs.fga', contents: 'module docs\n\nextend type organization\n  relations\n    define can_view_docs: member\n\ntype document\n  relations\n    define parent: [organization]\n    define viewer: [user] or can_view_docs from parent\n' },
    ];
    const composed = transformer.transformModuleFilesToModel(files, '1.2');
    const s = await store(b); const out = {};
    const wm = await modelTry(b, s, composed); out.write_composed_1_2 = sum(wm);
    if (wm.status !== 201) return out;
    const id = wm.body.authorization_model_id;
    out.tuples = (await w(b, s, [T('user:anne', 'member', 'organization:acme'), T('organization:acme', 'parent', 'document:d1')])).status;
    out.check_via_extension = allowed(await check(b, s, T('user:anne', 'viewer', 'document:d1'), { authorization_model_id: id }));
    out.check_negative = allowed(await check(b, s, T('user:bob', 'viewer', 'document:d1'), { authorization_model_id: id }));
    out.list_objects = sorted((await lo(b, s, { type: 'document', relation: 'viewer', user: 'user:anne', authorization_model_id: id })).body.objects);
    const got = await call(b, 'GET', `/stores/${s}/authorization-models/${id}`);
    const m = got.body.authorization_model ?? {};
    const doc = (m.type_definitions ?? []).find((t) => t.type === 'document');
    const org = (m.type_definitions ?? []).find((t) => t.type === 'organization');
    out.read_back = { schema_version: m.schema_version, document_module: doc?.metadata?.module ?? null, document_source_file: doc?.metadata?.source_info?.file ?? null, org_extension_relation_module: org?.metadata?.relations?.can_view_docs?.module ?? null };
    // Same content as schema 1.1 without module metadata (what a client that flattens would send).
    const flat = JSON.parse(JSON.stringify(composed)); flat.schema_version = '1.1';
    const strip = (o) => { if (o && typeof o === 'object') { delete o.module; delete o.source_info; Object.values(o).forEach(strip); } };
    strip(flat);
    out.write_flattened_1_1 = sum(await modelTry(b, (await store(b)), flat));
    return out;
  },
};

const CEL_MODEL = `model
  schema 1.1

type user

type workspace
  relations
    define member: [user with valid_until]
    define premium: [user with valid_map]

condition valid_until(current_time: timestamp, expires_at: timestamp) {
  current_time < expires_at
}

condition valid_map(facts: map<string>, expires_at: timestamp) {
  timestamp(facts.now) < expires_at && facts.tier == "gold"
}
`;
probes.b_cel_conditions = {
  title: 'CEL conditions: timestamp comparison with request-supplied facts, map parameter, stored/request context merge',
  async run(b) {
    const s = await store(b); const out = {};
    out.model = (await modelTry(b, s, CEL_MODEL)).status;
    const exp = '2030-01-01T00:00:00Z';
    out.tuples = (await w(b, s, [
      T('user:anne', 'member', 'workspace:w1', { name: 'valid_until', context: { expires_at: exp } }),
      T('user:bob', 'premium', 'workspace:w1', { name: 'valid_map', context: { expires_at: exp } }),
      T('user:cy', 'member', 'workspace:w1', { name: 'valid_until', context: { expires_at: exp, current_time: '2020-01-01T00:00:00Z' } }),
    ])).status;
    const run = async (u, rel, ctx) => allowed(await check(b, s, T(u, rel, 'workspace:w1'), ctx === undefined ? {} : { context: ctx }));
    out.before_expiry = await run('user:anne', 'member', { current_time: '2029-12-31T23:59:59Z' });
    out.after_expiry = await run('user:anne', 'member', { current_time: '2030-01-01T00:00:01Z' });
    out.at_expiry_boundary = await run('user:anne', 'member', { current_time: exp });
    out.missing_request_context = await run('user:anne', 'member');
    out.bad_timestamp_literal = await run('user:anne', 'member', { current_time: 'not-a-time' });
    out.map_gold_before = await run('user:bob', 'premium', { facts: { now: '2029-01-01T00:00:00Z', tier: 'gold' } });
    out.map_wrong_tier = await run('user:bob', 'premium', { facts: { now: '2029-01-01T00:00:00Z', tier: 'silver' } });
    out.map_after = await run('user:bob', 'premium', { facts: { now: '2031-01-01T00:00:00Z', tier: 'gold' } });
    out.map_missing_key = await run('user:bob', 'premium', { facts: { tier: 'gold' } });
    out.stored_context_wins_over_request = await run('user:cy', 'member', { current_time: '2029-01-01T00:00:00Z' });
    const l = await lo(b, s, { type: 'workspace', relation: 'member', user: 'user:anne', context: { current_time: '2029-01-01T00:00:00Z' } });
    out.list_objects_valid = l.status === 200 ? sorted(l.body.objects) : sum(l);
    const l2 = await lo(b, s, { type: 'workspace', relation: 'member', user: 'user:anne', context: { current_time: '2031-01-01T00:00:00Z' } });
    out.list_objects_expired = l2.status === 200 ? sorted(l2.body.objects) : sum(l2);
    const lu = await call(b, 'POST', `/stores/${s}/list-users`, { object: { type: 'workspace', id: 'w1' }, relation: 'member', user_filters: [{ type: 'user' }], context: { current_time: '2029-01-01T00:00:00Z' } });
    out.list_users_valid = lu.status === 200 ? sorted((lu.body.users ?? []).map((u) => u.object?.id)) : sum(lu);
    const bc = await call(b, 'POST', `/stores/${s}/batch-check`, { checks: [
      { tuple_key: T('user:anne', 'member', 'workspace:w1'), context: { current_time: '2029-01-01T00:00:00Z' }, correlation_id: 'a' },
      { tuple_key: T('user:anne', 'member', 'workspace:w1'), context: { current_time: '2031-01-01T00:00:00Z' }, correlation_id: 'b' },
    ] });
    out.batch_check = bc.status === 200 ? Object.fromEntries(Object.entries(bc.body.result ?? {}).sort(([x], [y]) => x.localeCompare(y)).map(([k, v]) => [k, v.allowed ?? v.error?.code])) : sum(bc);
    return out;
  },
};

const GRANT_MODEL = `model
  schema 1.1

type user

type tenant
  relations
    define administrator: [user with tenant_grant]
    define direct_member: [user with tenant_grant]
    define member: administrator or direct_member

type project
  relations
    define tenant: [tenant]
    define maintainer: [user with project_grant]
    define viewer: [user with project_grant]
    define administrator: administrator from tenant
    define can_view: administrator or maintainer or viewer
    define can_edit: administrator or maintainer

condition tenant_grant(grant_version: string, effective_grants: map<bool>, membership_active: bool, tenant_active: bool, current_time: timestamp, expires_at: timestamp) {
  grant_version in effective_grants && effective_grants[grant_version] && membership_active && tenant_active && current_time < expires_at
}

condition project_grant(grant_version: string, effective_grants: map<bool>, membership_active: bool, tenant_active: bool, current_time: timestamp, expires_at: timestamp, project_active: bool) {
  grant_version in effective_grants && effective_grants[grant_version] && membership_active && tenant_active && current_time < expires_at && project_active
}
`;
probes.b2_grant_shape = {
  title: 'CEL grant shape: map<bool> lookup (`in` and index), timestamp expiry, facts in request context, HIGHER_CONSISTENCY',
  async run(b) {
    const s = await store(b); const out = {};
    out.model = sum(await modelTry(b, s, GRANT_MODEL));
    const cond = (name, extra = {}) => ({ name, context: { grant_version: 'g1', membership_active: true, expires_at: '2030-01-01T00:00:00Z', ...extra } });
    out.tuples = (await w(b, s, [
      T('user:alice', 'administrator', 'tenant:t1', cond('tenant_grant')),
      T('user:bob', 'maintainer', 'project:p1', cond('project_grant', { grant_version: 'g2' })),
      T('tenant:t1', 'tenant', 'project:p1'),
    ])).status;
    const ctx = (o = {}) => ({ effective_grants: { g1: true, g2: true }, current_time: '2029-06-01T00:00:00Z', tenant_active: true, project_active: true, ...o });
    const run = async (u, rel, o, extra = {}) => allowed(await check(b, s, T(u, rel, 'project:p1'), { context: ctx(o), consistency: 'HIGHER_CONSISTENCY', ...extra }));
    out.admin_via_tenant_edge = await run('user:alice', 'can_view');
    out.maintainer_can_edit = await run('user:bob', 'can_edit');
    out.revoked_grant_version = await run('user:alice', 'can_view', { effective_grants: { g1: false, g2: true } });
    out.grant_version_absent_from_map = await run('user:alice', 'can_view', { effective_grants: { g2: true } });
    out.expired = await run('user:alice', 'can_view', { current_time: '2031-01-01T00:00:00Z' });
    out.tenant_inactive = await run('user:alice', 'can_view', { tenant_active: false });
    out.project_inactive_blocks_project_grant = await run('user:bob', 'can_view', { project_active: false });
    out.project_inactive_does_not_block_tenant_path = await run('user:alice', 'can_view', { project_active: false });
    out.missing_context_key = await run('user:alice', 'can_view', { tenant_active: undefined });
    out.wrong_type_for_map_value = await run('user:alice', 'can_view', { effective_grants: { g1: 'yes' } });
    const l = await lo(b, s, { type: 'project', relation: 'can_view', user: 'user:alice', context: ctx(), consistency: 'HIGHER_CONSISTENCY' });
    out.list_objects = l.status === 200 ? sorted(l.body.objects) : sum(l);
    const lx = await lo(b, s, { type: 'project', relation: 'can_view', user: 'user:alice', context: ctx({ current_time: '2031-01-01T00:00:00Z' }) });
    out.list_objects_expired = lx.status === 200 ? sorted(lx.body.objects) : sum(lx);
    const bc = await call(b, 'POST', `/stores/${s}/batch-check`, { consistency: 'HIGHER_CONSISTENCY', checks: [
      { tuple_key: T('user:alice', 'can_view', 'project:p1'), context: ctx(), correlation_id: 'ok' },
      { tuple_key: T('user:alice', 'can_view', 'project:p1'), context: ctx({ current_time: '2031-01-01T00:00:00Z' }), correlation_id: 'expired' },
      { tuple_key: T('user:bob', 'can_edit', 'project:p1'), context: ctx({ effective_grants: { g1: true } }), correlation_id: 'revoked' },
    ] });
    out.batch_check = bc.status === 200 ? Object.fromEntries(Object.entries(bc.body.result ?? {}).sort(([x], [y]) => x.localeCompare(y)).map(([k, v]) => [k, v.allowed ?? `err:${v.error?.code ?? JSON.stringify(v.error)}`])) : sum(bc);
    return out;
  },
};

const PLAIN = `model
  schema 1.1
type user
type team
  relations
    define member: [user]
type doc
  relations
    define viewer: [user, team#member]
`;
probes.c_contextual_tuples = {
  title: 'Contextual tuples on Check and ListObjects (grant, override of stored, validation, 100-tuple limit)',
  async run(b) {
    const s = await store(b); const out = {}; await model(b, s, PLAIN);
    await w(b, s, [T('user:anne', 'viewer', 'doc:stored')]);
    const ct = (...t) => ({ contextual_tuples: { tuple_keys: t } });
    out.check_without = allowed(await check(b, s, T('user:bob', 'viewer', 'doc:1')));
    out.check_with_direct = allowed(await check(b, s, T('user:bob', 'viewer', 'doc:1'), ct(T('user:bob', 'viewer', 'doc:1'))));
    out.check_with_userset = allowed(await check(b, s, T('user:bob', 'viewer', 'doc:1'), ct(T('user:bob', 'member', 'team:t'), T('team:t#member', 'viewer', 'doc:1'))));
    out.check_not_persisted = allowed(await check(b, s, T('user:bob', 'viewer', 'doc:1')));
    out.check_stored_still_visible = allowed(await check(b, s, T('user:anne', 'viewer', 'doc:stored'), ct(T('user:zed', 'viewer', 'doc:other'))));
    out.check_invalid_relation = sum(await check(b, s, T('user:bob', 'viewer', 'doc:1'), ct(T('user:bob', 'owner', 'doc:1'))));
    out.check_invalid_type = sum(await check(b, s, T('user:bob', 'viewer', 'doc:1'), ct(T('user:bob', 'viewer', 'nope:1'))));
    out.check_duplicate_in_request = sum(await check(b, s, T('user:bob', 'viewer', 'doc:1'), ct(T('user:bob', 'viewer', 'doc:1'), T('user:bob', 'viewer', 'doc:1'))));
    const lw = await lo(b, s, { type: 'doc', relation: 'viewer', user: 'user:bob', ...ct(T('user:bob', 'viewer', 'doc:a'), T('user:bob', 'viewer', 'doc:b')) });
    out.list_objects_with = lw.status === 200 ? sorted(lw.body.objects) : sum(lw);
    out.list_objects_without = sorted((await lo(b, s, { type: 'doc', relation: 'viewer', user: 'user:bob' })).body.objects);
    const many = Array.from({ length: 101 }, (_, i) => T('user:bob', 'viewer', `doc:c${i}`));
    out.check_101_contextual = sum(await check(b, s, T('user:bob', 'viewer', 'doc:c0'), ct(...many)));
    out.check_100_contextual = allowed(await check(b, s, T('user:bob', 'viewer', 'doc:c0'), ct(...many.slice(0, 100))));
    return out;
  },
};

probes.d_read_changes = {
  title: 'ReadChanges: ordering, pagination, continuation tokens, filter, and tailing under concurrent writes',
  async run(b) {
    const s = await store(b); const out = {}; await model(b, s, PLAIN);
    const WRITERS = 8, PER = 40, TOTAL = WRITERS * PER;
    let running = true; const seen = []; let token = '';
    const reader = (async () => {
      let idle = 0;
      while (running || idle < 3) {
        const r = await call(b, 'GET', `/stores/${s}/changes?page_size=7${token ? `&continuation_token=${encodeURIComponent(token)}` : ''}`);
        if (r.status !== 200) { out.reader_error = sum(r); break; }
        for (const c of r.body.changes ?? []) seen.push(`${c.tuple_key.user}|${c.tuple_key.object}|${c.operation}`);
        if (r.body.continuation_token) token = r.body.continuation_token;
        if (!(r.body.changes ?? []).length) { idle++; await new Promise((r2) => setTimeout(r2, 20)); } else idle = 0;
      }
    })();
    await Promise.all(Array.from({ length: WRITERS }, async (_, wi) => { for (let i = 0; i < PER; i++) await w(b, s, [T(`user:u${wi}`, 'viewer', `doc:w${wi}-${i}`)]); }));
    running = false; await reader;
    const full = []; let t2 = ''; let pages = 0; const sizes = [];
    for (;;) {
      const r = await call(b, 'GET', `/stores/${s}/changes?page_size=50${t2 ? `&continuation_token=${encodeURIComponent(t2)}` : ''}`);
      pages++; const ch = r.body.changes ?? []; sizes.push(ch.length);
      for (const c of ch) full.push({ k: `${c.tuple_key.user}|${c.tuple_key.object}|${c.operation}`, ts: c.timestamp });
      if (!ch.length || !r.body.continuation_token) break; t2 = r.body.continuation_token;
    }
    const fullKeys = full.map((c) => c.k);
    out.total_written = TOTAL;
    out.full_read_count = fullKeys.length;
    out.full_read_unique = new Set(fullKeys).size;
    out.tailing_reader_seen = seen.length;
    out.tailing_reader_unique = new Set(seen).size;
    out.tailing_missed_vs_full = fullKeys.filter((k) => !new Set(seen).has(k)).length;
    out.tailing_duplicates = seen.length - new Set(seen).size;
    out.tailing_order_equals_full_order = JSON.stringify(seen) === JSON.stringify(fullKeys);
    out.full_read_timestamps_nondecreasing = full.every((c, i) => i === 0 || new Date(c.ts) >= new Date(full[i - 1].ts));
    out.full_read_page_sizes_head = sizes.slice(0, 3);
    // per-writer order preserved?
    const byWriter = {}; for (const k of fullKeys) { const m = k.match(/^user:u(\d+)\|doc:w\d+-(\d+)\|/); if (m) (byWriter[m[1]] ??= []).push(+m[2]); }
    out.per_writer_order_preserved = Object.values(byWriter).every((a) => a.every((v, i) => i === 0 || v > a[i - 1]));
    const tail = await call(b, 'GET', `/stores/${s}/changes?page_size=5&continuation_token=${encodeURIComponent(token)}`);
    out.empty_page_after_tail = { status: tail.status, count: (tail.body.changes ?? []).length, token_returned: !!tail.body.continuation_token };
    await w(b, s, [T('user:late', 'viewer', 'doc:late')]);
    const after = await call(b, 'GET', `/stores/${s}/changes?page_size=5&continuation_token=${encodeURIComponent(tail.body.continuation_token || token)}`);
    out.token_resumes_with_new_write = { status: after.status, keys: (after.body.changes ?? []).map((c) => c.tuple_key.object) };
    out.bad_token = sum(await call(b, 'GET', `/stores/${s}/changes?continuation_token=garbage`));
    out.page_size_0 = sum(await call(b, 'GET', `/stores/${s}/changes?page_size=0`));
    out.page_size_101 = sum(await call(b, 'GET', `/stores/${s}/changes?page_size=101`));
    out.page_size_1000 = sum(await call(b, 'GET', `/stores/${s}/changes?page_size=1000`));
    out.type_filter_other = { status: (await call(b, 'GET', `/stores/${s}/changes?type=team`)).status, count: ((await call(b, 'GET', `/stores/${s}/changes?type=team`)).body.changes ?? []).length };
    out.type_filter_doc_count = ((await call(b, 'GET', `/stores/${s}/changes?type=doc&page_size=100`)).body.changes ?? []).length;
    await w(b, s, [], [T('user:late', 'viewer', 'doc:late')]);
    const del = await call(b, 'GET', `/stores/${s}/changes?page_size=100&continuation_token=${encodeURIComponent(after.body.continuation_token ?? '')}`);
    out.delete_recorded_as = del.status === 200 ? (del.body.changes ?? []).map((c) => c.operation) : sum(del);
    const tokMismatch = await call(b, 'GET', `/stores/${s}/changes?type=team&continuation_token=${encodeURIComponent(after.body.continuation_token ?? '')}`);
    out.token_with_different_type_filter = sum(tokMismatch);
    return out;
  },
};

probes.e_consistency = {
  title: 'Consistency option on Check, BatchCheck, ListObjects, ListUsers, Read, Expand',
  async run(b) {
    const s = await store(b); const out = {}; await model(b, s, PLAIN);
    await w(b, s, [T('user:anne', 'viewer', 'doc:1')]);
    for (const v of ['UNSPECIFIED', 'MINIMIZE_LATENCY', 'HIGHER_CONSISTENCY', 'BOGUS']) {
      out[`check_${v}`] = allowed(await check(b, s, T('user:anne', 'viewer', 'doc:1'), { consistency: v }));
      const bc = await call(b, 'POST', `/stores/${s}/batch-check`, { consistency: v, checks: [{ tuple_key: T('user:anne', 'viewer', 'doc:1'), correlation_id: 'x' }] });
      out[`batch_${v}`] = bc.status === 200 ? bc.body.result?.x?.allowed : sum(bc);
      const l = await lo(b, s, { type: 'doc', relation: 'viewer', user: 'user:anne', consistency: v });
      out[`listobjects_${v}`] = l.status === 200 ? sorted(l.body.objects) : sum(l);
      const lu = await call(b, 'POST', `/stores/${s}/list-users`, { object: { type: 'doc', id: '1' }, relation: 'viewer', user_filters: [{ type: 'user' }], consistency: v });
      out[`listusers_${v}`] = lu.status === 200 ? (lu.body.users ?? []).length : sum(lu);
      const rd = await call(b, 'POST', `/stores/${s}/read`, { tuple_key: { object: 'doc:1' }, consistency: v });
      out[`read_${v}`] = rd.status === 200 ? (rd.body.tuples ?? []).length : sum(rd);
      const ex = await call(b, 'POST', `/stores/${s}/expand`, { tuple_key: { object: 'doc:1', relation: 'viewer' }, consistency: v });
      out[`expand_${v}`] = ex.status === 200 ? 'ok' : sum(ex);
    }
    // read-your-write immediately after a write, both preferences
    for (const v of ['MINIMIZE_LATENCY', 'HIGHER_CONSISTENCY']) {
      await w(b, s, [T('user:ryw', 'viewer', `doc:${v}`)]);
      out[`read_your_write_${v}`] = allowed(await check(b, s, T('user:ryw', 'viewer', `doc:${v}`), { consistency: v }));
    }
    return out;
  },
};

probes.f_write_semantics = {
  title: 'Write idempotency: duplicate and missing-tuple errors, ignore options, as an SDK retry sees them',
  async run(b) {
    const s = await store(b); const out = {}; await model(b, s, PLAIN);
    const t1 = T('user:anne', 'viewer', 'doc:1');
    out.first_write = sum(await w(b, s, [t1]));
    out.duplicate_write = sum(await w(b, s, [t1]));
    out.duplicate_write_ignore = sum(await w(b, s, [t1], [], { writes: { tuple_keys: [t1], on_duplicate: 'ignore' } }));
    out.delete_missing = sum(await w(b, s, [], [T('user:ghost', 'viewer', 'doc:1')]));
    out.delete_missing_ignore = sum(await call(b, 'POST', `/stores/${s}/write`, { deletes: { tuple_keys: [T('user:ghost', 'viewer', 'doc:1')], on_missing: 'ignore' } }));
    out.duplicate_inside_one_request = sum(await w(b, s, [T('user:b', 'viewer', 'doc:2'), T('user:b', 'viewer', 'doc:2')]));
    out.same_tuple_write_and_delete_same_request = sum(await w(b, s, [T('user:c', 'viewer', 'doc:3')], [T('user:c', 'viewer', 'doc:3')]));
    out.atomic_rollback = { status: (await w(b, s, [T('user:d', 'viewer', 'doc:4'), t1])).status, d_written: (await call(b, 'POST', `/stores/${s}/read`, { tuple_key: { user: 'user:d', object: 'doc:4' } })).body.tuples?.length ?? 0 };
    out.empty_write = sum(await call(b, 'POST', `/stores/${s}/write`, {}));
    out.invalid_model_id = sum(await w(b, s, [T('user:e', 'viewer', 'doc:5')], [], { authorization_model_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }));
    out.unknown_type = sum(await w(b, s, [T('user:e', 'viewer', 'nope:5')]));
    out.over_100_tuples = sum(await w(b, s, Array.from({ length: 101 }, (_, i) => T('user:f', 'viewer', `doc:o${i}`))));
    // SDK behaviour on the same inputs
    const sdk = new OpenFgaClient({ apiUrl: b, storeId: s });
    const run = async (fn) => { try { const r = await fn(); return { ok: true, result: r && typeof r === 'object' ? Object.keys(r).sort() : r }; } catch (e) { return { ok: false, name: e.constructor?.name, status: e.statusCode, code: e.apiErrorCode ?? e.responseData?.code }; } };
    out.sdk_write_new = await run(() => sdk.write({ writes: [T('user:g', 'viewer', 'doc:6')] }));
    out.sdk_write_retry_default = await run(() => sdk.write({ writes: [T('user:g', 'viewer', 'doc:6')] }));
    out.sdk_write_retry_ignore = await run(() => sdk.write({ writes: [T('user:g', 'viewer', 'doc:6')] }, { conflict: { onDuplicateWrites: 'ignore' } }));
    out.sdk_delete_missing_default = await run(() => sdk.write({ deletes: [T('user:g', 'viewer', 'doc:nope')] }));
    out.sdk_delete_missing_ignore = await run(() => sdk.write({ deletes: [T('user:g', 'viewer', 'doc:nope')] }, { conflict: { onMissingDeletes: 'ignore' } }));
    return out;
  },
};

probes.g_model_pinning = {
  title: 'Authorization-model pinning by id versus latest',
  async run(b) {
    const s = await store(b); const out = {};
    const m1 = await model(b, s, `model\n  schema 1.1\ntype user\ntype doc\n  relations\n    define viewer: [user]\n    define editor: [user]\n`);
    await w(b, s, [T('user:anne', 'editor', 'doc:1')]);
    const m2 = await model(b, s, `model\n  schema 1.1\ntype user\ntype doc\n  relations\n    define viewer: [user] or editor\n    define editor: [user]\n`);
    out.ids_differ_and_ordered = m1 !== m2 && m1 < m2;
    out.latest_sees_editor_as_viewer = allowed(await check(b, s, T('user:anne', 'viewer', 'doc:1')));
    out.pinned_m1_does_not = allowed(await check(b, s, T('user:anne', 'viewer', 'doc:1'), { authorization_model_id: m1 }));
    out.pinned_m2 = allowed(await check(b, s, T('user:anne', 'viewer', 'doc:1'), { authorization_model_id: m2 }));
    out.unknown_model_id = sum(await check(b, s, T('user:anne', 'viewer', 'doc:1'), { authorization_model_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }));
    out.malformed_model_id = sum(await check(b, s, T('user:anne', 'viewer', 'doc:1'), { authorization_model_id: 'not-an-id' }));
    out.listobjects_pinned_m1 = sorted((await lo(b, s, { type: 'doc', relation: 'viewer', user: 'user:anne', authorization_model_id: m1 })).body.objects);
    out.listobjects_latest = sorted((await lo(b, s, { type: 'doc', relation: 'viewer', user: 'user:anne' })).body.objects);
    const latest = await call(b, 'GET', `/stores/${s}/authorization-models?page_size=1`);
    out.list_models_latest_first = latest.body.authorization_models?.[0]?.id === m2;
    out.get_model_m1 = (await call(b, 'GET', `/stores/${s}/authorization-models/${m1}`)).status;
    out.get_model_unknown = sum(await call(b, 'GET', `/stores/${s}/authorization-models/01ARZ3NDEKTSV4RRFFQ69G5FAV`));
    const empty = await store(b);
    out.no_model_check = sum(await check(b, empty, T('user:anne', 'viewer', 'doc:1')));
    out.no_model_list_objects = sum(await lo(b, empty, { type: 'doc', relation: 'viewer', user: 'user:anne' }));
    // identical model content written twice
    const m3 = await model(b, s, `model\n  schema 1.1\ntype user\ntype doc\n  relations\n    define viewer: [user] or editor\n    define editor: [user]\n`);
    out.same_content_new_id = m3 !== m2;
    return out;
  },
};

probes.h_list_objects_limits = {
  title: 'ListObjects result limits and deadlines (server defaults)',
  async run(b) {
    const s = await store(b); const out = {}; await model(b, s, PLAIN);
    const N = 1500;
    for (let i = 0; i < N; i += 100) await w(b, s, Array.from({ length: 100 }, (_, j) => T('user:anne', 'viewer', `doc:o${i + j}`)));
    const r = await lo(b, s, { type: 'doc', relation: 'viewer', user: 'user:anne' });
    out.objects_written = N;
    out.list_objects_returned = r.status === 200 ? r.body.objects.length : sum(r);
    out.list_objects_unique = r.status === 200 ? new Set(r.body.objects).size : null;
    const sres = await fetch(`${b}/stores/${s}/streamed-list-objects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'doc', relation: 'viewer', user: 'user:anne' }) });
    const text = await sres.text();
    out.streamed_status = sres.status;
    out.streamed_returned = text.split('\n').filter((l) => l.includes('"object"')).length;
    const t0 = performance.now(); await lo(b, s, { type: 'doc', relation: 'viewer', user: 'user:anne' }); out.list_objects_ms_for_N = Math.round(performance.now() - t0);
    out.note_deadline = 'default deadline is configurable only on the reference (3s); see the deadline probe in the write-up';
    return out;
  },
};

// Reference-only observation of the ListObjects deadline (the reference is started with a 1 ms
// deadline via the `reference-limits` compose service). NodeFGA exposes no such setting.
async function deadlineObservation(base) {
  const s = await store(base); await model(base, s, PLAIN);
  for (let i = 0; i < 1500; i += 100) await w(base, s, Array.from({ length: 100 }, (_, j) => T('user:anne', 'viewer', `doc:o${i + j}`)));
  const r = await lo(base, s, { type: 'doc', relation: 'viewer', user: 'user:anne' });
  const st = await fetch(`${base}/stores/${s}/streamed-list-objects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'doc', relation: 'viewer', user: 'user:anne' }) });
  const text = await st.text();
  return { list_objects: r.status === 200 ? { status: 200, returned: r.body.objects.length } : sum(r), streamed: { status: st.status, objects: text.split('\n').filter((l) => l.includes('"object"')).length, error_line: text.split('\n').find((l) => l.includes('error'))?.slice(0, 160) ?? null } };
}

// ---- runner --------------------------------------------------------------------------------
const norm = (v) => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'string' ? x.replace(/\b[0-9A-HJKMNP-TV-Z]{26}\b/g, '<ulid>') : x)));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const only = process.argv.slice(2);
const results = {};
for (const [id, p] of Object.entries(probes)) {
  if (only.length && !only.some((o) => id.startsWith(o))) continue;
  const per = {};
  for (const e of engines) {
    try { per[e.name] = norm(await p.run(e.base)); } catch (err) { per[e.name] = { probe_error: String(err.message ?? err).slice(0, 300) }; }
  }
  const diffs = {};
  for (const k of new Set([...Object.keys(per.nodefga), ...Object.keys(per.reference)])) if (!eq(per.nodefga[k], per.reference[k])) diffs[k] = { nodefga: per.nodefga[k], reference: per.reference[k] };
  results[id] = { title: p.title, agree: Object.keys(diffs).length === 0, diffs, nodefga: per.nodefga, reference: per.reference };
  console.log(`${id}: ${results[id].agree ? 'AGREE' : `${Object.keys(diffs).length} difference(s)`}`);
}
if (process.env.REFERENCE_SHORT_URL && (!only.length || only.includes('h'))) {
  results.h2_list_objects_deadline_reference_1ms = { title: 'ListObjects deadline behaviour (reference started with a 1 ms deadline; NodeFGA has no deadline setting)', reference: await deadlineObservation(process.env.REFERENCE_SHORT_URL) };
}
mkdirSync(join(here, '..', 'results'), { recursive: true });
writeFileSync(join(here, '..', 'results', only.length ? `probes-${only.join('-')}.json` : 'probes.json'), JSON.stringify(results, null, 1));
