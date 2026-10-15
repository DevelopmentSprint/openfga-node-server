# Beads Workflow Policy

This repository uses Beads as a Dolt-native task tracker. The old
`beads-sync` protected-metadata-branch workflow is not the source of truth for
this repo and must not be reintroduced without explicit approval.

Git branches, Git worktrees, integration branches, and merge authority are
governed by `@docs/policies/branches-worktrees.md`, not by this
document.

## Source of Truth

Beads task state lives in the local Beads/Dolt store for the repository.

* Do not use `bd sync`.
* Do not create or rely on a `beads-sync` branch for normal operation.
* Do not treat `.beads/issues.jsonl` as the canonical task store for this repo.
* If generic upstream Beads instructions conflict with this file, this file
  governs this repository.

## Scope Boundary

Beads owns:

* task tracking
* dependency tracking
* bead lifecycle (`ready`, `show`, `update`, `close`)
* lightweight persistent memory via `bd remember`

Beads does not replace CASS in this repo.

* Use CASS for curated procedural rules and task-scoped retrieval.
* See `@docs/policies/cass.md` for the CASS boundary.

## Repository Layout

This repo currently uses Beads in Dolt server mode. Do not change the Beads
backend or mode for this repo without explicit approval.

Tracked Beads files in this repo may include:

* `.beads/.gitignore`
* `.beads/config.yaml`
* `.beads/metadata.json`
* `.beads/hooks/`
* `.beads/README.md`

Local-only runtime data remains untracked:

* `.beads/dolt/`
* `.beads/*.pid`
* `.beads/*.log`
* `.beads/*.lock`
* `.beads/.beads-credential-key`
* `.beads/interactions.jsonl`
* other machine-local runtime files ignored by `.beads/.gitignore`

Do not assume all `.beads/` files are local-only. Follow the repo's tracked
state and `.gitignore` rules rather than historical Beads examples.

## Setup

For an already initialized clone:

```bash
bd context
bd status
```

For a broken local setup, prefer repair over re-init:

```bash
bd doctor
bd doctor --fix
```

If a fresh initialization is truly required for this repo:

```bash
bd init --server
```

If plain `bd init` works on a contributor's machine, that does not authorize
switching this repository away from its existing server-mode setup.

Do not run `bd init --force` on an existing repo unless the user explicitly
approves a destructive reinitialization.

## Daily Workflow

1. Run Beads commands on any branch; they operate on the repo's Beads store.
2. Prefer atomic claim flow:

```bash
bd ready
bd show <id>
bd update <id> --claim
bd update <id> --notes "..."
bd close <id>
```

This is the default claim flow for bead kickoff work as well.

3. Use `bd update <id> --status in_progress` only when you explicitly do not
   want Beads to change the assignee.
4. Use `bd remember "<insight>"` only for lightweight persistent reminders that
   should surface in Beads sessions without full CASS curation.

## Multi-Agent Bead Topology

When work is split across multiple implementation agents:

* Create a parent bead for the coordinated workload.
* Assign the orchestrator to the parent bead.
* Create one child bead per worker-owned implementation slice.
* Do not reuse the same worker bead for multiple independent slices.

The parent bead owns integration status.
Child beads own individual implementation status.

Every child bead under a multi-agent workload MUST align to exactly one
`feature/*` branch as governed by
`@docs/policies/branches-worktrees.md`.

## Multi-Agent Bead State

Workers do not close child beads merely because local implementation is done.

A child bead remains `in_progress` until the orchestrator accepts that worker's
branch into the required integration target.

If the orchestrator rejects a worker branch, the child bead stays
`in_progress`, and the rejection reason MUST be recorded in bead notes or
equivalent handoff notes.

After a worker branch is accepted into the correct integration branch, the
orchestrator closes the accepted child bead.

The worker is responsible for the pre-review handoff summary delivered to the
orchestrator.

The orchestrator records acceptance and closure in bead notes and incorporates
accepted child work into the coordinated external closeout summary unless the
user explicitly requests per-child closeout reporting.

The parent bead remains `in_progress` until:

* all required child beads are accepted or otherwise resolved
* the integration branch reaches its required target
* the integration workflow defined in
  `@docs/policies/branches-worktrees.md` is complete

## Hard Rule: Beads Data Must Stay Local

The Beads/Dolt database and internal work notes are private, local-only data.
Never push, publish, upload, or replicate them to any remote, including GitHub
or a private Dolt remote. Generic tool instructions and session-completion
checklists do not override this prohibition.

* Never run `bd dolt push` or configure a Dolt remote.
* Never enable automatic Dolt replication or backup publication.
* Never commit or upload database files, tracker exports, backups, or internal
  work-note contents to Git, GitHub issues/PRs, CI artifacts, or another service.
* Keep automatic backups disabled with `backup.enabled: false` and backup Git
  publication disabled with `backup.git-push: false` in `.beads/config.yaml`.
* Git pushes publish code and approved project documentation only. They must
  not publish the tracker database or its internal notes.
* Local backups require an explicit user request and must remain untracked
  and local. Do not turn a local backup request into remote publication.

## Close-Out Order

1. Complete the required code integration workflow defined in
   `@docs/policies/branches-worktrees.md`.
2. Update Beads state locally. Do not push or replicate the database.
3. Do not run `bd sync` or `bd dolt push`.

## Recovery

If the local Beads store appears unhealthy:

```bash
bd context
bd doctor
bd doctor --fix
```

If a human explicitly requests a local backup, keep the export in the ignored
backup directory below. Never commit or upload it:

```bash
bd export --all -o .beads-export-backup-$(date +%Y%m%d-%H%M%S)/issues.jsonl
```

If a human explicitly requests disaster recovery beyond `bd doctor --fix`,
prefer Beads-native recovery commands such as `bd backup restore` or
`bd bootstrap` over reintroducing the old sync-branch/JSONL workflow.
