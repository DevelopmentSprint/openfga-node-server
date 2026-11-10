/**
 * Unit tests for OpenFGA `contextual_tuples` handling on /check and
 * /list-objects.
 *
 * These tests exercise the `unionTupleStore` overlay directly against
 * the evaluator's `check()` and `listObjects()` functions, using
 * `InMemoryTupleStore` for both the persisted base and the contextual
 * overlay so no DB is required.
 *
 * Spec: openfga-omp acceptance — direct, userset, and tupleToUserset
 * contextual behavior. Wildcard included for completeness.
 */
import { describe, expect, it } from 'vitest'
import type { AuthorizationModel } from '@openfga/sdk'
import { InMemoryTupleStore, unionTupleStore } from '../../src/evaluator/tuple-store'
import { ModelIndex } from '../../src/evaluator/model-index'
import { check } from '../../src/evaluator/check'
import { listObjects } from '../../src/evaluator/list-objects'
import { withContextualTuples } from '../../src/routes/_helpers/contextual-tuples'

function modelIndex(model: AuthorizationModel): ModelIndex {
  return new ModelIndex(model.type_definitions ?? [])
}

const directModel: AuthorizationModel = {
  id: '01-direct',
  schema_version: '1.1',
  type_definitions: [
    { type: 'user' },
    {
      type: 'doc',
      relations: { viewer: { this: {} } },
      metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'user' }, { type: 'user', wildcard: {} }] } } },
    },
  ],
}

const usersetModel: AuthorizationModel = {
  id: '02-userset',
  schema_version: '1.1',
  type_definitions: [
    { type: 'user' },
    {
      type: 'group',
      relations: { member: { this: {} } },
      metadata: { relations: { member: { directly_related_user_types: [{ type: 'user' }] } } },
    },
    {
      type: 'doc',
      relations: { viewer: { this: {} } },
      metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'group', relation: 'member' }] } } },
    },
  ],
}

const tupleToUsersetModel: AuthorizationModel = {
  id: '03-ttu',
  schema_version: '1.1',
  type_definitions: [
    { type: 'user' },
    {
      type: 'folder',
      relations: { viewer: { this: {} } },
      metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'user' }] } } },
    },
    {
      type: 'doc',
      relations: {
        parent: { this: {} },
        viewer: {
          tupleToUserset: {
            tupleset: { object: '', relation: 'parent' },
            computedUserset: { object: '', relation: 'viewer' },
          },
        },
      },
      metadata: {
        relations: {
          parent: { directly_related_user_types: [{ type: 'folder' }] },
          viewer: { directly_related_user_types: [{ type: 'user' }] },
        },
      },
    },
  ],
}

describe('unionTupleStore', () => {
  it('unions listUsersForRelation results across base and overlay (deduped)', async () => {
    const base = new InMemoryTupleStore()
    base.add('doc:1', 'viewer', 'user:alice')
    const overlay = new InMemoryTupleStore()
    overlay.add('doc:1', 'viewer', 'user:bob')
    overlay.add('doc:1', 'viewer', 'user:alice')

    const merged = unionTupleStore(base, overlay)
    const users = (await merged.listUsersForRelation('doc', '1', 'viewer')).sort()
    expect(users).toEqual(['user:alice', 'user:bob'])
  })

  it('unions listObjectIdsForUser results across base and overlay (deduped)', async () => {
    const base = new InMemoryTupleStore()
    base.add('doc:1', 'viewer', 'user:alice')
    const overlay = new InMemoryTupleStore()
    overlay.add('doc:2', 'viewer', 'user:alice')
    overlay.add('doc:1', 'viewer', 'user:alice')

    const merged = unionTupleStore(base, overlay)
    const ids = (await merged.listObjectIdsForUser('doc', 'viewer', 'user:alice')).sort()
    expect(ids).toEqual(['1', '2'])
  })

  it('unions listAllForRelation results across base and overlay (deduped by object_id+user_str)', async () => {
    const base = new InMemoryTupleStore()
    base.add('doc:1', 'viewer', 'user:alice')
    const overlay = new InMemoryTupleStore()
    overlay.add('doc:1', 'viewer', 'user:alice')
    overlay.add('doc:2', 'viewer', 'user:bob')

    const merged = unionTupleStore(base, overlay)
    const all = await merged.listAllForRelation('doc', 'viewer')
    expect(all).toHaveLength(2)
    expect(all).toContainEqual({ object_id: '1', user_str: 'user:alice' })
    expect(all).toContainEqual({ object_id: '2', user_str: 'user:bob' })
  })
})

describe('check with contextual tuples', () => {
  it('returns true when a direct grant comes only from the contextual overlay', async () => {
    const base = new InMemoryTupleStore()
    const overlay = new InMemoryTupleStore()
    overlay.add('doc:1', 'viewer', 'user:alice')

    const allowed = await check(
      modelIndex(directModel),
      unionTupleStore(base, overlay),
      'user:alice',
      'viewer',
      'doc:1',
    )
    expect(allowed).toBe(true)
  })

  it('returns true via a userset grant whose membership lives only in contextual tuples', async () => {
    const base = new InMemoryTupleStore()
    base.add('doc:1', 'viewer', 'group:eng#member')
    const overlay = new InMemoryTupleStore()
    overlay.add('group:eng', 'member', 'user:alice')

    const allowed = await check(
      modelIndex(usersetModel),
      unionTupleStore(base, overlay),
      'user:alice',
      'viewer',
      'doc:1',
    )
    expect(allowed).toBe(true)
  })

  it('returns true via tupleToUserset when the parent link comes from contextual tuples', async () => {
    const base = new InMemoryTupleStore()
    base.add('folder:f1', 'viewer', 'user:alice')
    const overlay = new InMemoryTupleStore()
    overlay.add('doc:1', 'parent', 'folder:f1')

    const allowed = await check(
      modelIndex(tupleToUsersetModel),
      unionTupleStore(base, overlay),
      'user:alice',
      'viewer',
      'doc:1',
    )
    expect(allowed).toBe(true)
  })

  it('returns true via a typed wildcard contextual tuple', async () => {
    const base = new InMemoryTupleStore()
    const overlay = new InMemoryTupleStore()
    overlay.add('doc:1', 'viewer', 'user:*')

    const allowed = await check(
      modelIndex(directModel),
      unionTupleStore(base, overlay),
      'user:alice',
      'viewer',
      'doc:1',
    )
    expect(allowed).toBe(true)
  })
})

describe('list-objects with contextual tuples', () => {
  it('includes object ids whose grants come only from contextual tuples', async () => {
    const base = new InMemoryTupleStore()
    base.add('doc:1', 'viewer', 'user:alice')
    const overlay = new InMemoryTupleStore()
    overlay.add('doc:2', 'viewer', 'user:alice')

    const ids = (await listObjects(
      modelIndex(directModel),
      unionTupleStore(base, overlay),
      'user:alice',
      'viewer',
      'doc',
    )).sort()
    expect(ids).toEqual(['1', '2'])
  })

  it('uses contextual userset memberships during candidate gathering', async () => {
    const base = new InMemoryTupleStore()
    base.add('doc:1', 'viewer', 'group:eng#member')
    base.add('doc:2', 'viewer', 'group:other#member')
    const overlay = new InMemoryTupleStore()
    overlay.add('group:eng', 'member', 'user:alice')

    const ids = await listObjects(
      modelIndex(usersetModel),
      unionTupleStore(base, overlay),
      'user:alice',
      'viewer',
      'doc',
    )
    expect(ids).toEqual(['1'])
  })
})

describe('duplicate contextual tuples (openfga-k2a.15)', () => {
  const condModel = new ModelIndex([
    { type: 'user' },
    {
      type: 'doc',
      relations: { viewer: { this: {} } },
      metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'user', condition: 'gate' }] } } },
    },
  ], {
    gate: { name: 'gate', expression: 'allowed == true', parameters: { allowed: { type_name: 'TYPE_NAME_BOOL' as never } } },
  })
  const allow = { name: 'gate', context: { allowed: true } }
  const deny = { name: 'gate', context: { allowed: false } }

  it('keeps the FIRST duplicate when conditions differ (allow first)', async () => {
    const store = withContextualTuples(new InMemoryTupleStore(), [
      { user: 'user:alice', relation: 'viewer', object: 'doc:1', condition: allow },
      { user: 'user:alice', relation: 'viewer', object: 'doc:1', condition: deny },
    ])
    expect(await check(condModel, store, 'user:alice', 'viewer', 'doc:1')).toBe(true)
  })

  it('keeps the FIRST duplicate when conditions differ (deny first)', async () => {
    const store = withContextualTuples(new InMemoryTupleStore(), [
      { user: 'user:alice', relation: 'viewer', object: 'doc:1', condition: deny },
      { user: 'user:alice', relation: 'viewer', object: 'doc:1', condition: allow },
    ])
    expect(await check(condModel, store, 'user:alice', 'viewer', 'doc:1')).toBe(false)
  })
})
