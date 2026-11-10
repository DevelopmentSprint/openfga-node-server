/**
 * Graceful process shutdown, owned by `src/server.ts`.
 *
 * Registering a SIGTERM/SIGINT listener disables Node's default
 * "exit on signal" behavior, so whoever registers one must also exit.
 * This module is that single owner. The sequence is:
 *
 *   1. stop accepting connections (close HTTP/HTTPS listeners)
 *   2. flush and shut down OpenTelemetry
 *   3. close the database pool
 *   4. exit 0 (exit 1 if any step failed)
 *
 * A second signal, or the overall timeout elapsing, forces exit(1).
 * All side effects are injected so the sequencing is unit-testable.
 */
export interface ShutdownLogger {
  info: (obj: Record<string, unknown>, msg: string) => void
  warn: (obj: Record<string, unknown>, msg: string) => void
  error: (obj: Record<string, unknown>, msg: string) => void
}

export interface ShutdownDeps {
  /** Close every bound listener; resolves once they have drained. */
  closeListeners: () => Promise<void>
  /** Flush and shut down telemetry. */
  shutdownTelemetry: () => Promise<void>
  /** Release the database pool / driver. */
  closeDatabase: () => Promise<void>
  exit: (code: number) => void
  log: ShutdownLogger
  /** Upper bound for the whole sequence. Default 10 000 ms. */
  timeoutMs?: number
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000

/**
 * Build the signal handler. Call the returned function with the
 * signal name; the first call runs the sequence, any later call forces
 * an immediate exit(1).
 */
export function createShutdownHandler(deps: ShutdownDeps): (signal: string) => Promise<void> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
  let started = false

  return async (signal: string): Promise<void> => {
    if (started) {
      deps.log.warn({ signal }, 'shutdown_forced; received a second signal')
      deps.exit(1)
      return
    }
    started = true
    deps.log.info({ signal, timeoutMs }, 'shutdown_started')

    const timer = setTimeout(() => {
      deps.log.error({ signal, timeoutMs }, 'shutdown_timeout; forcing exit')
      deps.exit(1)
    }, timeoutMs)
    timer.unref()

    let failed = false
    const steps: Array<[string, () => Promise<void>]> = [
      ['listeners', deps.closeListeners],
      ['telemetry', deps.shutdownTelemetry],
      ['database', deps.closeDatabase],
    ]
    for (const [name, run] of steps) {
      try {
        await run()
      }
      catch (err) {
        failed = true
        deps.log.error({ err, step: name }, 'shutdown_step_failed')
      }
    }

    clearTimeout(timer)
    deps.log.info({ signal, failed }, 'shutdown_complete')
    deps.exit(failed ? 1 : 0)
  }
}

/** Minimal shape shared by node:http and node:https servers. */
export interface ClosableServer {
  close: (cb: (err?: Error) => void) => unknown
  closeIdleConnections?: () => void
}

/** Close all servers, dropping idle keep-alive sockets so close() can finish. */
export async function closeServers(servers: readonly ClosableServer[]): Promise<void> {
  await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => {
    server.close(err => (err ? reject(err) : resolve()))
    server.closeIdleConnections?.()
  })))
}
