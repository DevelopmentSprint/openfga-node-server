/**
 * Resolves the service version reported as `service.version` when
 * `otel.service.version` is unset (docs/features/opentelemetry.md).
 *
 * Order: the build-time constant injected by tsdown (`define` in
 * tsdown.config.ts), then `package.json` read relative to this module
 * (works from `src/observability/` in dev and from `dist/` in a built
 * checkout). Returns undefined when neither is available, in which
 * case the attribute is simply omitted.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

declare const __PACKAGE_VERSION__: string | undefined

export function resolvePackageVersion(
  readFile: (path: string) => string = p => readFileSync(p, 'utf8'),
  moduleUrl: string = import.meta.url,
): string | undefined {
  if (typeof __PACKAGE_VERSION__ === 'string' && __PACKAGE_VERSION__ !== '') {
    return __PACKAGE_VERSION__
  }
  for (const rel of ['../../package.json', '../package.json']) {
    try {
      const parsed = JSON.parse(readFile(fileURLToPath(new URL(rel, moduleUrl)))) as { name?: unknown, version?: unknown }
      if (typeof parsed.version === 'string' && parsed.version !== '') return parsed.version
    }
    catch {
      // try the next candidate
    }
  }
  return undefined
}
