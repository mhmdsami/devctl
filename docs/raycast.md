# Raycast extension

```sh
cd raycast && npm install && npm run dev
```

- **Dev Stacks** (menubar): stack health, open and copy URLs, recent logs, start and stop, env
  switch, portless status.
- **Manage Stack**: create, start, stop, restart, and delete stacks, plus Copy Agent Context.
- **Stack services** (detail pane): per-service state, open and copy URL, logs, follow in
  Terminal, reveal in Finder, open in editor, restart, and diagnose.
- **Create / Edit Stack**: choose a source per service (head, a worktree, test, prod), create
  missing worktrees, and confirm removed members.
- **Switch Env**: test or prod.
- Keyboard: `enter` services, `cmd+return` start and stop, `cmd+r` restart, `cmd+e` edit,
  `cmd+d` delete, `cmd+f` focus, `cmd+c` agent context.

## Releasing

Releases leave no trace in git history. The workflow takes the version and notes as inputs and
records them in a tag.

1. GitHub -> Actions -> "Release Raycast Extension" -> Run workflow.
2. Enter the version (for example `1.0.7`) and the notes.
3. The workflow stamps the version in the runner, publishes to the team store, pushes the
   `vX.Y.Z` tag, and opens a GitHub release.

`raycast/package.json` keeps `0.0.0-semantically-released` to mark that releases own the
version. The released version lives in the tag, the GitHub release, and the store. The workflow
refuses a version that is already tagged.
