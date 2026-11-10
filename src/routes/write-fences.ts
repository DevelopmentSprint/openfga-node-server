import { Hono } from 'hono'
import { z } from 'zod'
import { validate } from '../middleware/validation'
import { acquireWriteFence, assertWriteDeadline } from '../storage/write-fences'

export const FenceKey = z.string().min(1).max(128).refine(value => /^[A-Za-z0-9]/.test(value) && !/[^A-Za-z0-9._:-]/.test(value))
export const FenceGeneration = z.string().min(1).max(19).refine(value => value.length > 0 && value.length <= 19 && value[0] !== '0' && !/[^0-9]/.test(value) && BigInt(value) <= 9223372036854775807n)
export const NotAfter = z.iso.datetime()
const AcquireFence = z.object({ generation: FenceGeneration, not_after: NotAfter }).strict()
export const writeFenceRoutes = new Hono()
writeFenceRoutes.put('/stores/:storeId/write-fences/:key', validate('json', AcquireFence), async (c) => {
  const key = FenceKey.safeParse(c.req.param('key'))
  if (!key.success) return c.json({ code: 'invalid_argument', message: 'Invalid write fence key' }, 400)
  const body = c.req.valid('json')
  return c.json(await acquireWriteFence(c.req.param('storeId'), { key: key.data, generation: body.generation }, body.not_after))
})

export class WriteFenceInputError extends Error {
  constructor() { super('Invalid write fence headers') }
}
export function parseWriteContext(headers: Headers) {
  const rawDeadline = headers.get('X-Not-After') ?? undefined
  const rawKey = headers.get('X-Write-Fence-Key') ?? undefined
  const rawGeneration = headers.get('X-Write-Fence-Generation') ?? undefined
  if ((rawDeadline !== undefined && !NotAfter.safeParse(rawDeadline).success)
    || ((rawKey !== undefined || rawGeneration !== undefined) && (!rawDeadline || !FenceKey.safeParse(rawKey).success || !FenceGeneration.safeParse(rawGeneration).success))) throw new WriteFenceInputError()
  const deadline = rawDeadline === undefined ? undefined : { notAfter: Date.parse(rawDeadline) }
  const fence = rawKey === undefined ? undefined : { key: rawKey, generation: rawGeneration! }
  assertWriteDeadline(deadline)
  return { deadline, fence }
}
