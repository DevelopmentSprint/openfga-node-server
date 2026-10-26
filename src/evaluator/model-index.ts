/**
 * Indexed view over an OpenFGA authorization model.
 *
 * The evaluator looks up `(objectType, relation) → Userset` on every
 * recursive step. Doing the array scan per call would dominate hot-path
 * latency on a deep rewrite tree. We pre-index once at model load.
 *
 * Also exposes the per-type set of `directly_related_user_types` (from
 * relation metadata) so the evaluator can answer wildcard checks like
 * "is `user:*` valid for this relation?" without re-walking the model.
 */
import { Conditions } from './conditions'
import type { Condition } from '@openfga/sdk'
import type { TypeDefinition, Userset, RelationReference } from '@openfga/sdk'

export interface RelationDef {
  /** The rewrite tree for this relation. */
  rewrite: Userset
  /** From metadata.relations.<name>.directly_related_user_types. */
  directlyRelatedUserTypes: RelationReference[]
}

export class ModelIndex {
  /** Map<objectType, Map<relation, RelationDef>>. */
  private byType: Map<string, Map<string, RelationDef>>

  readonly conditions: Conditions

  constructor(typeDefinitions: TypeDefinition[], conditions: Record<string, Condition> = {}) {
    this.conditions = new Conditions(conditions)
    this.byType = new Map()
    for (const td of typeDefinitions) {
      const relations = td.relations ?? {}
      const relMeta = td.metadata?.relations ?? {}
      const m = new Map<string, RelationDef>()
      for (const [relName, rewrite] of Object.entries(relations)) {
        m.set(relName, {
          rewrite,
          directlyRelatedUserTypes: relMeta[relName]?.directly_related_user_types ?? [],
        })
      }
      this.byType.set(td.type, m)
    }
  }

  /** Returns null if the type has no relations of that name. */
  getRelation(objectType: string, relation: string): RelationDef | null {
    return this.byType.get(objectType)?.get(relation) ?? null
  }

  hasType(objectType: string): boolean {
    return this.byType.has(objectType)
  }

  /** Type names defined in the model. */
  getTypes(): string[] {
    return [...this.byType.keys()]
  }
}
