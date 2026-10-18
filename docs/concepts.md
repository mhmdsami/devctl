# Concepts

devctl runs local services as git worktrees. A few terms come up everywhere.

- **service**: one entry under `services` in the config. It points at a repo under `reposRoot`.
- **worktree**: a git worktree of that repo. `head` is the repo's own checkout. Every other
  worktree is named after the branch it holds.
- **stack**: the same worktree name used across services, such as `ft-my-feature` in api, web,
  and admin. One name, one feature. `devctl stack up ft-my-feature` starts all of them.
- **port**: portless owns it by default, and devctl reads the chosen port back from
  `portless list`. A fixed-port service (one whose templates use `${port}`) keeps the service's
  `basePort`, and each other worktree gets the next free slot the first time devctl sees it.
- **shared service**: runs once instead of per worktree, and has no branch or target. `mongo` is
  the usual example. Start it with `devctl up mongo`, or let the graph pull it in when a
  dependent starts.

A service is addressed as `<service>/<worktree>`, for example `web/ft-my-feature`. Reach it at
`https://<worktree>.<service>.localhost` (see [Named URLs](portless.md)); fixed-port services also
answer at `http://localhost:<port>`.

## State

`~/.devctl/state.jsonl` is an append-only log that holds stack definitions, the env mode,
per-service targets, linked agent sessions, and the runtime cache. Each change appends a small
record, so the CLI and the Raycast poller can write at the same time without clobbering each
other. A corrupt record is quarantined to `state.jsonl.corrupt-<timestamp>` and the log keeps its
good prefix. It is safe to delete. If a process outlives its entry, for example after the terminal
manager restarts, the next `up` adopts it back by worktree path, so ownership and stopping keep
working.

## Processes

Services run in the terminal manager (herdr) by default, each in its own tab. Set
`herdr.enabled` to `false` in the config to run plain detached processes instead.
