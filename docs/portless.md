# Named URLs (portless)

portless replaces port numbers with stable URLs like `https://web.ft-my-feature.localhost`. It is
required (Node 24+). `portless` ships as a normal dependency and devctl starts the proxy when you
run `devctl up`.

```sh
devctl portless start   # start the proxy (default 1355, so it does not need sudo)
devctl portless status  # proxy state and active routes
devctl portless stop    # stop the proxy
```

## How a service gets its port

A service is **portless-owned** by default. devctl runs it through `portless run`, portless picks
the port, and the service answers at `https://<worktree>.<service>.localhost` (or
`https://<service>.localhost` for `head`). devctl reads the chosen port back from `portless list`,
so nothing else has to know it.

A service is **fixed-port** when its templates use `${port}` anywhere (`command`, `env`, or
`provides`). devctl then assigns the port, and registers a `portless alias` for it. Use this for a
service that must publish a fixed port, for example a container that maps a host port, or a tool
that hardcodes one.

Because portless injects `--port` for known frameworks (Next, Vite, Astro, and others), a native
service that wants the portless-owned path just drops `-p ${port}` from its command.

## URLs in templates

- `${url}` and `${origin}` are the service's public URL: `https://<name>.localhost` when the
  service is portless-owned, and the aliased named URL when it is fixed-port. Use one of these for
  a service's own base URL, not `http://localhost:${port}`.
- `${dnsName}` is the portless name, `<worktree>.<service>`.
- `${port}` is the devctl-assigned port, available only to fixed-port services.

`devctl doctor` errors when portless is missing or not runnable, and warns when the proxy is down or
a running service has no route.
