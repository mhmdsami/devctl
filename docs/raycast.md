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
- **Agent Sessions**: claude, codex, opencode, and pi sessions grouped by stack, with Copy Resume
  Command and Copy Session ID.
- Keyboard: `enter` services, `cmd+return` start and stop, `cmd+r` restart, `cmd+e` edit,
  `cmd+d` delete, `cmd+f` focus, `cmd+c` agent context.

## Developing safely

Raycast stores a SHA-256 digest for every installed entry point. Editing or copying files into
`~/.config/raycast/extensions/<uuid>` makes Raycast reject the extension with "The entry point
file appears to be corrupted", and the original store files cannot be rebuilt byte for byte.

- Run `npm run dev` (or `npx ray develop`) from `raycast/`. It builds to the dev copy at
  `~/.config/raycast/extensions/devctl` and watches for changes.
- Do not copy a build into a UUID extension folder. Do not edit files there.
- If a store version of Devctl is installed, it shadows the dev copy. Uninstall the store
  version while developing, then install the released version again when done.
- To verify a bundle without installing it, run `npx ray build -e dist -o /tmp/devctl-dist`.
- Recovery from a hand-edited store extension: uninstall it in Raycast, then reinstall it, or
  use the dev copy. There is no supported way to repair the digest in place.

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
