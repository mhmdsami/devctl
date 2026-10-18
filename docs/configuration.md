# Configuration

devctl reads `devctl.config.json` (or `.jsonc`) from the devctl checkout, or the path in
`DEVCTL_CONFIG`. Start from `devctl.config.example.jsonc`.

Services form a dependency graph. There are no hardcoded roles.

## Service fields

Required:

- `repo`: the directory under `reposRoot` that holds the service.
- `basePort`: the port for `head`. Other worktrees get the next free slots.
- `command`: the start command. See the templates below.

Optional:

- `install`: run before start when `node_modules` is missing. Auto-detected from the lockfile
  otherwise.
- `healthTimeoutMs`: how long to wait for the port (or `healthCommand`) before failing.
- `healthCommand`: a readiness check that must exit 0, for example a mongosh ping.
- `provides`, `wiring`, `dependsOn`, `remoteProvides`: the dependency graph.
- `env`, `envExternals`, `overlayManagedKeys`: environment values.
- `shared`: one instance for every stack, with a fixed port.
- `inspectBasePort`: enables `${inspectPort}` for Node inspector flags.

Top-level fields:

- `reposRoot`: where your repos live.
- `envBaseFiles`: the base env file per mode, keyed `local`, `test`, and `prod`.
- `herdr`: runs each service in a terminal tab. Set `enabled` to `false` to run plain detached
  processes instead.
- `debug`: optional. On a failed start, hand the logs to an agent.

## Templates

Usable in `command`, `env`, and `provides`:

- `${port}`, `${inspectPort}`
- `${dnsName}`: the service's portless name, `<worktree>.<service>`.
- `${portlessUrl}` and `${origin}`: the service's public URL. `https://<name>.localhost` when
  portless is on, otherwise `http://localhost:<port>`. Use `${origin}` for a service's own base
  URL so links work either way.

## Example

```jsonc
{
  "reposRoot": "~/dev",
  "herdr": { "enabled": true, "workspace": "servers" },
  "envBaseFiles": { "local": ".env.development", "test": ".env.test", "prod": ".env.production" },
  "debug": { "enabled": true, "provider": "opencode-go", "model": "omen-alpha" },
  "services": {
    "mongo": {
      "repo": "my-infra",
      "basePort": 27017,
      "shared": true,
      "command": "docker compose up -d mongo",
      "stopCommand": "docker compose stop mongo",
      "healthTimeoutMs": 90000
    },
    "my-api": {
      "repo": "my-api",
      "basePort": 5000,
      "command": "./node_modules/.bin/mydev -p ${port}",
      "healthTimeoutMs": 120000,
      "dependsOn": ["mongo"],
      "env": { "PUBLIC_SERVER_URL": "${origin}" },
      "provides": { "url": "http://localhost:${port}/api", "key": "…" },
      "remoteProvides": { "url": { "from": "my-frontend", "envKey": "API_URL" } }
    },
    "my-frontend": {
      "repo": "my-frontend",
      "basePort": 5100,
      "command": "./node_modules/.bin/next dev -p ${port}",
      "healthTimeoutMs": 150000,
      "wiring": { "API_URL": "my-api.url", "API_KEY": "my-api.key" },
      "overlayManagedKeys": ["API_URL", "API_KEY"]
    }
  }
}
```

## The graph

- `wiring` entries like `my-api.url` are edges. The dependent starts after the provider and
  receives the resolved value in its env.
- `dependsOn` adds a startup edge with no env value.
- `devctl use <service> <worktree|test|prod>` retargets every dependent. A stack member override
  wins over it.
- Targeting `test` or `prod` points a dependent at a deployed provider and starts nothing
  locally. Local providers pull in their own dependencies, so starting `api` also starts the
  databases it declares.
- On `up`, gitignored root files such as `.env*`, `.npmrc`, and `.yarnrc.yml` are copied into a
  new worktree from the repo's checkout, so installs and env work out of the box.
- Cycles are rejected when the config loads.

## Environments

- `devctl env test|prod` switches the external mode and restarts the services that use wiring.
- A service's env layers in this order: the mode base file (`envBaseFiles`), `services.<x>.env`,
  `envExternals.<mode>`, `wiring` (through `.env.local`), then the stack override file
  `~/.devctl/env/<stack>/<service>.env`.
- `devctl env show <service>[/<worktree>]` prints each key with the source it came from.
- `devctl env set|unset|edit` maintain the stack override file.

## Ports, fixed-port and containerized services

portless is required. A service is portless-owned by default: devctl runs it through
`portless run`, portless picks the port, and the service answers at
`https://<worktree>.<service>.localhost`. A service that must publish its own port is
"fixed-port": use `${port}` anywhere in its templates (`command`, `env`, or `provides`), and
devctl assigns the port and registers a portless alias for it. Use `${url}` (or `${origin}`) for
a service's public URL; it is the named URL when the service is portless-owned.

Containerized services need no special config. `command` brings the containers up and the other
fields cover the rest:

- `command`: `docker compose -f docker-compose.yml up -d my-service`
- `stopCommand`: `docker compose -f docker-compose.yml stop my-service` (valid on any service;
  devctl stops a service with a stopCommand by running it, not by killing a process tree)
- `logsCommand`: `docker compose -f docker-compose.yml logs --tail 100 my-service` (optional;
  `devctl logs` uses it when set, otherwise it tails the captured process log)
- `healthCommand`: a readiness check, for example a `pg_isready` or `mongosh` probe
- `${port}` in `command` or `env` when the container publishes a host port; devctl assigns it and
  registers the alias, and the compose project can name itself and its volumes from that port or
  from other env devctl injects

devctl does not generate compose files and has no runtime field: `command` decides where a
service runs, exactly as the shared `mongo` service does.
