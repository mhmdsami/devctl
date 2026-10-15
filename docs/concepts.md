# Concepts

devctl runs local services as git worktrees. A few terms come up everywhere.

- **service**: one entry under `services` in the config. It points at a repo under `reposRoot`.
- **worktree**: a git worktree of that repo. `head` is the repo's own checkout. Every other
  worktree is named after the branch it holds.
- **stack**: the same worktree name used across services, such as `ft-my-feature` in api, web,
  and admin. One name, one feature. `devctl stack up ft-my-feature` starts all of them.
- **port**: pinned per worktree. `head` keeps the service's `basePort`, and each other worktree
  gets the next free slot the first time devctl sees it, then keeps it. Adding or removing a
  worktree never moves another one's port.
- **shared service**: runs once instead of per worktree, and has no branch or target. `mongo` is
  the usual example. Start it with `devctl up mongo`, or let the graph pull it in when a
  dependent starts.

A service is addressed as `<service>/<worktree>`, for example `web/ft-my-feature`. Reach it at
`http://localhost:<port>`, or at a named URL if portless is on (see [Named URLs](portless.md)).

## State

`~/.devctl/state.json` holds running services, the env mode, stack definitions, per-service
targets, and worktree port slots. It is safe to delete. If a process outlives its state entry,
for example after the terminal manager restarts, the next `up` adopts it back by worktree path,
so ownership and stopping keep working.

## Processes

Services run in the terminal manager (herdr) by default, each in its own tab. Set
`herdr.enabled` to `false` in the config to run plain detached processes instead.
