/**
 * Hono application instance — the entrypoint that serverless hosts and
 * other request-transport runtimes import, and the source of the `app`
 * re-imported by `./server.ts` for self-hosting.
 *
 * This file MUST stay free of socket binding, env reads with
 * `process.exit`, or any other side effect that assumes a
 * long-running Node process. Bootstrap concerns belong in
 * `./server.ts`.
 */
import { buildApp } from './routes/index'

const app = buildApp()

export default app
