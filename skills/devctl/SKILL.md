---
name: devctl
description: Use devctl to inspect and manage local development services, worktrees, stacks, ports, URLs, and logs. Read devctl state before acting.
tags: development, tooling
---

# devctl

`devctl` runs local development services. The service graph comes from `DEVCTL_CONFIG`, or `devctl.config.jsonc` / `devctl.config.json` in the devctl installation. Each git worktree gets its own port. A worktree name shared across services is a **stack**. Services run inside herdr tabs. Never kill tabs or ports yourself; devctl refuses to kill processes it doesn't own.

## Read state first, act second

```sh
devctl status --json            # running services: key, port, urls, alive/listening, stack, startedAt
devctl status --check           # same, exit 1 if anything unhealthy (use in scripts)
devctl which --json             # every worktree with its assigned port, even when stopped
devctl stack ls --json          # stack definitions + which members are running
```

`--json` exists on `status`, `which`, `stack ls`, `doctor`, and all mutating commands (`up`, `down`, `env`, `use`). Prefer it for parsing. Args are strict; unknown flags are rejected. `devctl <cmd> --help` explains each command.

## Starting and stopping

```sh
devctl up api/ft-my-feature        # start one service; reuses it if already running
devctl up ft-my-feature                # start the whole stack with that branch name (deps auto-start)
devctl up                              # service for cwd, else the daily stack (same as up --all)
devctl up --dry-run                    # print the start plan (order, ports, commands) without starting
devctl down api/ft-my-feature      # stop one service
devctl down ft-my-feature              # stop a stack's members
```

`up` is safe to re-run. It reuses running services and prints a summary: started, reused, restarted, failed.

Restarting drops the user's running server. Only restart or stop services the user asked about, and say what you're doing. `devctl restart <target>` is down plus up.

Never run `devctl down --all` or `devctl kill`. That's the kill switch for every stack plus shared infra, and it asks for interactive confirmation for a reason.

If `up` fails with "port occupied, re-run with --force", report it to the user instead of passing `--force` yourself. `--force` kills whatever holds the port.

mongo is a shared service: `devctl up mongo` and `devctl down mongo`. It has no worktrees or branches. It starts automatically via the graph when api starts.

## Logs and URLs

```sh
devctl logs web/ft-my-feature --lines 100    # last 100 lines, default 50
devctl logs web/ft-my-feature --follow       # tails, blocking; agents should use --lines
```

URLs come from `status --json`. `portlessUrl` looks like `https://<branch>.<service>.localhost:1355`; the fallback is `http://localhost:<port>`. Don't construct them by hand. Don't curl services to check health. `devctl status --check` does that.

## Env and targeting

```sh
devctl env test|prod                   # external API mode, restarts affected services
devctl use api ft-my-feature       # point api-dependents at a worktree; or: use api test|prod
```

Both restart running services. Confirm intent first. Stack member overrides win over `use`.

## Diagnostics

```sh
devctl doctor [--json]    # config, binaries, ports, env files, stale state, branch conflicts
devctl config show        # resolved config, secrets redacted
devctl context [stack]    # markdown status of a stack - paste into the conversation when the user asks about their stack
devctl diagnose <service>/<worktree>   # debug agent reads recent logs and prints ROOT CAUSE / FIX
devctl env show <service>/<worktree>   # effective env with the source of each key (secrets redacted)
```

If a service won't start, check `doctor` and that service's logs before guessing. For app-level
failures (process healthy, page broken), `devctl diagnose <service>/<worktree>` hands the logs to
the debug agent. The agent model is set with `devctl config set debug.model <name>`.

## Adding a service (config)

Services live in the resolved devctl configuration. A service declares `repo`, `basePort`, `command` (supports `${port}`), and optionally `provides`, `remoteProvides`, `wiring`, `dependsOn`, `shared`. See `devctl config show` or `docs/configuration.md` in the devctl repo for the schema. Config errors fail at load, so run any devctl command after editing to catch mistakes.
