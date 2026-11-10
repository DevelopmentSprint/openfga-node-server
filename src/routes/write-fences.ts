/**
 * Optional durable write-fence extension (docs/features/write-fences.md).
 * Mounted only when `config.writeFences.enabled` is true; otherwise the
 * HTTP surface is identical to upstream OpenFGA.
 *
 *   PUT /x-ext/stores/:storeId/write-fences/:key   acquire a generation
 *
 * plus the `writeFencePreflight` middleware on POST /stores/:storeId/write,
 * which parses X-Write-Fence-Key / X-Write-Fence-Generation / X-Not-After,
 * rejects malformed headers, expired deadlines and non-current
 * generations BEFORE idempotent replay, and hands the parsed context to
 * the write handler. The write transaction validates the fence again
 * under its lock.
 */
import { Hono, type MiddlewareHandler } from 'hono'
import { z } from 'zod'
import { validate } from '../middleware/validation'
import { acquireWriteFence, precheckWriteFence, type WriteDeadline, type WriteFence } from '../storage/write-fences'

/** Path prefix for non-upstream extension endpoints. */
export const EXTENSION_PREFIX = '/x-ext'

export interface WriteContext {
  deadline?: WriteDeadline
  fence?: WriteFence
}

declare module 'hono' {
  interface ContextVariableMap {
    writeContext: WriteContext
  }
}

const MAX_GENERATION = 9223372036854775807n

export const FenceKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
const CANONICAL_GENERATION = /^[1-9][0-9]{0,18}$/
// One refinement: zod runs later checks even after a failed regex, and
// BigInt() throws on non-decimal input.
export const FenceGeneration = z.string().refine(value => CANONICAL_GENERATION.test(value) && BigInt(value) <= MAX_GENERATION)
/** RFC 3339 timestamp in UTC (`Z`), optional fractional seconds. */
export const NotAfter = z.iso.datetime()

const AcquireFenceBody = z.object({ generation: FenceGeneration, not_after: NotAfter }).strict()
const AcquireFenceParams = z.object({ storeId: z.string(), key: FenceKey })

const VALIDATION_ERROR = { code: 'validation_error', message: 'invalid write fence headers' } as const

export const writeFenceRoutes = new Hono()

writeFenceRoutes.put(
  `${EXTENSION_PREFIX}/stores/:storeId/write-fences/:key`,
  validate('param', AcquireFenceParams),
  validate('json', AcquireFenceBody),
  async (c) => {
    const { storeId, key } = c.req.valid('param')
    const body = c.req.valid('json')
    return c.json(await acquireWriteFence(storeId, { key, generation: body.generation }, body.not_after))
  },
)

/**
 * Parse the fence headers. Returns null when they are malformed or
 * incomplete: a key requires a generation and a deadline, a generation
 * requires a key. `X-Not-After` alone is a valid deadline-only write.
 */
export function parseWriteContext(headers: Headers): WriteContext | null {
  const rawDeadline = headers.get('X-Not-After') ?? undefined
  const rawKey = headers.get('X-Write-Fence-Key') ?? undefined
  const rawGeneration = headers.get('X-Write-Fence-Generation') ?? undefined
  if (rawDeadline !== undefined && !NotAfter.safeParse(rawDeadline).success) return null
  if (rawKey !== undefined || rawGeneration !== undefined) {
    if (rawDeadline === undefined || !FenceKey.safeParse(rawKey).success || !FenceGeneration.safeParse(rawGeneration).success) return null
  }
  return {
    deadline: rawDeadline === undefined ? undefined : { notAfter: Date.parse(rawDeadline) },
    fence: rawKey === undefined ? undefined : { key: rawKey, generation: rawGeneration! },
  }
}

/**
 * Mounted on /stores/:storeId/write after requireStore and before
 * idempotency, so a cached 2xx can never be replayed to a late or
 * superseded writer.
 */
export function writeFencePreflight(): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== 'POST') return next()
    const context = parseWriteContext(c.req.raw.headers)
    if (!context) return c.json(VALIDATION_ERROR, 400)
    await precheckWriteFence(c.req.param('storeId')!, context.fence, context.deadline)
    c.set('writeContext', context)
    await next()
  }
}
