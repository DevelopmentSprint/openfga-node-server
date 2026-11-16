# Conformance, capability probes and latency harness

Evidence tooling for comparing NodeFGA with upstream OpenFGA. It adds no server code. Everything runs locally
against Docker and local processes; nothing here deploys or contacts a hosted service.

| Path | Purpose |
|---|---|
| `docker/` | Throwaway stack: one PostgreSQL server (database per engine), upstream `openfga/openfga` (default `v1.22.0`) as control, and NodeFGA built from this checkout. `up.sh <project>` starts it on loopback ephemeral ports. |
| `upstream/`, `run-upstream.sh`, `summarize-upstream.mjs` | Runs upstream's Go query suites (check, list-objects, list-users, plus the check and list-objects matrices) against any HTTP server. A small Go client implements upstream's `tests.ClientInterface` over REST and the suites run unmodified inside a checkout of the pinned upstream tag. |
| `probes/probes.mjs` | Side-by-side capability probes with identical inputs: modular models, CEL conditions, contextual tuples, ReadChanges, consistency, write semantics, model pinning, ListObjects limits. |
| `bench/bench.mjs`, `bench/summarize.mjs` | Seeded latency benchmark (organization -> workspace -> project inheritance) at chosen data sizes. |
| `embed/embed.ts` | In-process embedding probe (Hono app served through `app.fetch`, SQLite in memory). |
| `repro/repros.mjs` | Minimal reproductions of the defects found, runnable against both servers. |
| `results/` | Summaries and raw observations from the recorded run (`*.jsonl` and `*.stderr` are not committed). |

## Reading the results

* **Control first.** The upstream server must pass the suite through the harness before any failure of another server
  counts. With the settings in `docker/compose.yaml` (`reference-suite`) the control passes 2221 and fails 0 of the
  core suites, and passes 2299 and fails 0 of the matrices.
* **Harness adaptations** (in `upstream/httpclient.go`, applied to both servers): the REST streaming endpoint reports errors
  as gateway-wrapped gRPC codes, so the specific OpenFGA code is recovered by replaying the request on the unary
  endpoint; model JSON is sent with the published camelCase userset keys; and `CONF_NORMALIZE_TIMESTAMPS=1` rewrites
  SQL-style timestamps to RFC 3339 so strict protobuf JSON parsing can proceed. The unnormalised run is kept as
  `upstream-nodefga-strict.summary.json`.
* **Skips** are upstream's own skips (for example multi-stage tests that cannot run with contextual tuples).
* **Not run**: upstream's in-process server tests (`tests/functional_test.go`, `cmd/run` tests, storage tests, AuthZEN) because
  they start the Go server or call Go packages directly.

## Running

```sh
export CONF_PG_PASSWORD=$(openssl rand -hex 12)
sh tests/conformance/docker/up.sh conf-ev            # prints REFERENCE_URL / NODEFGA_URL exports
sh tests/conformance/run-upstream.sh <url> <label> check,listobjects,listusers
node tests/conformance/probes/probes.mjs
COMPOSE_PROJECT=conf-ev node tests/conformance/bench/bench.mjs --engine nodefga --size 100000
```
`run-upstream.sh` needs Go and network access to clone the upstream tag. For the control use the
`reference-suite` service (experimental flags and no query deadlines, as upstream's own suites configure their server).

## Limits of the latency numbers

Measured at the client over loopback and Docker port forwarding on a shared development machine whose load average was
far above its core count during the runs. They compare the two engines under the same conditions; they do not
predict hosted latency. A hosted measurement additionally needs the real network path (function region to database
region), serverless cold starts and connection setup, the hosted database tier and pooler, production-shaped data and
model, and concurrency from real callers.
