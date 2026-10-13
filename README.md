# OpenCode Plugins

A modular suite of plugins for [OpenCode](https://opencode.ai) 2: cache and context awareness, tool gating, effort control, herdr and marimo integration, and terminal ergonomics, ported from [Pi Plugins](https://github.com/justmytwospence/pi-plugins) where OpenCode allows. Every component can be enabled on its own; one Git commit versions the whole suite.

## Install

Add the components you want to `plugins` in `~/.config/opencode/opencode.jsonc`, all from the same commit:

```jsonc
{
  "plugins": [
    "opencode-tool-gate@github:justmytwospence/opencode-plugins#<commit>::path:packages/opencode-tool-gate",
    "opencode-cache-guard@github:justmytwospence/opencode-plugins#<commit>::path:packages/opencode-cache-guard"
  ]
}
```

OpenCode loads a component's terminal half automatically. Components that only have a terminal half go in `~/.config/opencode/cli.json` `plugins` instead. Pin a full commit hash: OpenCode keeps exact commits fixed and checks branches for updates.

## Development

```sh
npm test                                             # suite contracts
for dir in packages/*/; do (cd "$dir" && npm ci); done
npm run check                                        # every component's typecheck and tests
node scripts/smoke.mjs                               # load every component in a scratch OpenCode 2
```

Develop components under `packages/<name>/`. Keep each one independently installable; sibling integrations go through OpenCode's plugin RPC. See `AGENTS.md`.
