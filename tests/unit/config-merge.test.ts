/**
 * $env blocks must REPLACE arrays (higher layer wins), not
 * concatenate them the way c12's default defu merger does.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { loadAndParseConfig, mergeConfigLayers } from '../../src/config.js'

const fixtureDir = fileURLToPath(new URL('../fixtures/config-env-arrays', import.meta.url))
const originalNodeEnv = process.env.NODE_ENV

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
})

describe('mergeConfigLayers', () => {
  it('replaces arrays with the highest-precedence layer', () => {
    expect(mergeConfigLayers({ a: ['x'] }, { a: ['y', 'z'] })).toEqual({ a: ['x'] })
  })

  it('deep-merges objects and skips null/undefined', () => {
    const merged = mergeConfigLayers<Record<string, unknown>>(
      { o: { k: 1, n: null } },
      { o: { k: 2, j: 3, n: 'kept' }, p: 4 },
    )
    expect(merged).toEqual({ o: { k: 1, j: 3, n: 'kept' }, p: 4 })
  })

  it('ignores prototype-polluting keys', () => {
    const evil = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>
    mergeConfigLayers(evil, {})
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('loadAndParseConfig — $production block', () => {
  it('replaces base presharedKeys instead of appending', async () => {
    process.env.NODE_ENV = 'production'
    const cfg = await loadAndParseConfig({ cwd: fixtureDir, env: {}, dotenv: false })
    expect(cfg.auth.presharedKeys).toEqual(['prod-key-1'])
  })

  it('keeps base keys when no env block applies', async () => {
    process.env.NODE_ENV = 'development'
    const cfg = await loadAndParseConfig({ cwd: fixtureDir, env: {}, dotenv: false })
    expect(cfg.auth.presharedKeys).toEqual(['base-key-1', 'base-key-2'])
  })
})
