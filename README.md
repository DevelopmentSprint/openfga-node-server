# NodeFGA

[![Release](https://img.shields.io/github/v/release/DevelopmentSprint/openfga-node-server)](https://github.com/DevelopmentSprint/openfga-node-server/releases/latest)
[![codecov](https://codecov.io/gh/DevelopmentSprint/openfga-node-server/graph/badge.svg)](https://codecov.io/gh/DevelopmentSprint/openfga-node-server)

**NodeFGA** — fine-grained, relationship-based authorization for Node.
Implements the OpenFGA model for the supported authorization features;
runs anywhere Node runs. A [DevelopmentSprint](https://github.com/DevelopmentSprint) project.

📖 **Full documentation:** [developmentsprint.github.io/openfga-node-server](https://developmentsprint.github.io/openfga-node-server/)

The published docs cover configuration, authentication modes, observability,
deployment runbooks, recipes, and the migration path to upstream OpenFGA.
This README is intentionally short — it's a starting point, not a
duplicate of the docs site.

## Status

**Early-stage, pre-1.0.** The latest release is
[v0.1.0](https://github.com/DevelopmentSprint/openfga-node-server/releases/tag/v0.1.0),
published May 5, 2026. The documentation site follows `develop` and may
include changes newer than that release.

## OpenFGA compatibility evidence

NodeFGA implements the OpenFGA model, including direct relations, usersets,
typed wildcards, computed relations, tuple-to-userset traversal, unions,
intersections, and differences. Conditional tuples / ABAC are not supported.

The repository's [SDK integration tests](tests/integration/sdk-conformance.test.ts)
exercise implemented endpoints through the official `@openfga/sdk` client over
real HTTP. These are project-owned tests, not OpenFGA's upstream conformance
suite. Upstream conformance has not been verified; NodeFGA does not claim to
pass that suite or provide complete OpenFGA feature parity.

Run the SDK checks locally (SQLite, no external database required):

```sh
pnpm install --frozen-lockfile
pnpm test:integration tests/integration/sdk-conformance.test.ts
```

## Quick start

```sh
pnpm install

# Configure (file is canonical; env vars override file values).
cp openfga.config.example.yaml openfga.config.yaml
$EDITOR openfga.config.yaml         # set db.url at minimum

# Apply schema.
pnpm migrate up

# Boot.
pnpm dev

# In another shell — load the example authorization model.
pnpm load-model tests/fixtures/github.fga
```

The server listens on `:8080`. Liveness check:

```sh
curl http://localhost:8080/health
# {"status":"ok"}
```

For everything else — full configuration surface, auth setup, OpenTelemetry
wiring, production deployment runbooks, worked-example recipes — see the
[documentation site](https://developmentsprint.github.io/openfga-node-server/).

## Repository layout

- `src/` — server source (routes, evaluator, storage, middleware).
- `tests/` — unit + integration tests, including SDK integration checks.
- `migrations/` — Kysely-typed schema migrations.
- `docs/` — internal specs (PRD, architecture, feature specs, policies). Not
  shipped to the docs site.
- `docs-site/` — published documentation (VitePress, deployed to GitHub
  Pages by `.github/workflows/docs.yml`).

## Development

```sh
pnpm verify             # lint, typecheck, build, tests + coverage
pnpm verify:fast        # lint, typecheck, build, unit tests
pnpm test               # unit + integration
pnpm docs:dev           # local docs preview (http://localhost:5173)
```

Workflow conventions — branches, commits, beads, code reviews — live under
[`docs/policies/`](docs/policies/). `CLAUDE.md` is the agent-facing index
into those policies.

## License

MIT.
