# Set up devctl with an agent

This is a runbook for a coding agent. Give it to your agent, and it will find your repos, ask
which ones belong to devctl, propose the service graph, write the config, and verify the first
stack.

## Prompt to give your agent

> Read `docs/setup-with-an-agent.md` in the devctl repo and follow it. Find my git repos, ask me
> which ones to set up, propose the services and the graph, write `devctl.config.json`, then run
> `devctl doctor`, `devctl up --dry-run`, and a smoke `devctl up`. Ask before starting anything
> heavy or destructive. Do not edit my repos or commit anything.

## 1. Prerequisites

Check, and install or report what is missing:

```sh
git --version
node --version          # devctl needs Node 24+
pnpm --version          # corepack enable
herdr --version         # optional, runs services in tabs
devctl --version
```

Install devctl if needed:

```sh
curl -fsSL https://raw.githubusercontent.com/mhmdsami/devctl/main/install.sh | sh
devctl doctor
```

portless is a devctl dependency and the proxy starts on demand. Docker is only needed for services
that run containers.

## 2. Find the repos

Ask the user for their repos root. Common choices are `~/dev`, `~/code`, `~/src`, and
`~/projects`. Do not scan the whole home directory.

List git repositories a few levels deep, then show the candidates:

```sh
ROOT=~/dev   # use the path the user gives you
find "$ROOT" -maxdepth 3 -name .git -type d -prune | sed 's#/.git$##' | sort
```

Ask which of these are services the user wants in devctl, and which are shared infrastructure
(databases, queues, caches). Also confirm the devctl checkout path and whether the config should
live in it (`devctl.config.json`) or be referenced through `DEVCTL_CONFIG`.

Do not guess. A repo that is a library, a docs site, or a one-off script usually does not belong.

## 3. Inspect each selected repo

Read facts, never secrets. Run these inside each repo:

```sh
git -C "$REPO" remote -v
cat "$REPO/package.json" 2>/dev/null        # scripts.dev, scripts.start, packageManager
ls "$REPO" | grep -Ei 'dockerfile|compose|devcontainer'
grep -hE '^[A-Z0-9_]+=' "$REPO"/.env* 2>/dev/null | cut -d= -f1 | sort -u
grep -rnE 'mongo|postgres|pg|redis|sqs|kafka|elasticmq|opensearch' "$REPO"/docker-compose*.yml 2>/dev/null
```

Note, per repo:

- the dev command and the framework (Next, Vite, Storybook, nodemon, Payload, ...)
- the lockfile and package manager (`install` command)
- the port the dev server expects, if any
- databases, queues, and caches the app needs
- which env keys look like URLs to other services
- whether a container or compose file already exists

Only read env key names. Never copy secret values into the config.

## 4. Classify each service

- **Per-worktree app** (default): runs once per feature worktree. No `shared`.
- **Shared**: one instance for every stack, fixed port, no worktrees. Use for databases, queues, and
  caches. Set `shared: true` and a `basePort`.
- **Sidecar**: runs per worktree but is not a stack member and follows the worktree of the service
  that depends on it. Use for a per-feature Redis, worker, or sidecar process that should not be
  pinned in every stack. Set `sidecar: true`. Do not select it in `stack create` or `stack add`;
  the CLI rejects it.
- **External**: a deployed service reached in `test` or `prod`. Model it with `envExternals` and
  `remoteProvides`, not a local command.

Ask the user to confirm this classification. It is the part agents get wrong most often.

## 5. Draft the graph

For each service write:

- `repo`, `basePort`, `command` (use the repo's dev script)
- `install` when the repo is not installed yet
- `healthTimeoutMs`, and `healthCommand` for databases or containers
- `env` for values the service needs, using templates
- `provides` for values other services can consume, usually `{ "url": "${url}/api" }`
- `wiring` for consumer env keys, for example `{ "API_URL": "api.url" }`
- `dependsOn` when ordering matters but no value is passed
- `remoteProvides` when `test`/`prod` should point at a deployed copy
- `stopCommand` and `logsCommand` for services that run containers

Templates:

- `${url}` and `${origin}`: the service's public URL. Prefer these over `http://localhost:${port}`.
- `${port}`: only when a service must publish a fixed port, such as a container or a tool that
  hardcodes one.
- `${inspectPort}`: a debugger port.
- `${dnsName}`: the portless name.

Port mode is decided by the config:

- **Portless-owned** (default): do not use `${port}`, and drop `-p ${port}` from the dev command.
  portless picks the port. Next, Vite, Astro, and similar get the right flag from portless.
- **Fixed-port**: use `${port}` anywhere in the service's `command`, `env`, or `provides`. devctl
  assigns the port and registers a portless alias. Use this for containers and compound commands
  that portless cannot inject into.

Start with a small graph: the frontend, the API, and the shared database it needs. Add the rest
after the first stack works.

## 6. Write and validate

Write `devctl.config.json` in the devctl checkout. Start from
`devctl.config.example.jsonc` and keep the structure. Do not commit the file; it is gitignored.

Validate in this order, and fix each failure before moving on:

```sh
devctl config show
devctl doctor
devctl up --dry-run <stack>
devctl up <stack>
devctl status --check
devctl context <stack>
devctl down <stack>
```

`up` is safe to re-run. It reuses running services and reports started, reused, restarted, and
failed. Do not use `--force` to get past a failure, and never run `devctl kill` or
`devctl down --all` unless the user asks.

## 7. Report

When the smoke stack is healthy, tell the user:

- which repos are services, which are shared, and which are sidecars
- the graph (what wires to what)
- the URLs from `devctl status --json` or `devctl context`
- what you verified, and anything left unverified
- that the stack was stopped again, unless they want it left running

## Minimal example

```jsonc
{
  "version": 2,
  "reposRoot": "~/dev",
  "herdr": { "enabled": true, "workspace": "servers" },
  "envBaseFiles": { "local": ".env.development", "test": ".env.test", "prod": ".env.production" },
  "services": {
    "postgres": {
      "repo": "infra",
      "basePort": 5432,
      "shared": true,
      "command": "docker compose up -d postgres",
      "stopCommand": "docker compose stop postgres",
      "logsCommand": "docker compose logs --tail 100 postgres",
      "healthCommand": "pg_isready -h 127.0.0.1 -p 5432",
      "healthTimeoutMs": 60000
    },
    "api": {
      "repo": "api",
      "basePort": 3000,
      "command": "./node_modules/.bin/next dev",
      "provides": { "url": "${url}/api" },
      "dependsOn": ["postgres"],
      "healthTimeoutMs": 120000
    },
    "web": {
      "repo": "web",
      "basePort": 3100,
      "command": "./node_modules/.bin/next dev",
      "wiring": { "API_URL": "api.url" },
      "overlayManagedKeys": ["API_URL"],
      "healthTimeoutMs": 150000
    },
    "cache": {
      "repo": "api",
      "basePort": 6379,
      "sidecar": true,
      "command": "docker compose up -d redis",
      "stopCommand": "docker compose stop redis",
      "provides": { "url": "redis://127.0.0.1:${port}" },
      "healthTimeoutMs": 60000
    }
  }
}
```

## Rules

- Read before writing. Confirm the service classification with the user.
- Never put secret values in the config. Reference env files instead.
- Never edit the user's repos during setup.
- Ask before starting containers, installs, or anything that consumes significant resources.
- Do not use `--force`, and do not kill processes or free ports yourself.
- Targets are worktree names (`head`, a worktree name), `test`, or `prod`. Never branch names.
- If a service needs a URL of another service, use `${url}` and `wiring`, not a hand-built
  `localhost` URL.
- Stop at the first working stack, then report. Expand the graph with the user.

## Checklist

- [ ] Prerequisites verified (git, Node 24+, pnpm, devctl)
- [ ] Repos discovered and the user chose which ones to set up
- [ ] Each service classified as app, shared, sidecar, or external
- [ ] Ports and port mode chosen (portless-owned vs fixed-port)
- [ ] Graph written (`provides`, `wiring`, `dependsOn`, `remoteProvides`)
- [ ] Health checks and env files configured
- [ ] `devctl doctor` clean
- [ ] `devctl up` reaches ready
- [ ] `devctl status --check` exits 0
- [ ] Summary reported and the stack stopped
