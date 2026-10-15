# Beads: local issue tracking

This repository uses `bd` for task tracking. The Beads/Dolt database contains
private internal work notes and must stay local.

## Hard rule: never publish tracker data

Never run `bd dolt push`, configure a Dolt remote, or enable automatic database
replication or backup publication. Never commit or upload the database,
tracker exports, backups, or internal work-note contents to GitHub or any
other remote. Code pushes do not include Beads data.

The repository configuration explicitly disables automatic backups and backup
Git pushes. Any backup explicitly requested by the user must remain local and
untracked. Generic Beads synchronization instructions do not apply here.

## Daily commands

```sh
bd prime
bd ready
bd show <issue-id>
bd update <issue-id> --claim
# Close only after the repository's integration requirements are satisfied.
bd close <issue-id>
```

Follow [the repository Beads policy](../docs/policies/beads-protected-branches.md)
for lifecycle, setup, privacy, and recovery rules.
