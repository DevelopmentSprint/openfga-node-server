/**
 * Resolution budgets and result limits (openfga-k2a.1).
 *
 * Limits mirror upstream OpenFGA v1.22.0 defaults
 * (pkg/server/config/config.go): resolveNodeLimit 25, requestTimeout 3s,
 * listObjects/listUsers deadline 3s and max results 1000.
 */
import { describe, expect, it } from 'vitest'
import type { TypeDefinition } from '@openfga/sdk'
import { check } from '../../src/evaluator/check'
import { ConditionError } from '../../src/evaluator/conditions'
import {
  CHECK_NODE_BUDGET,
  DeadlineExceededError,
  LIST_OBJECTS_DEADLINE_MS,
  LIST_OBJECTS_MAX_RESULTS,
  LIST_USERS_DEADLINE_MS,
  LIST_USERS_MAX_RESULTS,
  REQUEST_TIMEOUT_MS,
  RESOLVE_NODE_LIMIT,
  ResolutionLimitError,
  ResolutionTooComplexError,
} from '../../src/evaluator/limits'
import { listObjects } from '../../src/evaluator/list-objects'
import { listUsers } from '../../src/evaluator/list-users'
import { ModelIndex } from '../../src/evaluator/model-index'
import { InMemoryTupleStore } from '../../src/evaluator/tuple-store'
import type { TupleStore } from '../../src/evaluator/tuple-store'

const groupTypes: TypeDefinition[] = [
  { type: 'user' },
  {
    type: 'group',
    relations: { member: { this: {} } },
    metadata: { relations: { member: { directly_related_user_types: [{ type: 'user' }, { type: 'group', relation: 'member' }] } } },
  },
]

/** `doc.viewer = [user] or (member from blocker)`: the second branch is deep. */
const unionModel = new ModelIndex([
  ...groupTypes,
  {
    type: 'doc',
    relations: {
      viewer: { union: { child: [{ this: {} }, { computedUserset: { relation: 'deep' } }] } },
      deep: { this: {} },
    },
    metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'user' }] }, deep: { directly_related_user_types: [{ type: 'group', relation: 'member' }] } } },
  },
])

function groupChain(store: InMemoryTupleStore, length: number): void {
  for (let i = 1; i < length; i++) store.add(`group:g${i}`, 'member', `group:g${i - 1}#member`)
}

/** Counts every storage round trip so memoization is observable. */
function countingStore(inner: TupleStore): { store: TupleStore, calls: () => number } {
  let calls = 0
  const store: TupleStore = {
    listTuplesForRelation: async (...args) => { calls++; return inner.listTuplesForRelation!(...args) },
    listUsersForRelation: async (...args) => { calls++; return inner.listUsersForRelation(...args) },
    listObjectIdsForUser: async (...args) => { calls++; return inner.listObjectIdsForUser(...args) },
    listAllForRelation: async (...args) => { calls++; return inner.listAllForRelation(...args) },
  }
  return { store, calls: () => calls }
}

describe('upstream default limits', () => {
  it('uses OpenFGA v1.22.0 defaults as constants', () => {
    expect(RESOLVE_NODE_LIMIT).toBe(25)
    expect(REQUEST_TIMEOUT_MS).toBe(3000)
    expect(LIST_OBJECTS_DEADLINE_MS).toBe(3000)
    expect(LIST_OBJECTS_MAX_RESULTS).toBe(1000)
    expect(LIST_USERS_DEADLINE_MS).toBe(3000)
    expect(LIST_USERS_MAX_RESULTS).toBe(1000)
    expect(CHECK_NODE_BUDGET).toBeGreaterThan(0)
  })

  it('resolution-limit errors are not condition errors', () => {
    expect(new ResolutionTooComplexError()).toBeInstanceOf(ResolutionLimitError)
    expect(new ResolutionTooComplexError()).not.toBeInstanceOf(ConditionError)
    expect(new ResolutionTooComplexError().code).toBe('authorization_model_resolution_too_complex')
    expect(new DeadlineExceededError()).toBeInstanceOf(ResolutionLimitError)
    expect(new DeadlineExceededError().code).toBe('deadline_exceeded')
  })
})

describe('check resolution budget', () => {
  it('raises ResolutionTooComplexError beyond depth 25', async () => {
    const model = new ModelIndex(groupTypes)
    const store = new InMemoryTupleStore()
    store.add('group:g0', 'member', 'user:alice')
    groupChain(store, 30)
    await expect(check(model, store, 'user:alice', 'member', 'group:g29')).rejects.toBeInstanceOf(ResolutionTooComplexError)
    expect(await check(model, store, 'user:alice', 'member', 'group:g10')).toBe(true)
  })

  it('is not swallowed by a union whose other branch is true', async () => {
    const store = new InMemoryTupleStore()
    store.add('doc:1', 'viewer', 'user:bob')
    store.add('doc:1', 'deep', 'group:g29#member')
    groupChain(store, 30)
    // bob is granted directly; the deep branch is only reached for alice.
    expect(await check(unionModel, store, 'user:bob', 'viewer', 'doc:1')).toBe(true)
    await expect(check(unionModel, store, 'user:alice', 'viewer', 'doc:1')).rejects.toBeInstanceOf(ResolutionTooComplexError)
  })

  it('is not swallowed by intersection or exclusion', async () => {
    const model = new ModelIndex([
      ...groupTypes,
      {
        type: 'doc',
        relations: {
          a: { this: {} },
          deep: { this: {} },
          both: { intersection: { child: [{ computedUserset: { relation: 'deep' } }, { computedUserset: { relation: 'a' } }] } },
          except: { difference: { base: { computedUserset: { relation: 'a' } }, subtract: { computedUserset: { relation: 'deep' } } } },
        },
        metadata: { relations: { a: { directly_related_user_types: [{ type: 'user' }] }, deep: { directly_related_user_types: [{ type: 'group', relation: 'member' }] } } },
      },
    ])
    const store = new InMemoryTupleStore()
    store.add('doc:1', 'a', 'user:alice')
    store.add('doc:1', 'deep', 'group:g29#member')
    groupChain(store, 30)
    await expect(check(model, store, 'user:alice', 'both', 'doc:1')).rejects.toBeInstanceOf(ResolutionTooComplexError)
    await expect(check(model, store, 'user:alice', 'except', 'doc:1')).rejects.toBeInstanceOf(ResolutionTooComplexError)
  })

  it('memoizes repeated subproblems within one request', async () => {
    // 24 layers of diamonds: 2^24 paths without memoization.
    const model = new ModelIndex(groupTypes)
    const base = new InMemoryTupleStore()
    base.add('group:l0a', 'member', 'user:nobody')
    base.add('group:l0b', 'member', 'user:nobody')
    for (let i = 1; i <= 24; i++) {
      for (const side of ['a', 'b']) {
        base.add(`group:l${i}${side}`, 'member', `group:l${i - 1}a#member`)
        base.add(`group:l${i}${side}`, 'member', `group:l${i - 1}b#member`)
      }
    }
    const { store, calls } = countingStore(base)
    expect(await check(model, store, 'user:alice', 'member', 'group:l24a')).toBe(false)
    expect(calls()).toBeLessThan(200)
  })

  it('stays correct when a memoized node sits on a cycle', async () => {
    const model = new ModelIndex(groupTypes)
    const store = new InMemoryTupleStore()
    // a -> b -> a cycle; alice is only reachable through c, which b also includes.
    store.add('group:a', 'member', 'group:b#member')
    store.add('group:b', 'member', 'group:a#member')
    store.add('group:b', 'member', 'group:c#member')
    store.add('group:c', 'member', 'user:alice')
    store.add('group:top', 'member', 'group:a#member')
    store.add('group:top', 'member', 'group:b#member')
    for (const g of ['a', 'b', 'c', 'top']) expect(await check(model, store, 'user:alice', 'member', `group:${g}`)).toBe(true)
  })

  it('enforces a per-request node budget', async () => {
    const model = new ModelIndex(groupTypes)
    const store = new InMemoryTupleStore()
    for (let i = 0; i < 20; i++) store.add('group:root', 'member', `group:c${i}#member`)
    await expect(check(model, store, 'user:alice', 'member', 'group:root', {}, { nodeBudget: 5 }))
      .rejects.toBeInstanceOf(ResolutionTooComplexError)
    expect(await check(model, store, 'user:alice', 'member', 'group:root')).toBe(false)
  })

  it('enforces a deadline with DeadlineExceededError', async () => {
    const model = new ModelIndex(groupTypes)
    const store = new InMemoryTupleStore()
    store.add('group:root', 'member', 'group:child#member')
    await expect(check(model, store, 'user:alice', 'member', 'group:root', {}, { deadlineMs: -1 }))
      .rejects.toBeInstanceOf(DeadlineExceededError)
  })
})

describe('list-objects limits', () => {
  const docModel = new ModelIndex([
    { type: 'user' },
    { type: 'doc', relations: { viewer: { this: {} } }, metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'user' }] } } } },
  ])

  it('caps results at maxResults (default 1000)', async () => {
    const store = new InMemoryTupleStore()
    for (let i = 0; i < 1005; i++) store.add(`doc:${i}`, 'viewer', 'user:alice')
    expect(await listObjects(docModel, store, 'user:alice', 'viewer', 'doc')).toHaveLength(1000)
    expect(await listObjects(docModel, store, 'user:alice', 'viewer', 'doc', {}, { maxResults: 3 })).toHaveLength(3)
    expect(await listObjects(docModel, store, 'user:alice', 'viewer', 'doc', {}, { maxResults: 0 })).toHaveLength(1005)
  })

  it('returns partial results instead of failing when the deadline passes', async () => {
    const store = new InMemoryTupleStore()
    store.add('doc:1', 'viewer', 'user:alice')
    expect(await listObjects(docModel, store, 'user:alice', 'viewer', 'doc', {}, { deadlineMs: -1 })).toEqual([])
  })

  it('surfaces resolution-too-complex errors', async () => {
    const model = new ModelIndex([
      ...groupTypes,
      { type: 'doc', relations: { viewer: { this: {} } }, metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'group', relation: 'member' }] } } } },
    ])
    const store = new InMemoryTupleStore()
    store.add('group:g0', 'member', 'user:alice')
    groupChain(store, 30)
    store.add('doc:1', 'viewer', 'group:g29#member')
    await expect(listObjects(model, store, 'user:alice', 'viewer', 'doc')).rejects.toBeInstanceOf(ResolutionTooComplexError)
  })
})

describe('list-users limits', () => {
  const docModel = new ModelIndex([
    { type: 'user' },
    { type: 'doc', relations: { viewer: { this: {} } }, metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'user' }] } } } },
  ])

  it('caps results at maxResults (default 1000)', async () => {
    const store = new InMemoryTupleStore()
    for (let i = 0; i < 1005; i++) store.add('doc:1', 'viewer', `user:u${i}`)
    expect(await listUsers(docModel, store, 'doc', '1', 'viewer', { type: 'user' })).toHaveLength(1000)
    expect(await listUsers(docModel, store, 'doc', '1', 'viewer', { type: 'user' }, {}, { maxResults: 2 })).toHaveLength(2)
  })

  it('returns partial results when the deadline passes', async () => {
    const store = new InMemoryTupleStore()
    store.add('doc:1', 'viewer', 'user:alice')
    expect(await listUsers(docModel, store, 'doc', '1', 'viewer', { type: 'user' }, {}, { deadlineMs: -1 })).toEqual([])
  })

  it('visits each node once in a diamond graph', async () => {
    const model = new ModelIndex(groupTypes)
    const base = new InMemoryTupleStore()
    for (let i = 1; i <= 16; i++) {
      for (const side of ['a', 'b']) {
        base.add(`group:l${i}${side}`, 'member', `group:l${i - 1}a#member`)
        base.add(`group:l${i}${side}`, 'member', `group:l${i - 1}b#member`)
      }
    }
    base.add('group:l0a', 'member', 'user:alice')
    const { store, calls } = countingStore(base)
    const users = await listUsers(model, store, 'group', 'l16a', 'member', { type: 'user' })
    expect(users).toEqual([{ object: { type: 'user', id: 'alice' } }])
    expect(calls()).toBeLessThan(500)
  })
})
