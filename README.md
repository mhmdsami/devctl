# devctl

Effortless local orchestration for any set of repos - **stack-first**, wired by a dependency graph.

A **stack** is a full dev environment for a feature: one worktree id across all services
(worktrees are created on a branch of the same name), plus an optional display name (label)
shown in the UI. `devctl stack up ft-my-feature` starts every worktree matching the stack id,
each on its own port, wired to the services it depends on. Multiple stacks run simultaneously -
ports are per-worktree, so they never collide.

## Commands

```
devctl up [stack | <service>/<worktree> | --all] [--force] [--dry-run] [--json] [--quiet]
devctl down [stack | <service>/<worktree> | --all] [--force] [--json]
devctl kill [--yes] [--force] [--json]   # kill switch: everything, with confirmation
devctl restart <stack | <service>/<worktree>> [--force]
devctl status [--json] [--check]
devctl which [--json]
devctl env test|prod [--force] [--json]  # switch external API mode
devctl env show <service>[/<worktree>] [--stack <name>]   # effective env, with provenance
devctl env set|unset <service> KEY[=VALUE] [--stack <name>]   # stack override, layered last
devctl env edit <service> [--stack <name>]
devctl use <service> <worktree|test|prod> [--force] [--json]
devctl stack delete <name> [--keep-worktrees]  # stops members and removes their worktrees (branches kept)
devctl logs <service>/<worktree> [--lines N] [--follow]
devctl config show [--json]              # resolved config, secrets redacted
devctl config get <path>                 # read one value, e.g. debug.model
devctl config set <path> <value>         # write one value; validated before saving
devctl context [stack]                   # markdown status of a stack, for agents
devctl diagnose <service>/<worktree>     # hand a service's recent logs to the debug agent
devctl doctor [--json]                   # config, binaries, ports, env files, stale state, branch conflicts
devctl attach [workspace]
devctl portless on|off|status              # start/stop the portless proxy (named URLs), show routes
devctl completion bash|zsh
```

Args are strict: unknown options are rejected with a pointer to `devctl <cmd> --help`.
Global `--no-color` and `--quiet` work anywhere. Mutation commands accept `--json` for
machine-readable results. `up` prints a final summary: started / reused / restarted / failed.
Add `eval "$(devctl completion zsh)"` (or the bash variant) to your shell rc for completions.

Shared services (e.g. `mongo`) are not stack members and never appear in `which`,
`stack add/create`, or the Raycast form - they are not things with branches and
targets. Start/stop them directly with `devctl up mongo` / `devctl down mongo`, or
let the graph start them whenever a dependent service comes up.

## Nomenclature

Everything is `<service>/<worktree-name>` - e.g. `web/ft-my-feature`. The repo root working
tree is called `head` (it holds whatever the repo's current HEAD is). Ports are pinned per
worktree: `head` keeps the service's `basePort`, and every other worktree is assigned the
next free slot the first time devctl sees it, then remembered in state. Adding or removing
worktrees never moves an existing one's port. Named URLs follow:
`https://<branch>.<service>.localhost:1355` (`main`/`master` branches get the bare
`https://<service>.localhost`).

## Config

`devctl.config.json` (copy `devctl.config.example.jsonc` to start). There are no hardcoded
roles - services form a **dependency graph**:

- `provides` - values a service exposes when it runs locally (templates with `${port}`, `${inspectPort}`,
  `${dnsName}`, `${portlessUrl}`, `${origin}`)
- `origin` - the service's public URL: `https://<dnsName>.localhost` when portless is on,
  `http://localhost:<port>` when it is off or not installed, so links work either way
- `remoteProvides` - where those values come from when dependents target `test`/`prod` (read from a service's env base file)
- `wiring` - `"ENV_KEY": "<service>.<value>"` - injects a provided value into the consumer's env; each entry is a graph edge
- `dependsOn` - extra edges without env wiring (startup order only)
- `shared: true` - one instance instead of per-worktree: fixed `basePort`, no worktrees,
  `command` brings it up (idempotent is fine), optional `stopCommand` tears it down.
  Health is port-based unless you set `healthCommand` (e.g. a mongosh ping), which must exit 0. `devctl down <name>` runs `stopCommand`; the port is never
  orphan-killed for shared services. There can be any number of shared services
  (`mongo`, `redis`, `sqs`, …) - dependents pick exactly the ones they need.
  Shared services are infra, not stack members: they never take branch/test/prod
  targets and only join the graph through other services' `dependsOn`/`wiring`
- `envExternals` - per-mode env overrides applied to this service when it runs

Dependencies follow what actually runs: a service targeting a remote (`test`/`prod`)
provider brings up nothing locally - the remote instance runs its own infra. Local
providers pull in their own deps recursively, so a local api starts the dbs it
declares, and nothing else does.

Startup order, shared-infra bring-up, env wiring, and restarts on `env`/`use` are all
derived from the graph. Onboarding a new service is one entry; adding a new dependency is
one `wiring` line. Cycles are rejected at config load.

```jsonc
{
  "reposRoot": "~/dev",
  "herdr": { "enabled": true, "workspace": "servers" },   // set enabled:false to run plain detached processes
  "debug": {                                             // optional: on start failure, hand the logs to an agent
    "enabled": true,                                     // skipped in --quiet/--json runs
    "provider": "opencode-go",                           // model selection lives here, or set "command" outright
    "model": "omen-alpha",
    "command": "pi --provider opencode-go --model omen-alpha -p --no-session"
  },
  "envBaseFiles": { "local": ".env.development", "test": ".env.test", "prod": ".env.production" },
  "services": {
    "mongo": {                             // shared infra - any command, not just docker compose;
      "repo": "my-infra",                  // as many of these as you need
      "basePort": 27017,                   // health-checked port
      "shared": true,
      "command": "docker compose -f docker-compose.shared.yml up -d mongo1 mongo2 mongo3 mongo-setup",
      "stopCommand": "docker compose -f docker-compose.shared.yml stop mongo-setup mongo3 mongo2 mongo1",
      "healthTimeoutMs": 90000
    },
    "redis": {
      "repo": "my-infra",
      "basePort": 6379,
      "shared": true,
      "command": "docker compose -f docker-compose.yml up -d redis",
      "stopCommand": "docker compose -f docker-compose.yml stop redis",
      "healthTimeoutMs": 30000
    },
    "my-api": {
      "repo": "my-api",                  // dir under reposRoot
      "basePort": 5000,                  // per-worktree: +10, +11 …
      "command": "./node_modules/.bin/mydev -p ${port}",
      "env": { "MY_FLAG": "1" },         // ${port}/${inspectPort}/${dnsName}/${portlessUrl}/${origin} interpolated
      "healthTimeoutMs": 120000,
      "install": "pnpm install",         // optional; auto-detected from the lockfile otherwise
      "dependsOn": ["mongo", "redis"],   // exactly the shared services this one needs
      "provides": { "url": "http://localhost:${port}/api", "key": "…" },
      "remoteProvides": {                // test/prod values, read from <from>'s env base file
        "url": { "from": "my-frontend", "envKey": "API_URL" }
      },
      "envExternals": { "test": { "EXT_BASE_URL": "https://test.example.com" } }
    },
    "my-frontend": {
      "repo": "my-frontend",
      "basePort": 5100,
      "command": "./node_modules/.bin/next dev -p ${port}",
      "healthTimeoutMs": 150000,
      "wiring": { "API_URL": "my-api.url", "API_KEY": "my-api.key" },
      "overlayManagedKeys": ["API_URL", "API_KEY"]   // merged values force-exported in the pane
    }
  }
}
```

- dependents get a `.env.local` overlay built from the mode's base env file, pointing at
  their targets; managed values are force-exported in the pane
- worktrees missing gitignored env files are seeded from the repo's current HEAD on `up`; the same applies to other gitignored root-level files (`.npmrc`, `.yarnrc.yml`, ...) so installs authenticate in fresh worktrees
- a worktree without `node_modules` gets dependencies installed before start (detected
  from the lockfile, or the service's `install` command)
- a failed start fails fast: the entry is cleaned up and, if `debug` is enabled, an
  agent diagnoses the log output
- `devctl diagnose <service>/<worktree>` runs that agent on demand (running, failed, or
  stopped) and prints ROOT CAUSE / FIX; the Raycast panel and menubar expose it for
  running and failed services
- `devctl use <service> <target>` retargets every service that depends on it; stack
  member overrides still win
- per-service env is layered: the mode base file (`.env.test`), then `services.<x>.env`, then
  `envExternals.<mode>`, then `wiring` (via `.env.local`), then the stack override file
  `~/.devctl/env/<stack>/<service>.env`. `devctl env show <service>[/<worktree>]` prints the
  result with the source of every key; `devctl env set|unset|edit` maintain the override file
- `${dnsName}` is the service's portless name (`<branch>.<service>`). Use `${origin}` when a
  service publishes its own URL (`PAYLOAD_PUBLIC_SERVER_URL: "${origin}"`) so it stays same-origin
  when browsed through portless - no CORS - and falls back to `http://localhost:<port>` when
  portless is off
- portless is optional and ships as an optional dependency (needs Node 24+). `devctl portless on`
  starts the proxy and registers a route per running service; `off` stops it and reverts URLs to
  localhost ports; `status` shows the mode, proxy, and routes. Without a usable portless, devctl
  uses plain ports

## Raycast extension

`cd raycast && npm install`, then run `npm run dev` (registers with the Raycast app)
or import the folder.

- **Dev Stacks** (menubar): health-aware stack counts, open/copy URLs, recent logs, start/stop, env switch
- **Manage Stack**: create/start/stop/restart/delete stacks, failed-first ordering, status age,
  Copy Agent Context (markdown status for pasting into an agent)
- **Stack services** (detail pane): per-service state, open URL, copy URL, recent logs,
  follow logs in Terminal, reveal worktree in Finder, open in editor, restart
- **Create / Edit Stack**: asks for the stack's display name and its id (the shared branch /
  worktree the stack is built on), creates missing worktrees, picks a source per service
  (head / worktree / test / prod), confirms removed members; every mutation runs as a
  self-dismissing toast
- stack keyboard map: `enter` services, `cmd+return` start/stop, `cmd+r` restart,
  `cmd+e` edit, `cmd+d` delete, `cmd+f` focus, `cmd+c` agent context
- **Switch Env**: test / prod (defaults to test)

## Releasing the extension

Releases leave no trace in git history: no bump commit, no changelog commit. The version and
notes are inputs to the workflow, and the tag records the release.

1. GitHub -> Actions -> "Release Raycast Extension" -> Run workflow
2. Enter the version (e.g. `1.0.6`) and release notes
3. The workflow writes the version into `raycast/package.json` inside the runner only, publishes
   to the team store, pushes the `vX.Y.Z` tag, and opens a GitHub release with your notes

`raycast/package.json` keeps `0.0.0-semantically-released` as its committed version, marking that
releases own the version. The released version lives in the tag, the GitHub release, and the store.
The workflow refuses a version that is already tagged.

## State

`~/.devctl/state.json` - running services, env, stack defs, per-service targets,
worktree port slots. Safe to delete.

If a service's process outlives its state entry (for example the terminal manager
restarted and the entry was cleaned up), the next `up` adopts the process back - it is
recognised by its worktree path and recorded with its pid and start token, so ownership
and stopping keep working.
