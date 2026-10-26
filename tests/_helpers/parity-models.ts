export const basicModel = () => ({
  schema_version: '1.1', type_definitions: [
    { type: 'user' },
    { type: 'document', relations: { reader: { this: {} } }, metadata: { relations: { reader: { directly_related_user_types: [{ type: 'user' }] } } } },
  ],
})
const direct = { this: {} }
const computed = (relation: string) => ({ computedUserset: { relation } })
const typed = (relations: object, refs: Record<string, object[]>) => ({
  schema_version: '1.1', type_definitions: [{ type: 'user' }, { type: 'document', relations,
    metadata: { relations: Object.fromEntries(Object.entries(refs).map(([name, users]) => [name, { directly_related_user_types: users }])) } }],
})
export const modelCases: Array<{ name: string, valid: boolean, model: unknown }> = [
  { name: 'direct relationship', valid: true, model: basicModel() },
  { name: 'unsupported schema', valid: false, model: { ...basicModel(), schema_version: '9.0' } },
  { name: 'missing schema', valid: false, model: { type_definitions: basicModel().type_definitions } },
  { name: 'empty model', valid: false, model: { schema_version: '1.1', type_definitions: [] } },
  { name: 'duplicate types', valid: false, model: { ...basicModel(), type_definitions: [{ type: 'user' }, { type: 'user' }] } },
  { name: 'reserved type', valid: false, model: { ...basicModel(), type_definitions: [{ type: 'self' }] } },
  { name: 'missing restrictions', valid: false, model: typed({ reader: direct }, {}) },
  { name: 'undefined restriction type', valid: false, model: typed({ reader: direct }, { reader: [{ type: 'missing' }] }) },
  { name: 'undefined restriction relation', valid: false, model: typed({ reader: direct }, { reader: [{ type: 'document', relation: 'missing' }] }) },
  { name: 'prototype property is not a relation', valid: false, model: typed({ reader: computed('toString') }, {}) },
  { name: 'undefined computed relation', valid: false, model: typed({ reader: computed('missing') }, {}) },
  { name: 'direct self alias', valid: false, model: typed({ reader: computed('reader') }, {}) },
  { name: 'indirect alias cycle', valid: false, model: typed({ reader: computed('writer'), writer: computed('reader') }, {}) },
  { name: 'ungrounded userset cycle', valid: false, model: typed({ reader: direct }, { reader: [{ type: 'document', relation: 'reader' }] }) },
  { name: 'grounded userset recursion', valid: true, model: typed({ reader: direct }, { reader: [{ type: 'document', relation: 'reader' }, { type: 'user' }] }) },
  { name: 'computed relation restrictions', valid: false, model: typed({ reader: direct, viewer: computed('reader') }, { reader: [{ type: 'user' }], viewer: [{ type: 'user' }] }) },
  { name: 'empty rewrite', valid: false, model: typed({ reader: {} }, {}) },
  { name: 'multiple rewrite variants', valid: false, model: typed({ reader: { this: {}, computedUserset: { relation: 'writer' } }, writer: direct }, { reader: [{ type: 'user' }], writer: [{ type: 'user' }] }) },
  { name: 'unary union', valid: false, model: typed({ reader: { union: { child: [direct] } } }, { reader: [{ type: 'user' }] }) },
  { name: 'incomplete difference', valid: false, model: typed({ reader: { difference: { base: direct } } }, { reader: [{ type: 'user' }] }) },
  { name: 'undefined tupleset', valid: false, model: typed({ reader: { tupleToUserset: { tupleset: { relation: 'parent' }, computedUserset: { relation: 'reader' } } } }, {}) },
  { name: 'undefined tuple target', valid: false, model: typed({ parent: direct, reader: { tupleToUserset: { tupleset: { relation: 'parent' }, computedUserset: { relation: 'missing' } } } }, { parent: [{ type: 'document' }] }) },
  { name: 'wildcard tupleset restriction', valid: false, model: typed({ parent: direct, reader: direct, viewer: { tupleToUserset: { tupleset: { relation: 'parent' }, computedUserset: { relation: 'reader' } } } }, { reader: [{ type: 'user' }], parent: [{ type: 'document', wildcard: {} }] }) },
  { name: 'grounded parent recursion', valid: true, model: typed({ parent: direct, reader: { union: { child: [direct, { tupleToUserset: { tupleset: { relation: 'parent' }, computedUserset: { relation: 'reader' } } }] } } }, { reader: [{ type: 'user' }], parent: [{ type: 'document' }] }) },
]
