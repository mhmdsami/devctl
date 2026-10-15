# Named URLs (portless)

portless replaces port numbers with stable URLs like `https://web.ft-my-feature.localhost`. It is
optional and ships as an optional dependency (needs Node 24+).

```sh
devctl portless on      # start the proxy and register a route per running service
devctl portless status  # mode, proxy state, and active routes
devctl portless off     # stop the proxy and go back to localhost ports
```

`on` and `off` restart running services so their env matches. The proxy runs as root, so those
two commands ask for `sudo`. To avoid sudo, run it on another port:
`devctl portless on --port 1355`, which serves `https://<name>.localhost:1355`.

If portless is missing or not runnable, devctl uses `http://localhost:<port>` everywhere and
never advertises a URL that does not resolve. `devctl doctor` reports the mode, the proxy state,
and any running service that is missing a route.

For a service that publishes its own URL, use the `${origin}` template so it stays same-origin
when browsed through portless, and falls back to the port when portless is off. See
[Configuration](configuration.md#templates).
