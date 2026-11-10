import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.{test,spec}.ts'],
          // SQLite is the default driver for unit tests so the storage
          // layer can be exercised without a Postgres container.
          // Tests that need to swap the URL (e.g. storage-db.test.ts's
          // dialect-detection cases) save and restore the env in
          // beforeEach/afterEach.
          env: {
            OPENFGA_DB_URL: ':memory:',
          },
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.{test,spec}.ts'],
          testTimeout: 30_000,
          // SQLite is the default driver for integration tests too,
          // matching the test-backend choice in docs/PRD.md:116. The
          // suite no longer requires Postgres locally — operators can
          // run `pnpm coverage` on a clean machine and get full
          // feedback. The dialect-portability check against Postgres
          // lives in the `integration-pg` project below, gated on a
          // reachable pg URL.
          env: {
            OPENFGA_DB_URL: ':memory:',
          },
        },
      },
      {
        extends: true,
        test: {
          // Same specs as `integration`, run against Postgres for the
          // dialect-portability check. Skips silently when
          // OPENFGA_DB_URL doesn't point at a reachable Postgres
          // instance (handled in tests/_helpers/integration-bootstrap.ts).
          // CI's `integration-pg` job sets OPENFGA_DB_URL to the
          // service-container Postgres and runs `pnpm migrate up`
          // before invoking this project so the schema is ready.
          name: 'integration-pg',
          environment: 'node',
          include: ['tests/integration/**/*.{test,spec}.ts'],
          testTimeout: 30_000,
        },
      },
    ],
    // Coverage runs against the unit + integration projects (both
    // SQLite-driven) by default. `integration-pg` is excluded from the
    // default coverage view — it runs the same specs against Postgres
    // and would only inflate or duplicate coverage numbers. The CI
    // `integration-pg` job runs without `--coverage` for the same
    // reason; its purpose is dialect-portability, not coverage.
    //
    // Thresholds are floors set ~5% below the baseline measured at
    // bead-close time (openfga-5y9) so they catch regressions without
    // failing day-1. Tighten these in a follow-up bead as new features
    // land with their own tests.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        // Admin CLI tooling — exercised manually, not part of the
        // server runtime exposed by /stores/* routes.
        'src/cli/**',
        // Server entry-point boot wiring — env validation + listener
        // setup. Exercised by UAT and the local smoke against
        // pnpm start, not by unit/integration tests.
        'src/index.ts',
        // Postgres-only side-effect module (registers pg type
        // parsers; intFromEnv helper). The pg branch is exercised
        // by integration tests in CI, not by unit-only tests.
        'src/storage/pg-internals.ts',
        // OpenTelemetry SDK adapter — initOtelSdk + buildExporter /
        // buildSampler / buildPropagator are thin shims over the
        // third-party @opentelemetry/sdk-node packages, exercised
        // only when otel.enabled is true. Disabled-path behavior
        // (the production default + every unit test) is covered by
        // tests/unit/otel-helper.test.ts. SDK-driven verification
        // belongs in a follow-up integration test that boots the
        // SDK against InMemorySpanExporter; tracked separately.
        'src/observability/otel.ts',
      ],
      reporter: ['text-summary', 'json-summary', 'lcov', 'html'],
      // Thresholds reflect the unit + sqlite-default-integration
      // baseline measured at openfga-5y9 closure (statements 85.59,
      // branches 74.45, functions 94.14, lines 87.75 — well above
      // the previous unit-only baseline because integration specs
      // now actually exercise the route+storage path on SQLite
      // instead of silently skipping when Postgres isn't reachable).
      // Floors set ~4–5% below the measured baseline so they catch
      // regressions without failing on day-1 noise. The Postgres
      // dialect branch in `getDb()` remains unreachable from the
      // SQLite-only suite by design and is covered by the
      // `integration-pg` project in CI.
      thresholds: {
        statements: 80,
        branches: 70,
        functions: 89,
        lines: 82,
      },
    },
  },
})
