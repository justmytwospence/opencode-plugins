# OpenCode Plugins

This repository is the development source for the OpenCode 2 plugin suite. Add or change components under `packages/<name>/`, not in the retired standalone `opencode-*` repositories or in OpenCode's installed package cache. Keep components independently usable: each one installs alone through a `::path:packages/<name>` Git spec, so it must not import a sibling at runtime. Optional sibling integrations go through OpenCode's plugin RPC (for example opencode-herdr's `herdr` RPC), never through relative imports. Shared helpers are deliberate identical copies; `scripts/test-contracts.mjs` lists them.

Components target the OpenCode 2 plugin API only (`@opencode/plugin`, `Plugin.define({ id, setup })`; CLI halves from `@opencode/plugin/tui` behind a `./tui` export). Do not add V1 (`@opencode-ai/plugin`) entry points.

## Checks

- Root: `npm test` for suite contracts (metadata, licenses, runtime independence, unique plugin ids, helper parity, docs catalog).
- Components: `npm ci` in a component directory, then `npm run check` there (typecheck and tests), or root `npm run check` for every component.
- Load smoke: `scripts/smoke.sh` runs a scratch OpenCode 2 binary with isolated XDG directories and loads every component from this checkout. It never touches the live configuration.
- Docs: `cd site && npm ci && npm run check && npm run build`. The site is static, separately deployed, and must not affect runtime installation.

All npm installations follow the machine's release-age policy. Never bypass it. Never run anything that makes paid classifier (Jev) calls in tests without explicit authorization; tests use stubs.

## Releases and installation

One Git commit versions the whole suite. Each component is pinned from that commit as `"opencode-<name>@github:justmytwospence/opencode-plugins#<commit>::path:packages/opencode-<name>"` in `opencode.jsonc` `plugins`; OpenCode loads the component's `./tui` half automatically. CLI-only components go in `cli.json` `plugins`. Never enable a retired standalone `opencode-*` package alongside its suite copy.

Publish source changes before bumping the pins in `~/dotfiles`. Read `~/dotfiles/AGENTS.md`, its chezmoi skill and `~/dotfiles/docs/plugins.md`; use `plugins try opencode-plugins` for local iteration and `plugins pin opencode-plugins` for published pins. Never edit an installed copy.

### Completion and rollout

Unless the user explicitly requests an uncommitted change or source-only work, finishing a change includes checking it, committing its files with a conventional commit, and pushing. For runtime changes, also update the pins with `plugins pin opencode-plugins`, commit and push only that pin change in dotfiles, and follow the dotfiles machine-synchronization policy. Running OpenCode clients need a restart (`opencode service restart` for the shared server) after installation; state any remaining step explicitly. Documentation-only changes need committing and pushing, but not a pin bump.

## Documentation ownership

`site/` owns the public landing, install, reference and requirement pages. The root README is a concise install/development front door; each component README is a short summary that links to its reference page. Do not invent external requirements or supported tools: verify source and tests. Label terminal illustrations as examples, not real screenshots.
