/**
 * Liveness and readiness probes. Both are mounted outside the
 * `/stores/*` auth scope in buildApp() so they answer without
 * credentials — Kubernetes-style probes can hit them directly.
 *
 *   GET /health  liveness — always 200 when the process is up
 *   GET /ready   readiness — 200 only when the database is reachable
 *                AND the configured namespace has the core tables
 *                provisioned. 503 otherwise with a coarse reason code
 *                (db_unreachable | schema_missing | schema_outdated)
 *                that never leaks DSN / schema / driver-error detail;
 *                the detail is logged instead.
 */
import { Hono } from 'hono'
import { logger } from '../logger'
import { checkReadiness } from '../storage/readiness'

export const healthRoutes = new Hono()

healthRoutes.get('/health', (c) => c.json({ status: 'ok' }))

healthRoutes.get('/ready', async (c) => {
  const status = await checkReadiness()
  if (status.ok) return c.json({ status: 'ok' })
  // Operator-facing detail (missing tables, pending migrations, driver
  // error) goes to structured logs only; the anonymous body carries the
  // coarse reason code that docs/PRD.md requires and nothing else.
  logger.warn(
    { reason: status.reason, missing: status.missing, pending: status.pending, err: status.error },
    'readiness_check_failed',
  )
  return c.json({ status: 'unhealthy', reason: status.reason }, 503)
})
