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
- **Named URLs**: optional portless integration gives every service a
  `https://<name>.localhost` URL instead of a port.
- **Raycast**: a menu bar and panels to start, stop, and inspect stacks.

## Install

Needs Git, Node 20+, and pnpm (`corepack enable`).

```sh
curl -fsSL https://raw.githubusercontent.com/mhmdsami/devctl/main/install.sh | sh
$EDITOR ~/.devctl/src/devctl.config.json
devctl doctor
```

## Docs

- [Concepts](docs/concepts.md): services, worktrees, stacks, ports, shared services, state.
- [Configuration](docs/configuration.md): the config file, the graph, templates, environments.
- [Named URLs](docs/portless.md): portless and the `devctl portless` commands.
- [Raycast extension](docs/raycast.md): the menu bar and panels, and releases.
- [Command reference](docs/commands.md): every command and flag.
