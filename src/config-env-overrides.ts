/**
 * Translate flat OPENFGA_* environment variables into the nested
 * configuration shape declared by `src/config-schema.ts`.
 *
 * This module is pure: it takes a raw config object and an env-like
 * source, returns a merged object. It performs no I/O and has no
 * side effects at module evaluation time.
 *
 * Empty-string semantics follow the rules in
 * `docs/features/configuration.md` §"Empty-String Semantics":
 *   - Optional strings (TLS, storeId): trim; empty → not written
 *     (leave undefined so the schema's optional() applies).
 *   - Required strings (db.url): trim; empty → not written
 *     (schema-level optional, `requireDbUrl()` fails fast at use site).
 *   - Comma-string arrays (presharedKeys): split, trim, drop empties.
 *   - Booleans: trim; empty → not written (schema default applies).
 *   - Integers: empty → not written (schema default applies).
 *
 * The merge is deep over the nested groups. Existing values from the
 * raw object are only overwritten when the corresponding env var is
 * set to a non-empty trimmed value.
 */

type EnvLike = Record<string, string | undefined>

type Merged = Record<string, unknown>

function readNonEmpty(env: EnvLike, key: string): string | undefined {
  const raw = env[key]
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  return trimmed
}

/**
 * Parse an OpenTelemetry-standard key/value list, the format of
 * OTEL_EXPORTER_OTLP_HEADERS and OTEL_RESOURCE_ATTRIBUTES: comma-separated
 * `key=value` pairs. Keys and values are trimmed, values are
 * percent-decoded, empty entries are ignored, and only the first `=`
 * separates key from value.
 *
 * An invalid entry throws an error that names the variable and the entry
 * position but never echoes the entry: headers can carry credentials.
 */
export function parseOtelKeyValueList(envKey: string, raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  const entries = raw.split(',')
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!.trim()
    if (entry === '') continue
    const eq = entry.indexOf('=')
    const key = eq > 0 ? entry.slice(0, eq).trim() : ''
    if (key === '') {
      throw new Error(`${envKey}: entry ${i + 1} is not a valid key=value pair (expected comma-separated key=value pairs)`)
    }
    let value: string
    try {
      value = decodeURIComponent(entry.slice(eq + 1).trim())
    }
    catch {
      throw new Error(`${envKey}: entry ${i + 1} has an invalid percent-encoded value`)
    }
    out[key] = value
  }
  return out
}

function ensureObject(target: Merged, key: string): Merged {
  const existing = target[key]
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    return existing as Merged
  }
  const created: Merged = {}
  target[key] = created
  return created
}

function setPath(target: Merged, path: readonly string[], value: unknown): void {
  let node: Merged = target
  for (let i = 0; i < path.length - 1; i++) {
    node = ensureObject(node, path[i]!)
  }
  node[path[path.length - 1]!] = value
}

function cloneDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return value.map(item => cloneDeep(item)) as unknown as T
  }
  const result: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    result[k] = cloneDeep(v)
  }
  return result as T
}

/**
 * Apply OPENFGA_* env-var overrides on top of a raw config object.
 *
 * The raw object is cloned before mutation. Strings, booleans, and
 * integers are passed through as-is to the schema, which performs
 * the actual coercion and validation. Comma-separated arrays
 * (presharedKeys) are split here because the schema declares an
 * `array<string>` shape, not a coerce-from-string transform.
 */
export function applyEnvOverrides(raw: unknown, env: EnvLike = process.env): unknown {
  const base: Merged = (raw && typeof raw === 'object' && !Array.isArray(raw))
    ? cloneDeep(raw as Merged)
    : {}

  const set = (path: readonly string[], envKey: string): void => {
    const v = readNonEmpty(env, envKey)
    if (v !== undefined) setPath(base, path, v)
  }

  // ─── db ──────────────────────────────────────────────────────────
  set(['db', 'url'], 'OPENFGA_DB_URL')
  set(['db', 'namespace'], 'OPENFGA_DB_NAMESPACE')
  set(['db', 'applicationName'], 'OPENFGA_DB_APPLICATION_NAME')

  // ─── db.pool ─────────────────────────────────────────────────────
  set(['db', 'pool', 'max'], 'OPENFGA_DB_POOL_MAX')
  set(['db', 'pool', 'min'], 'OPENFGA_DB_POOL_MIN')
  set(['db', 'pool', 'idleTimeoutMs'], 'OPENFGA_DB_POOL_IDLE_TIMEOUT_MS')
  set(['db', 'pool', 'connectionTimeoutMs'], 'OPENFGA_DB_POOL_CONNECTION_TIMEOUT_MS')
  set(['db', 'pool', 'statementTimeoutMs'], 'OPENFGA_DB_STATEMENT_TIMEOUT_MS')
  set(['db', 'pool', 'queryTimeoutMs'], 'OPENFGA_DB_QUERY_TIMEOUT_MS')

  // ─── listeners ───────────────────────────────────────────────────
  set(['listeners', 'http', 'enabled'], 'OPENFGA_HTTP_ENABLED')
  set(['listeners', 'http', 'port'], 'OPENFGA_HTTP_PORT')
  set(['listeners', 'https', 'port'], 'OPENFGA_HTTPS_PORT')

  // ─── tls ─────────────────────────────────────────────────────────
  set(['tls', 'certFile'], 'OPENFGA_TLS_CERT_FILE')
  set(['tls', 'keyFile'], 'OPENFGA_TLS_KEY_FILE')

  // ─── log ─────────────────────────────────────────────────────────
  set(['log', 'level'], 'OPENFGA_LOG_LEVEL')

  // ─── auth ────────────────────────────────────────────────────────
  set(['auth', 'mode'], 'OPENFGA_AUTH_MODE')

  // presharedKeys takes a comma-separated string; split, trim, drop empties.
  const rawKeys = readNonEmpty(env, 'OPENFGA_AUTH_PRESHARED_KEYS')
  if (rawKeys !== undefined) {
    const parts = rawKeys
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0)
    setPath(base, ['auth', 'presharedKeys'], parts)
  }

  // ─── auth.oidc ──────────────────────────────────────────────────
  set(['auth', 'oidc', 'issuer'], 'OPENFGA_AUTH_OIDC_ISSUER')
  set(['auth', 'oidc', 'audience'], 'OPENFGA_AUTH_OIDC_AUDIENCE')
  set(['auth', 'oidc', 'clockSkewSec'], 'OPENFGA_AUTH_OIDC_CLOCK_SKEW_SEC')
  set(['auth', 'oidc', 'jwksUri'], 'OPENFGA_AUTH_OIDC_JWKS_URI')
  set(['auth', 'oidc', 'jwksCacheMaxAgeMs'], 'OPENFGA_AUTH_OIDC_JWKS_CACHE_MAX_AGE_MS')
  set(['auth', 'oidc', 'jwksCooldownMs'], 'OPENFGA_AUTH_OIDC_JWKS_COOLDOWN_MS')

  // Comma-separated array fields for OIDC. Same split/trim/drop-empty
  // policy as OPENFGA_AUTH_PRESHARED_KEYS.
  for (const [envKey, configPath] of [
    ['OPENFGA_AUTH_OIDC_ISSUER_ALIASES', ['auth', 'oidc', 'issuerAliases']],
    ['OPENFGA_AUTH_OIDC_SUBJECTS', ['auth', 'oidc', 'subjects']],
    ['OPENFGA_AUTH_OIDC_CLIENTS', ['auth', 'oidc', 'clients']],
    ['OPENFGA_AUTH_OIDC_ALGORITHMS', ['auth', 'oidc', 'algorithms']],
  ] as const) {
    const raw = readNonEmpty(env, envKey)
    if (raw !== undefined) {
      const parts = raw
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0)
      setPath(base, configPath as readonly string[], parts)
    }
  }

  // ─── idempotency ────────────────────────────────────────────────
  set(['idempotency', 'mode'], 'OPENFGA_IDEMPOTENCY_MODE')
  set(['idempotency', 'ttlMs'], 'OPENFGA_IDEMPOTENCY_TTL_MS')

  // ─── loadModel ──────────────────────────────────────────────────
  set(['loadModel', 'apiUrl'], 'OPENFGA_API_URL')
  set(['loadModel', 'storeName'], 'OPENFGA_STORE_NAME')
  set(['loadModel', 'storeId'], 'OPENFGA_STORE_ID')

  // ─── otel ───────────────────────────────────────────────────────
  set(['otel', 'enabled'], 'OPENFGA_OTEL_ENABLED')
  set(['otel', 'service', 'name'], 'OPENFGA_OTEL_SERVICE_NAME')
  set(['otel', 'service', 'version'], 'OPENFGA_OTEL_SERVICE_VERSION')
  set(['otel', 'exporter', 'type'], 'OPENFGA_OTEL_EXPORTER_TYPE')
  set(['otel', 'exporter', 'endpoint'], 'OPENFGA_OTEL_EXPORTER_ENDPOINT')
  set(['otel', 'exporter', 'timeoutMs'], 'OPENFGA_OTEL_EXPORTER_TIMEOUT_MS')
  set(['otel', 'sampler', 'type'], 'OPENFGA_OTEL_SAMPLER_TYPE')
  set(['otel', 'sampler', 'ratio'], 'OPENFGA_OTEL_SAMPLER_RATIO')
  set(['otel', 'spans', 'http'], 'OPENFGA_OTEL_SPANS_HTTP')
  set(['otel', 'spans', 'evaluator'], 'OPENFGA_OTEL_SPANS_EVALUATOR')
  set(['otel', 'spans', 'storage'], 'OPENFGA_OTEL_SPANS_STORAGE')
  set(['otel', 'spans', 'auth'], 'OPENFGA_OTEL_SPANS_AUTH')
  set(['otel', 'spans', 'idempotency'], 'OPENFGA_OTEL_SPANS_IDEMPOTENCY')

  // Map-valued fields use the OpenTelemetry-standard key=value list
  // format (see parseOtelKeyValueList).
  for (const [envKey, configPath] of [
    ['OPENFGA_OTEL_EXPORTER_HEADERS', ['otel', 'exporter', 'headers']],
    ['OPENFGA_OTEL_RESOURCE_ATTRIBUTES', ['otel', 'resource', 'attributes']],
  ] as const) {
    const raw = readNonEmpty(env, envKey)
    if (raw !== undefined) {
      setPath(base, configPath as readonly string[], parseOtelKeyValueList(envKey, raw))
    }
  }

  // Comma-separated list fields.
  for (const [envKey, configPath] of [
    ['OPENFGA_OTEL_PROPAGATORS', ['otel', 'propagators']],
    ['OPENFGA_OTEL_CAPTURE_REQUEST_HEADERS', ['otel', 'capture', 'requestHeaders']],
    ['OPENFGA_OTEL_CAPTURE_RESPONSE_HEADERS', ['otel', 'capture', 'responseHeaders']],
  ] as const) {
    const raw = readNonEmpty(env, envKey)
    if (raw !== undefined) {
      const parts = raw
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0)
      setPath(base, configPath as readonly string[], parts)
    }
  }

  // ─── top-level ──────────────────────────────────────────────────
  set(['migrateOnStart'], 'OPENFGA_MIGRATE_ON_START')

  return base
}
