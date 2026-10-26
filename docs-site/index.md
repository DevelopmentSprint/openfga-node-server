---
layout: home

hero:
  name: NodeFGA
  text: Fine-grained authorization for Node
  tagline: Relationship-based authorization (ReBAC) built on the OpenFGA model, anywhere Node runs.
  image:
    src: /logo.svg
    alt: NodeFGA
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: v0.1.0 release
      link: https://github.com/DevelopmentSprint/openfga-node-server/releases/tag/v0.1.0
    - theme: alt
      text: View on GitHub
      link: https://github.com/DevelopmentSprint/openfga-node-server

features:
  - icon: 🌐
    title: Runs anywhere Node runs
    details: Vercel, Fly, Cloud Run, bare metal, containers, embedded — anywhere a Node 22 process can bind sockets. No Go binary required.
  - icon: 🗄️
    title: Postgres or SQLite
    details: Production-grade Postgres with a Kysely-typed query layer, or embedded SQLite for tests and small deployments. Dialect inferred from `OPENFGA_DB_URL`.
  - icon: ⚙️
    title: Hierarchical configuration
    details: Hierarchical YAML/TOML config with per-environment overrides via c12, plus full env-var override compatibility for twelve-factor deployments.
  - icon: 🔐
    title: Three auth modes
    details: "`none` (default), `preshared` keys for static tokens, and `oidc` for JWT validation against an issuer's published JWKS. Fail-fast at boot on misconfig."
  - icon: 🔁
    title: Idempotency built in
    details: HTTP-level `Idempotency-Key` support for mutating endpoints with persistent storage, replay semantics, and configurable rollout modes.
  - icon: 📊
    title: OpenTelemetry everywhere
    details: Spans at every internal and external API boundary — HTTP, evaluator, storage. Per-boundary gating. Off by default; zero runtime cost when disabled.
  - icon: 🧩
    title: OpenFGA modeling language
    details: Author authorization models in the `.fga` DSL with the upstream tooling. Project-owned integration tests exercise supported endpoints through the official `@openfga/sdk` client.
  - icon: 🪜
    title: Migration path
    details: If you outgrow NodeFGA, the [migration runbook](/runbooks/migrate-to-upstream-openfga) covers moving stores, models, and tuples to the upstream Go reference implementation.
---

## Why NodeFGA

A relationship-based authorization service that lives inside your Node stack. No Go sidecar to operate, no managed-service onboarding, no separate runtime to monitor. Deploy it like any other Node service — Vercel, Fly, Cloud Run, a Kubernetes pod, a bare-metal VM — and check permissions against your authorization model from your application code over plain HTTP.

NodeFGA implements the OpenFGA model for supported authorization features, using the `.fga` modeling language and relationship tuples. Project-owned integration tests exercise implemented endpoints through the official `@openfga/sdk` client. Upstream OpenFGA conformance has not been verified, and standard model-defined conditional tuples are supported, with documented evaluation limits. See [compatibility evidence](/guide/getting-started#compatibility-evidence).

**Status:** early-stage, pre-1.0. [v0.1.0](https://github.com/DevelopmentSprint/openfga-node-server/releases/tag/v0.1.0) was released May 5, 2026. NodeFGA is a [DevelopmentSprint](https://github.com/DevelopmentSprint) project. This documentation follows `develop` and may describe changes newer than the latest release.

## What you get

- The OpenFGA REST surface this project implements: stores, authorization-models (JSON + DSL bodies), check, batch-check, expand, list-objects, list-users, write, read, changes, assertions, health, ready.
- A modular middleware stack: structured logging, three-way auth dispatch, store-existence guard, idempotency.
- A storage layer that runs against Postgres in production and SQLite in tests, with the same Kysely-typed query API.
- A configuration loader that gives you per-environment YAML/TOML blocks AND every twelve-factor `OPENFGA_*` env var, with strict validation at boot.

## What you don't have to commit to

- **No proprietary observability.** OpenTelemetry, exporters of your choice (OTLP HTTP, OTLP gRPC, console). Standard `OTEL_*` env vars honored alongside the `OPENFGA_OTEL_*` ones.
- **No required external service.** A single Node process + a database. No control plane, no telemetry pipeline you can't turn off.

## Quick start

```sh
pnpm install
cp openfga.config.example.yaml openfga.config.yaml
$EDITOR openfga.config.yaml          # set db.url at minimum
pnpm migrate up
pnpm dev
pnpm load-model tests/fixtures/github.fga
```

Full walkthrough: [Getting Started →](/guide/getting-started)
