# Dependabot Auto-Merge

## Status

Proposed. Tracked in Beads issue `openfga-aun`.

## Source of Truth

- Beads: `openfga-aun` — "Wire Dependabot auto-merge for low-risk dependency PRs".
- Policy stack: `docs/policies/00-development-policy.md` §4 ("CI Requirements"), `docs/policies/commits.md` §"Dependabot Exception", `docs/policies/branches-worktrees.md` §1 (branch hierarchy).
- Existing CI: `.github/workflows/ci.yml`, `.github/dependabot.yml`.

The PRD does not address developer-tooling automation. This feature exists at the operational layer and does not change product behavior or product scope.

## Business Intent

Dependabot opens dependency-update PRs on a weekly cadence (npm, github-actions). Today every PR — including patch bumps and dev-dependency churn — requires a maintainer to review and click merge. The hand-driven sweep is recurring labor with low information value when CI is already gating regressions. The conservative classes of update (patch, dev-dep minor) carry near-zero risk at CI green and benefit from landing fast without ceremony. Riskier classes (any major, prod-dep minor) continue to need human eyes.

This feature wires three independent layers — repo settings, branch protection, and a workflow — that together cause low-risk Dependabot PRs to merge on their own once CI passes, while leaving the rest of the merge surface unchanged.

## Goals

- Auto-merge PRs from `dependabot[bot]` that match a conservative eligibility matrix, after required CI checks pass.
- Require CI to pass on every PR into `develop`, regardless of author. The auto-merge feature reuses this gate; it does not introduce a separate one.
- Restrict the auto-merge capability to `dependabot[bot]` and trusted committers (anyone with repo write access). External contributors cannot trigger or request auto-merge.
- Keep three independent kill switches available so a panicked operator can disable auto-merge at the tightest scope first.
- Keep merge commits authored by `dependabot[bot]` so the `commits.md` "Dependabot Exception" (Beads-ID and multi-paragraph-body waiver) continues to apply.

## Non-Goals

- Do not auto-merge any major version bump.
- Do not auto-merge any minor or major bump on a direct production dependency.
- Do not gate on whether a PR is a security update. Detecting that needs `dependabot/fetch-metadata`'s `alert-lookup`, which requires a token with Dependabot-alerts read access that the project does not provision (owner decision, accepted gap). Eligibility depends only on `update-type` and `dependency-type`, so a security update of an eligible class auto-merges like any other, and a security update of an ineligible class (for example a major) stays manual because of its class.
- Do not auto-merge into `main`. `main` continues to receive only approved PRs from `develop` (per `branches-worktrees.md` §1) or explicitly approved hotfixes.
- Do not enforce branch protection on `main` as part of this feature. Promotion to `main` remains a separate gated activity.
- Do not require pull-request reviews on `develop`. Auto-merge fires on CI green; trusted committers self-merge their own PRs.
- Do not page on missed auto-merges, build a dashboard of Dependabot velocity, or add canary deploys. Those are larger scope and out of band.
- Do not add unit-test infrastructure for the workflow. Validation is observational on live Dependabot PRs.

## Architecture & Topology

Three independent layers cooperate:

1. **Repo setting** — `allow_auto_merge=true`. Permits any user with write access to *request* auto-merge on a PR.
2. **Branch protection on `develop`** — requires the four existing CI checks to be green before any merge. Enforces the gate uniformly; auto-merge inherits it. Excludes administrators so the documented hotfix-exception path in `branches-worktrees.md` §1 and `commits.md` §"Push/Merge Discipline" remains usable without a protection-bypass dance.
3. **Workflow `.github/workflows/dependabot-auto-merge.yml`** — runs on `pull_request_target` for PRs authored by `dependabot[bot]` against `develop`. Reads update metadata via `dependabot/fetch-metadata`. On eligibility-matrix match, calls `gh pr merge --auto --merge`. GitHub holds the merge until required checks pass.

The workflow *requests* auto-merge; branch protection *enforces* CI; GitHub Actions *executes* the merge. Each layer is independently auditable and reversible.

## Components

### Repo settings

One-time API change:

- `allow_auto_merge=true`.
- `delete_branch_on_merge=false` (current value, unchanged).

### Branch protection on `develop`

One-time API change:

- Required status checks (strict mode on, names must match CI job names exactly):
  - `Lint, typecheck, build`
  - `Unit tests (SQLite)`
  - `Tests + coverage`
  - `Integration tests (Postgres)`
- Required pull-request reviews: 0.
- Enforce on admins: off.
- Allow force-pushes: off.
- Allow branch deletions: off.
- Require linear history: off (the project uses merge commits).

### Workflow `.github/workflows/dependabot-auto-merge.yml`

- Trigger: `pull_request_target`, types `[opened, reopened, synchronize, ready_for_review]`.
- Top-level `if:` gate: `github.actor == 'dependabot[bot]' && github.event.pull_request.base.ref == 'develop'`.
- Permissions: top-level `permissions: {}`; job-level `pull-requests: write` and `contents: write`. No other scopes.
- Concurrency group: `dep-automerge-${{ github.event.pull_request.number }}` with `cancel-in-progress: true`.
- Steps:
  1. Belt-and-suspenders actor recheck (`if: github.actor == 'dependabot[bot]'`). Fails closed if somehow reached without Dependabot.
  2. `dependabot/fetch-metadata@<sha-pin>` (40-char commit SHA, version in a comment for human readability). Outputs `update-type`, `dependency-type`, `package-ecosystem`. `alert-lookup` is not enabled.
  3. Eligibility decision. Composite condition over the metadata outputs (matrix below).
  4. On match: `gh pr merge --auto --merge "$PR_URL"`. On no-match: log a structured decision line (PR number, update-type, dependency-type, skip reason) and exit 0.
- No `actions/checkout` step. The workflow does not access PR-head code under any circumstance.
- No use of `secrets.*`.

### Policy doc `docs/policies/dependabot.md`

New file. Documents:

- The eligibility matrix (verbatim from this spec).
- The decision not to special-case security updates.
- The three-layer kill-switch hierarchy and recommended order.
- The branch-protection contract (required checks list, what happens if a check is renamed).
- The "restricted to Dependabot and trusted committers" boundary.
- A self-test table tracing each matrix row through `fetch-metadata` outputs.
- Cross-links from `docs/policies/00-development-policy.md` §3 and `docs/policies/commits.md` §"Dependabot Exception".

## Eligibility Matrix

A Dependabot PR is auto-merged when the eligibility check matches.

**Eligibility check (auto-merge candidate):**

- `update-type` is `version-update:semver-patch` (any `dependency-type`, including `indirect`), OR
- `update-type` is `version-update:semver-minor` AND `dependency-type` is `direct:development`.

If the eligibility check passes, auto-merge. Otherwise, log a structured skip line and exit. There is no security-update override: see Non-Goals.

**Truth table** (all relevant combinations):

| `update-type` | `dependency-type` | Outcome | Reason |
|---|---|---|---|
| patch | any | auto | eligibility: patch |
| minor | `direct:development` | auto | eligibility: dev-dep minor |
| minor | `direct:production` | manual | not eligible |
| minor | `indirect` | manual | not eligible (indirect ≠ development) |
| major | any | manual | not eligible: major |

Grouped updates (per `dependabot.yml`'s `groups` block) report the highest semver bump in the group as the group's `update-type`. A group containing one minor and three patches reports `semver-minor`, which only auto-merges if the group's `dependency-type` is `direct:development`.

## Security Hardening (Public Repo)

The repository is public. The threat model includes external contributors opening PRs that could attempt to escalate via `pull_request_target` or trick a workflow into running attacker-controlled code with write permissions.

Defenses:

- **Trigger-level actor gate.** Top-level `if:` blocks the workflow from starting unless `github.actor == 'dependabot[bot]'` and the base branch is `develop`. External contributor PRs do not start the workflow.
- **Job-level actor recheck.** Defense in depth.
- **Workflow file always read from base.** `pull_request_target` runs the workflow definition from the base branch, not from the PR head. PR-side workflow tampering is impossible.
- **No PR-head checkout.** No `actions/checkout` of `${{ github.event.pull_request.head.sha }}`. The workflow operates entirely against the GitHub API. The classic `pull_request_target` code-execution vector (running attacker-controlled `npm install`, `npm test`, etc. with write tokens) is removed by construction.
- **SHA-pinned third-party actions.** `dependabot/fetch-metadata` pinned by 40-char commit SHA, with the human-readable version in a trailing comment. Tag-poisoning attacks (re-pointing `v2` at malicious commit) are eliminated. Future updates to the pin arrive via a normal Dependabot PR and follow the manual-review path.
- **Minimal token scopes.** Top-level `permissions: {}`; only `pull-requests: write` and `contents: write` granted at the job. No `id-token`, `actions`, `packages`, `deployments`, `issues`.
- **No PR-controlled values reach shell commands unsanitised.** Only structured `fetch-metadata` outputs are used in `if:` expressions.
- **Branch protection blocks merge-while-red.** A maintainer cannot accidentally merge a failing PR even outside the auto-merge path.
- **`allow_auto_merge=true` requires write access.** External contributors cannot request auto-merge on their own PRs.

Out of scope (not addressed by this feature):

- Insider threat: a maintainer with write access voluntarily marking a malicious PR for auto-merge.
- Compromised `GITHUB_TOKEN` from a separate workflow on the repo.
- Compromised Dependabot identity itself.

## Failure Modes & Operational Behavior

| Failure | System behavior | Operator action |
|---|---|---|
| CI fails on a Dependabot PR | GitHub holds auto-merge indefinitely; PR stays open | Triage like a manual review; close, pin, or push retrigger commit |
| Workflow itself errors transiently | Auto-merge not requested; behaves like the workflow never ran | None; rebase or self-merge on next cycle |
| Eligibility matrix says no | Workflow logs decision and exits 0; PR stays open | Manual review path |
| Required check renamed or removed | Auto-merge waits forever for a missing check | Update the protection rule's required-check list |
| CI green on a regression tests don't cover | Bug lands on `develop` | Catch on develop-to-main promotion review; release-branch ceremony provides the backstop |

### Emergency disable (kill switches, in increasing scope)

1. **Tightest:** delete `.github/workflows/dependabot-auto-merge.yml` or set its `if: false`. Auto-merge stops; everything else continues.
2. **Wider:** `gh api --method PATCH repos/{owner}/{repo} -F allow_auto_merge=false`. Disables auto-merge for all PRs (including any committer-queued auto-merge). Branch protection still in effect.
3. **Widest:** delete the branch protection rule on `develop`. Restores pre-feature state entirely.

`docs/policies/dependabot.md` lists these in this order so a panicked operator picks the tightest scope first.

## Verification

### Pre-deployment

- `actionlint` (or equivalent) clean on `dependabot-auto-merge.yml`.
- `gh api repos/{owner}/{repo}` shows `allow_auto_merge=true`.
- `gh api repos/{owner}/{repo}/branches/develop/protection` shows the four required checks listed verbatim.
- Manual matrix walkthrough: each row of the eligibility matrix evaluates correctly against synthetic `fetch-metadata` outputs (documented in `dependabot.md`).

### Live (post-deployment, observational)

- First Dependabot PR after deployment: workflow runs, logs match expected decision, PR auto-merges on CI green (eligible) or stays open (ineligible).
- An ineligible (e.g. major-bump) Dependabot PR confirms the skip-reason log path and stays open for manual review.
- An external-contributor PR (or a no-op PR from a non-Dependabot account) confirms the workflow does not start the merge path. PR stays open requiring manual review.
- A red-CI PR confirms branch protection blocks the merge button entirely.

### Ongoing

- Spot-check Dependabot PR queue weekly for the first two weeks; monthly thereafter.
- Investigate any auto-merge that should not have fired, or any eligible PR that did not.

## Acceptance Criteria

- `allow_auto_merge=true` on the repo.
- Branch protection on `develop` requires the four existing CI checks to pass; admin enforcement is off; required reviews is 0.
- `.github/workflows/dependabot-auto-merge.yml` exists, restricted to `dependabot[bot]`, with SHA-pinned `dependabot/fetch-metadata`, no PR-head checkout, and `permissions:` scoped to `pull-requests: write` and `contents: write` only.
- Workflow merges PRs whose `update-type` and `dependency-type` match the eligibility matrix, and logs a structured skip line for those that do not.
- Merge style is `--merge` (merge commit), preserving `dependabot[bot]` authorship and the `commits.md` exemption.
- `docs/policies/dependabot.md` exists and documents the matrix, kill switches, branch-protection contract, and the trusted-committer boundary.
- `docs/policies/00-development-policy.md` and `docs/policies/commits.md` cross-link to the new policy.
- A live Dependabot PR (any class) proves at least one matrix row end-to-end after deployment.

## Open Questions

- **Indirect-dep grouping.** When a transitive bump is grouped with a direct dev-dep bump, the group reports `direct:development` and the matrix auto-merges. Is that the intended semantic, or should grouped indirect bumps fall to manual?
- **Dependabot rebase storms.** When auto-merge is enabled across many open Dependabot PRs simultaneously (as may happen the first Monday after this lands), rebase chains can produce many CI runs. Worth observing the first cycle and possibly tuning `open-pull-requests-limit`.
- **Re-evaluation cadence.** Should the matrix be revisited after 90 days of operation? Two weeks of "auto-merge worked correctly N times" is anecdotal, not statistical.
