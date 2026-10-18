# Command reference

Every devctl command and its flags. `devctl --help` prints the same list, and
`devctl <cmd> --help` explains one command.

```sh
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
devctl agents [stack] [--refresh] [--unassigned] [--json]   # claude/codex/opencode/pi sessions per stack
devctl agent register <stack>              # link your own session to a stack (detected from the env)
devctl agent assign <stack> <agent> <id>  # link a session to a stack (a link wins over a suggestion)
devctl agent unassign <agent> <id>
devctl agent note <agent> <id> <text>
devctl agent resume <stack> [--agent X] [--id Y]   # runs the agent's resume command in its directory
devctl doctor [--json]                   # config, binaries, ports, env files, stale state, branch conflicts
devctl attach [workspace]
devctl portless start|stop|status        # manage the portless proxy (named URLs), show routes
devctl completion bash|zsh
```

## Notes

- portless is required (Node 24+). A service is portless-owned unless a template uses `${port}`;
  fixed-port services get a devctl-assigned port and a `portless alias`. See
  [Named URLs](portless.md).
- Args are strict. Unknown options are rejected with a pointer to `devctl <cmd> --help`.
- `--no-color` and `--quiet` work on any command.
- Mutating commands accept `--json` for a machine-readable result.
- `up` ends with a summary: started, reused, restarted, failed.
- `devctl status --check` exits 1 when a tracked service is unhealthy, for scripts and CI.
- Shared services are not stack members and never appear in `which`, `stack add/create`, or the
  Raycast form, since they have no branch or target. Start and stop them with
  `devctl up mongo` / `devctl down mongo`, or let the graph pull them in.
- Completions: `eval "$(devctl completion zsh)"` (or `completion bash`).
