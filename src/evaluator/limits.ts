/**
 * Evaluation resource limits.
 *
 * Values mirror upstream OpenFGA v1.22.0 defaults
 * (pkg/server/config/config.go). They are constants, not configuration:
 * no config key exposes them.
 *
 * Resolution-limit errors are deliberately NOT `ConditionError`s. The
 * union / intersection / exclusion algebra treats condition errors as
 * values (true OR error = true), but an exhausted budget means the
 * answer is unknown, so it must abort the whole request.
 */

/** DefaultResolveNodeLimit: maximum resolution depth. */
export const RESOLVE_NODE_LIMIT = 25
/** DefaultRequestTimeout: Check deadline. */
export const REQUEST_TIMEOUT_MS = 3000
/** DefaultListObjectsDeadline. */
export const LIST_OBJECTS_DEADLINE_MS = 3000
/** DefaultListObjectsMaxResults (non-streaming ListObjects only). */
export const LIST_OBJECTS_MAX_RESULTS = 1000
/** DefaultListUsersDeadline. */
export const LIST_USERS_DEADLINE_MS = 3000
/** DefaultListUsersMaxResults. */
export const LIST_USERS_MAX_RESULTS = 1000
/**
 * Non-memoized node expansions allowed in one top-level Check. Upstream
 * has no equivalent knob (it bounds work with concurrency limits and the
 * request timeout); this is a local CPU backstop for in-memory overlays.
 */
export const CHECK_NODE_BUDGET = 100_000

export abstract class ResolutionLimitError extends Error {
  abstract readonly code: string
}

/** Upstream ErrAuthorizationModelResolutionTooComplex (HTTP 400). */
export class ResolutionTooComplexError extends ResolutionLimitError {
  readonly code = 'authorization_model_resolution_too_complex'
  constructor() {
    super('Authorization Model resolution required too many rewrite rules to be resolved. Check your authorization model for infinite recursion or too much nesting')
  }
}

/** Upstream ErrRequestDeadlineExceeded (InternalErrorCode, HTTP 500). */
export class DeadlineExceededError extends ResolutionLimitError {
  readonly code = 'deadline_exceeded'
  constructor() {
    super('Request Deadline Exceeded')
  }
}

export interface LimitOverrides {
  /** Milliseconds from the call until the deadline. */
  deadlineMs?: number
  /** Non-memoized node expansions per top-level Check. */
  nodeBudget?: number
  /** Result cap for list operations; 0 means unlimited. */
  maxResults?: number
}

/** Absolute wall-clock deadline shared by every step of one request. */
export class Deadline {
  private readonly at: number
  constructor(ms: number) { this.at = Date.now() + ms }
  check(): void {
    if (Date.now() > this.at) throw new DeadlineExceededError()
  }
}
