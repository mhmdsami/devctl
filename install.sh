#!/bin/sh
set -eu

REPO="https://github.com/mhmdsami/devctrl.git"
SRC="${DEVCTL_SRC:-$HOME/.devctl/src}"
BIN="${DEVCTL_BIN:-$HOME/.local/bin}"

err() { printf 'devctl: %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null || err "git is required"
command -v node >/dev/null || err "node is required"

major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 20 ] || err "node 20+ required (found $(node -v))"

command -v corepack >/dev/null && corepack enable >/dev/null 2>&1 || true
command -v pnpm >/dev/null || err "pnpm not found - run: corepack enable"

if [ -d "$SRC/.git" ]; then
  git -C "$SRC" pull --ff-only
else
  mkdir -p "$(dirname "$SRC")"
  git clone --depth 1 "$REPO" "$SRC"
fi

( cd "$SRC" && pnpm install --frozen-lockfile )

mkdir -p "$BIN"
ln -sf "$SRC/bin/devctl" "$BIN/devctl"

if [ ! -f "$SRC/devctl.config.json" ] && [ -f "$SRC/devctl.config.example.jsonc" ]; then
  cp "$SRC/devctl.config.example.jsonc" "$SRC/devctl.config.json"
fi

printf 'installed devctl -> %s/devctl\n' "$BIN"
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) printf 'add it to PATH:  export PATH="%s:$PATH"\n' "$BIN" ;;
esac
printf 'edit %s/devctl.config.json, then run: devctl status --check\n' "$SRC"
