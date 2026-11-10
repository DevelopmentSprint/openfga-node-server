import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeServers, createShutdownHandler, type ShutdownDeps } from '../../src/shutdown.js'

function makeDeps(overrides: Partial<ShutdownDeps> = {}) {
  const order: string[] = []
  const exit = vi.fn()
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const deps: ShutdownDeps = {
    closeListeners: async () => { order.push('listeners') },
    shutdownTelemetry: async () => { order.push('telemetry') },
    closeDatabase: async () => { order.push('database') },
    exit,
    log,
    timeoutMs: 1000,
    ...overrides,
  }
  return { deps, order, exit, log }
}

describe('createShutdownHandler', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('closes listeners, then telemetry, then the database, then exits 0', async () => {
    const { deps, order, exit } = makeDeps()
    await createShutdownHandler(deps)('SIGTERM')
    expect(order).toEqual(['listeners', 'telemetry', 'database'])
    expect(exit).toHaveBeenCalledExactlyOnceWith(0)
  })

  it('keeps going after a failing step but exits 1', async () => {
    const { deps, order, exit, log } = makeDeps({
      shutdownTelemetry: async () => { throw new Error('flush failed') },
    })
    await createShutdownHandler(deps)('SIGINT')
    expect(order).toEqual(['listeners', 'database'])
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ step: 'telemetry' }), 'shutdown_step_failed')
    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('forces exit(1) on a second signal while the first is still draining', async () => {
    let release!: () => void
    const { deps, exit } = makeDeps({
      closeListeners: () => new Promise<void>((resolve) => { release = resolve }),
    })
    const handler = createShutdownHandler(deps)
    const first = handler('SIGTERM')
    await handler('SIGTERM')
    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
    release()
    await first
  })

  it('forces exit(1) when the sequence exceeds the timeout', async () => {
    const { deps, exit } = makeDeps({ closeListeners: () => new Promise<void>(() => {}) })
    void createShutdownHandler(deps)('SIGTERM')
    await vi.advanceTimersByTimeAsync(1000)
    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
  })
})

describe('closeServers', () => {
  it('closes every server and drops idle connections', async () => {
    const make = () => ({
      close: vi.fn((cb: (err?: Error) => void) => { cb() }),
      closeIdleConnections: vi.fn(),
    })
    const a = make()
    const b = make()
    await closeServers([a, b])
    expect(a.close).toHaveBeenCalledOnce()
    expect(b.closeIdleConnections).toHaveBeenCalledOnce()
  })

  it('rejects when a server fails to close', async () => {
    const bad = { close: (cb: (err?: Error) => void) => { cb(new Error('boom')) } }
    await expect(closeServers([bad])).rejects.toThrow('boom')
  })
})
