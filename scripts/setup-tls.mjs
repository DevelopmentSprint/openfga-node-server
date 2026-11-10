#!/usr/bin/env node
/**
 * Local-HTTPS setup using mkcert.
 *
 * Idempotently installs the mkcert root CA into the system trust
 * store, then issues a cert + key for `localhost`, `127.0.0.1`, and
 * `::1` into `.certs/`. Prints the env vars to copy into `.env`.
 *
 * Run:  pnpm cert:create
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const HOSTS = ['localhost', '127.0.0.1', '::1']
const CERTS_DIR = resolve(process.cwd(), '.certs')
const CERT_FILE = resolve(CERTS_DIR, 'localhost.pem')
const KEY_FILE = resolve(CERTS_DIR, 'localhost-key.pem')

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (res.status !== 0) process.exit(res.status ?? 1)
}

function capture(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: 'utf8' })
  return res.status === 0 ? res.stdout.trim() : null
}

if (capture('which', ['mkcert']) === null) {
  console.error([
    '[setup-tls] mkcert is not installed.',
    '',
    'Install it via:',
    '  macOS:   brew install mkcert nss',
    '  Linux:   see https://github.com/FiloSottile/mkcert#installation',
    '  Windows: choco install mkcert',
    '',
  ].join('\n'))
  process.exit(1)
}

console.log('[setup-tls] Installing local root CA (idempotent)…')
run('mkcert', ['-install'])

console.log(`[setup-tls] Generating cert for ${HOSTS.join(', ')}…`)
mkdirSync(CERTS_DIR, { recursive: true })
run('mkcert', ['-cert-file', CERT_FILE, '-key-file', KEY_FILE, ...HOSTS])

const caRoot = capture('mkcert', ['-CAROOT'])
const rootCAPath = caRoot ? resolve(caRoot, 'rootCA.pem') : '<run: mkcert -CAROOT>/rootCA.pem'

console.log('')
console.log('[setup-tls] Done.')
console.log('')
console.log('Add to .env:')
console.log('')
console.log(`  OPENFGA_TLS_CERT_FILE=${CERT_FILE}`)
console.log(`  OPENFGA_TLS_KEY_FILE=${KEY_FILE}`)
console.log('')
console.log('To make Node-side clients (pnpm load-model, etc.) trust the')
console.log('cert when calling https://localhost, also add:')
console.log('')
console.log(`  NODE_EXTRA_CA_CERTS=${rootCAPath}`)
console.log('')
console.log('And update OPENFGA_API_URL accordingly:')
console.log('')
console.log('  OPENFGA_API_URL=https://localhost:8443')
console.log('')
