/**
 * Local wrapper around `@hono/zod-validator` that maps validation
 * failures into this server's OpenFGA-compatible error envelope.
 *
 * The default `zValidator` response leaks the raw Zod result shape and,
 * for malformed JSON bodies, short-circuits with its own
 * `{ error: '…' }` envelope before calling the validator hook. Both
 * are not the public API contract for this server. This wrapper:
 *
 *   - For `target === 'json'`, pre-parses the body in a try/catch so a
 *     malformed JSON body gets the same flat
 *     `{ code: 'validation_error', message: 'request validation failed' }`
 *     envelope as a schema-rejection.
 *   - For all targets, maps schema-validation failures into the same
 *     envelope via the validator hook.
 *
 * Routes consume validated values via
 * `c.req.valid('json' | 'param' | 'query' | 'header')` after the
 * middleware runs, with full TypeScript inference from the Zod schema.
 */
import { zValidator } from '@hono/zod-validator'
import type { ZodType } from 'zod'
import type { Context, Next, ValidationTargets } from 'hono'

type Target = keyof ValidationTargets

const INVALID_ARGUMENT = {
  code: 'validation_error',
  message: 'request validation failed',
} as const

interface ValidationOptions {
  code?: 'invalid_argument' | 'validation_error'
  /** Use explicit schema diagnostics for endpoints whose upstream contract defines them. */
  schemaMessage?: boolean
}

export function validate<T extends Target, S extends ZodType>(target: T, schema: S, options: ValidationOptions = {}) {
  const envelope = { ...INVALID_ARGUMENT, code: options.code ?? INVALID_ARGUMENT.code }
  const schemaValidator = zValidator(target, schema, (result, c) => {
    if (!result.success) return c.json({
      ...envelope,
      message: options.schemaMessage ? result.error.issues[0]?.message ?? envelope.message : envelope.message,
    }, 400)
  })

  if (target !== 'json') return schemaValidator

  // Pre-parse JSON so malformed bodies get our envelope. Hono caches
  // the parsed body on the request, so the inner zValidator's own
  // c.req.json() call returns the cached value without re-parsing.
  return async (c: Context, next: Next) => {
    try {
      await c.req.json()
    }
    catch {
      return c.json(envelope, 400)
    }
    return schemaValidator(c, next)
  }
}
