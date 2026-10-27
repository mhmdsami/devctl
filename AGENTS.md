# AGENTS.md

devctl is a CLI + Raycast extension that orchestrates local dev services as git
worktrees, wired together by a dependency graph declared in `devctl.config.json`.

## Layout

- `src/cli.ts` - command dispatch, service lifecycle (`ensureStack`, `waitFor`)
- `src/args.ts` - strict argument parser; all commands parse through it
- `src/stacks.ts` - the graph: providers, wiring, dependency resolution, env planning
- `src/registry.ts` - worktree discovery, ports, targets (worktree names are identity)
- `src/session.ts` - herdr (terminal manager) integration: tabs, panes, focus, stop
- `src/store.ts` - the append-only JSONL state log (per-key deltas, quarantine on corruption)
- `src/usage.ts` - local command telemetry (`~/.devctl/usage.jsonl`) and `devctl usage`
- `src/agents/` - runner-agnostic session adapters (claude, codex, opencode, pi) and the link index
- `src/debugAgent.ts` - optional on-failure diagnosis via an external agent CLI
- `raycast/` - the Raycast extension; talks to the CLI through `lib/devctl.ts`
- `devctl.config.example.jsonc` - the committed example; the real config is gitignored

## Commands

- `npm run typecheck` - must pass
- `npm test` - hermetic graph self-check (creates temp git repos, no personal state)

## Rules

- No comments anywhere, including tests and config examples.
- Never read or write the user's real `devctl.config.json` in tests; tests ship their own
  fixture via `DEVCTL_CONFIG`.
- Targets are worktree names, `head`, `test`, or `prod` - never branch names. A worktree's
  checked-out branch may change; its name may not.
- Only kill processes devctl started (ownership via pid + start token). Unowned port
  occupants require explicit `--force`.
- portless is required and owns the port for services that do not use `${port}`; those that do are
  fixed-port and get a `portless alias`. Agent sessions are listed, not guessed: links are explicit.
- Shared services (`shared: true`) have no worktrees, no branch targets, and never appear
  as stack members. They run detached, not in herdr tabs.
- Errors that matter go to stderr; progress goes through `out()` so `--quiet` works.
- Prose (README, help text, toasts) follows the unslop skill: no em dashes, no filler,
  sentence case, concrete statements.
- After changing behavior: `npm run typecheck`, `npm test`, and exercise the CLI once
  (`devctl status --check` is the cheap smoke).
- Commit messages are a single line in Conventional Commits form, for example
  `fix(stack): stop sidecars on down`. No body and no trailers.
