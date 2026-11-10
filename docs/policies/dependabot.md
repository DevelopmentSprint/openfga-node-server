# Dependabot Policy

This policy governs how Dependabot updates flow through the repository: which classes auto-merge, which require human review, and how to disable the auto-merge layer in an emergency.

For the design reasoning behind this policy, see `@docs/features/dependabot-auto-merge.md`.

## Layers

Three independent layers cooperate to produce auto-merge:

1. **Repo setting `allow_auto_merge=true`.** Permits anyone with write access to *request* auto-merge on a PR.
2. **Branch protection on `develop`.** Requires the four CI checks (`Lint, typecheck, build`, `Unit tests (SQLite)`, `Tests + coverage`, `Integration tests (Postgres)`) to pass before any merge — auto or manual. Required reviews: 0. Enforce-on-admins: off.
3. **Workflow `.github/workflows/dependabot-auto-merge.yml`.** Restricted to `pull_request_target` events from `dependabot[bot]` against `develop`. Reads update metadata via `dependabot/fetch-metadata` (SHA-pinned), applies the eligibility matrix, and on match calls `gh pr merge --auto --merge`. GitHub holds the merge until required checks pass.

## Eligibility Matrix

A Dependabot PR is auto-merged when the eligibility check matches.

**Eligibility check (auto-merge candidate):**

- `update-type` is `version-update:semver-patch` (any `dependency-type`, including `indirect`), OR
- `update-type` is `version-update:semver-minor` AND `dependency-type` is `direct:development`.

If the eligibility check passes, auto-merge. Otherwise, log a structured skip line and exit. There is no security-update override (owner decision: it would need a Dependabot-alerts token the project does not provision).

| `update-type` | `dependency-type` | Outcome |
|---|---|---|
| patch | any | auto |
| minor | `direct:development` | auto |
| minor | `direct:production` | manual |
| minor | `indirect` | manual |
| major | any | manual |

Grouped updates (per `.github/dependabot.yml`'s `groups` block) report the highest semver bump in the group. A group containing one minor and three patches reports `semver-minor`, which auto-merges only when the group is on `direct:development`.

## Boundary: Who Can Auto-Merge?

Auto-merge is restricted to:

- **`dependabot[bot]`**, via the workflow described above.
- **Trusted committers** (anyone with repo write access), via the standard GitHub "Enable auto-merge" UI or `gh pr merge --auto`. Branch protection still gates on CI green.

External contributors cannot trigger or request auto-merge:

- The workflow's actor gate fails closed for any actor that is not `dependabot[bot]`.
- GitHub's `allow_auto_merge` capability requires write access to *request* auto-merge — drive-by PRs from forks have no write access.

## Manual Review Path

For Dependabot PRs that the workflow logs `decision=skip`, the human review path is:

1. Read the upstream changelog or release notes linked in the PR body.
2. For prod-dep majors and prod-dep minors: check the call sites locally; for runtime libraries, smoke-boot the built server.
3. For tooling majors (TypeScript, `@types/node`): run `pnpm typecheck`, `pnpm lint`, `pnpm build` on the PR branch.
4. For security-related majors and prod-dep minors (which the workflow cannot identify as security updates): read the CVE advisory linked from the GitHub Security tab; merge if the fix is applicable and CI green; if the major version brings other breaking changes, prefer pinning at the prior major and pulling in the patched release on the prior major if available.

## CI Check Names

Branch protection's required-checks list pins these names exactly. If any CI job is renamed in `.github/workflows/ci.yml`, the protection rule must be updated in the same change, otherwise auto-merge will wait indefinitely for a check that will never report.

- `Lint, typecheck, build`
- `Unit tests (SQLite)`
- `Tests + coverage`
- `Integration tests (Postgres)`

## Emergency Disable (Kill Switches)

In increasing scope. Pick the tightest layer that resolves the situation.

1. **Tightest:** disable the workflow.
   - Quickest: change the top-level `if:` to `if: false` and push. Workflow stops; nothing else changes.
   - Or: delete `.github/workflows/dependabot-auto-merge.yml`.
   - Manual review continues normally; existing auto-merge requests on PRs already in flight will still complete when CI passes.

2. **Wider:** disable repo-level auto-merge.
   - `gh api --method PATCH repos/ribrewguy/openfga-node-server -F allow_auto_merge=false`
   - Stops auto-merge for ALL PRs, including any committer-queued auto-merge. Branch protection still in effect; CI still required.

3. **Widest:** remove branch protection on `develop`.
   - `gh api --method DELETE repos/ribrewguy/openfga-node-server/branches/develop/protection`
   - Restores pre-feature state entirely. Direct pushes to develop allowed again.

After resolving the underlying issue, re-enable in the reverse order (widest → tightest) and verify each layer behaves as expected before re-enabling the next.

## Operator Self-Test (Eligibility Matrix Walkthrough)

When changing this policy or the workflow, walk through these synthetic cases and confirm the workflow's eligibility step would log the expected decision:

| Synthetic case | `update-type` | `dependency-type` | Expected `decision` |
|---|---|---|---|
| Patch dev-dep bump | `version-update:semver-patch` | `direct:development` | `auto-merge` |
| Patch prod-dep bump | `version-update:semver-patch` | `direct:production` | `auto-merge` |
| Minor dev-dep bump | `version-update:semver-minor` | `direct:development` | `auto-merge` |
| Minor prod-dep bump | `version-update:semver-minor` | `direct:production` | `skip` |
| Minor indirect bump | `version-update:semver-minor` | `indirect` | `skip` |
| Major dev-dep bump | `version-update:semver-major` | `direct:development` | `skip` |

## Cross-References

- `@docs/features/dependabot-auto-merge.md` — design rationale, threat model, open questions.
- `@docs/policies/00-development-policy.md` — repository-wide development rules and CI requirements.
- `@docs/policies/commits.md` §"Dependabot Exception" — Beads-ID and commit-body waivers for `dependabot[bot]`-authored commits.
- `@docs/policies/branches-worktrees.md` §1 — branch hierarchy; clarifies that `main` does not receive auto-merged Dependabot PRs (only approved PRs from `develop`).
