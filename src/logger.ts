/**
 * Process-wide pino logger.
 *
 * Level comes from the resolved configuration's `log.level` field
 * (env var `OPENFGA_LOG_LEVEL` overrides the configured value via
 * the same path; see `docs/features/configuration.md`). Accepts
 * pino's standard levels: `trace`, `debug`, `info`, `warn`, `error`,
 * `fatal`, or `silent`.
 *
 * Output format:
 * - Interactive TTY AND `NODE_ENV !== 'production'` AND the
 *   `pino-pretty` devDependency resolves → human-readable colored
 *   output.
 * - Otherwise (piped, container stdout, CI, production, pruned
 *   installs) → raw JSON, one event per line.
 */
import { createRequire } from 'node:module'
import pino from 'pino'
import { config } from './config'

export interface LogTransportInputs {
  isTTY: boolean
  nodeEnv: string | undefined
  /** True when `pino-pretty` can be resolved from this install. */
  prettyAvailable: boolean
}

/**
 * Pick the pino transport. Pretty output is used only for interactive
 * non-production runs where the devDependency is actually installed;
 * everything else (production, pruned installs run with `-t`, piped
 * output) stays on JSON so the process can never crash on a missing
 * module.
 */
export function selectLogTransport(inputs: LogTransportInputs): pino.TransportSingleOptions | undefined {
  if (!inputs.isTTY || inputs.nodeEnv === 'production' || !inputs.prettyAvailable) return undefined
  return {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:HH:MM:ss.l',
      ignore: 'pid,hostname',
    },
  }
}

function canResolvePretty(): boolean {
  try {
    createRequire(import.meta.url).resolve('pino-pretty')
    return true
  }
  catch {
    return false
  }
}

const transport = selectLogTransport({
  isTTY: Boolean(process.stdout.isTTY),
  nodeEnv: process.env.NODE_ENV,
  prettyAvailable: process.stdout.isTTY ? canResolvePretty() : false,
})

export const logger = pino({ level: config.log.level, transport })
