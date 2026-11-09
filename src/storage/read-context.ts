/** Request-local tuple read policy; never shared between concurrent requests. */
export interface ReadContext {
  readonly consistency: 'MINIMIZE_LATENCY' | 'HIGHER_CONSISTENCY'
}

export function readContext(
  consistency?: 'UNSPECIFIED' | ReadContext['consistency'] | null,
): ReadContext {
  return { consistency: consistency === 'HIGHER_CONSISTENCY' ? consistency : 'MINIMIZE_LATENCY' }
}

/**
 * Adapter contract (Postgres and SQLite): every tuple read goes directly to
 * the authoritative database. Neither adapter uses a query cache or replica,
 * so both preferences observe committed writes today. This does not promise a
 * single snapshot across the multiple reads of an evaluation. Future adapters
 * or caches must preserve HIGHER_CONSISTENCY's authoritative read path.
 */
export const DEFAULT_READ_CONTEXT: ReadContext = Object.freeze(readContext())
