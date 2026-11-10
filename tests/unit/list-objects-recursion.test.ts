/**
 * Regression tests for recursive same-type relations in list-objects
 * (openfga-k2a.1). Candidate discovery used to key its visited set on
 * `type#relation`, so `viewer from parent` on `folder` stopped after
 * the first hop and list-objects disagreed with check.
 *
 * Every scenario asserts that list-objects returns exactly the objects
 * for which check is true.
 */
import { describe, expect, it } from 'vitest'
import type { TypeDefinition } from '@openfga/sdk'
import { check } from '../../src/evaluator/check'
import { listObjects } from '../../src/evaluator/list-objects'
import { listUsers } from '../../src/evaluator/list-users'
import { ModelIndex } from '../../src/evaluator/model-index'
import { InMemoryTupleStore } from '../../src/evaluator/tuple-store'

const folderModel = new ModelIndex([
  { type: 'user' },
  {
    type: 'folder',
    relations: {
      parent: { this: {} },
      viewer: {
        union: {
          child: [
            { this: {} },
            { tupleToUserset: { tupleset: { relation: 'parent' }, computedUserset: { relation: 'viewer' } } },
          ],
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
])

const groupModel = new ModelIndex([
  { type: 'user' },
  {
    type: 'group',
    relations: { member: { this: {} } },
    metadata: { relations: { member: { directly_related_user_types: [{ type: 'user' }, { type: 'group', relation: 'member' }] } } },
  },
  {
    type: 'doc',
    relations: { viewer: { this: {} } },
    metadata: { relations: { viewer: { directly_related_user_types: [{ type: 'group', relation: 'member' }] } } },
  },
] satisfies TypeDefinition[])

async function expectAgreement(model: ModelIndex, store: InMemoryTupleStore, user: string, relation: string, type: string, ids: string[]): Promise<string[]> {
  const listed = (await listObjects(model, store, user, relation, type)).sort()
  for (const id of ids) {
    expect(listed.includes(id), `${type}:${id}`).toBe(await check(model, store, user, relation, `${type}:${id}`))
  }
  return listed
}

describe('list-objects recursion agrees with check', () => {
  it('walks a recursive folder chain of depth >= 3', async () => {
    const store = new InMemoryTupleStore()
    store.add('folder:root', 'viewer', 'user:alice')
    store.add('folder:a', 'parent', 'folder:root')
    store.add('folder:b', 'parent', 'folder:a')
    store.add('folder:c', 'parent', 'folder:b')
    store.add('folder:other', 'parent', 'folder:unrelated')

    const listed = await expectAgreement(folderModel, store, 'user:alice', 'viewer', 'folder', ['root', 'a', 'b', 'c', 'other'])
    expect(listed).toEqual(['a', 'b', 'c', 'root'])
  })

  it('terminates on a cyclic parent graph and returns every member of the cycle', async () => {
    const store = new InMemoryTupleStore()
    store.add('folder:x', 'viewer', 'user:alice')
    store.add('folder:y', 'parent', 'folder:x')
    store.add('folder:z', 'parent', 'folder:y')
    store.add('folder:x', 'parent', 'folder:z')
    store.add('folder:lonely', 'parent', 'folder:lonely')

    const listed = await expectAgreement(folderModel, store, 'user:alice', 'viewer', 'folder', ['x', 'y', 'z', 'lonely'])
    expect(listed).toEqual(['x', 'y', 'z'])
  })

  it('follows nested groups through userset membership', async () => {
    const store = new InMemoryTupleStore()
    store.add('group:inner', 'member', 'user:alice')
    store.add('group:middle', 'member', 'group:inner#member')
    store.add('group:outer', 'member', 'group:middle#member')
    store.add('doc:1', 'viewer', 'group:outer#member')
    store.add('doc:2', 'viewer', 'group:unrelated#member')

    expect(await expectAgreement(groupModel, store, 'user:alice', 'member', 'group', ['inner', 'middle', 'outer', 'unrelated']))
      .toEqual(['inner', 'middle', 'outer'])
    expect(await expectAgreement(groupModel, store, 'user:alice', 'viewer', 'doc', ['1', '2'])).toEqual(['1'])
  })

  it('list-users reaches every ancestor grant in a diamond-shaped folder graph', async () => {
    const store = new InMemoryTupleStore()
    store.add('folder:top', 'viewer', 'user:alice')
    store.add('folder:left', 'parent', 'folder:top')
    store.add('folder:right', 'parent', 'folder:top')
    store.add('folder:right', 'viewer', 'user:bob')
    store.add('folder:leaf', 'parent', 'folder:left')
    store.add('folder:leaf', 'parent', 'folder:right')

    const users = await listUsers(folderModel, store, 'folder', 'leaf', 'viewer', { type: 'user' })
    expect(users?.map(u => u.object?.id).sort()).toEqual(['alice', 'bob'])
  })
})
