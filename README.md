# devctl

Local dev orchestration for git worktrees.

Give a feature one name, and devctl runs that worktree across your services, each on its own
port, wired to the services it depends on. Run several features at once without port clashes.

```sh
devctl up ft-my-feature    # start the feature's worktrees
devctl status              # what is running, and at which URLs
devctl down ft-my-feature  # stop them
```

- **Stacks**: one worktree name across services is one feature. Start it with one command.
- **Graph**: services declare what they provide and what they depend on. devctl starts them in
  order and injects the URLs.
- **Named URLs**: portless is required and owns the port, so every service answers at
  `https://<worktree>.<service>.localhost`. A service that must publish a fixed port uses
  `${port}` and gets a portless alias.
- **Agent sessions**: devctl finds the claude, codex, opencode, and pi sessions for a stack and
  links them, so you can pick work back up later.
- **Raycast**: a menu bar and panels to start, stop, and inspect stacks.

## Install

Needs Git, Node 24+, and pnpm (`corepack enable`).

```sh
curl -fsSL https://raw.githubusercontent.com/mhmdsami/devctl/main/install.sh | sh
$EDITOR ~/.devctl/src/devctl.config.json
devctl doctor
```

## Docs

- [Set up with an agent](docs/setup-with-an-agent.md): a runbook your agent can follow to discover
  repos, pick services, and write the config.
- [Concepts](docs/concepts.md): services, worktrees, stacks, ports, shared services, state.
- [Configuration](docs/configuration.md): the config file, the graph, templates, environments.
- [Named URLs](docs/portless.md): portless and the `devctl portless` commands.
- [Raycast extension](docs/raycast.md): the menu bar and panels, and releases.
- [Command reference](docs/commands.md): every command and flag.
