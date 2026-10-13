# OpenCode Plugins

This repository is the development source for the OpenCode 2 plugin suite. Add or change components under `packages/<name>/`, not in the retired standalone `opencode-*` repositories or in OpenCode's installed package cache. Keep components independently usable: each one installs alone through a `::path:packages/<name>` Git spec, so it must not import a sibling at runtime. Optional sibling integrations go through OpenCode's plugin RPC (for example opencode-herdr's `herdr` RPC), never through relative imports. Shared helpers are deliberate identical copies; `scripts/test-contracts.mjs` lists them.

Components target the OpenCode 2 plugin API only (`@opencode/plugin`, `Plugin.define({ id, setup })`; CLI halves from `@opencode/plugin/tui` behind a `./tui` export). Do not add V1 (`@opencode-ai/plugin`) entry points.

## Component layout (OpenCode 2 loader facts, verified against 2.0.24)

- Entry points live at the package root: `index.ts` (server half) and `tui.ts` (CLI half), each a one-line re-export from `src/`. A local directory plugin (`plugins try`, the smoke test) resolves only `<dir>/server.ts`, `<dir>/index.ts` and `<dir>/tui.ts`, not package.json exports; a Git install resolves `<name>/server`, `<name>` and `<name>/tui` through exports. So `package.json` has `"exports": { ".": "./index.ts", "./tui": "./tui.ts" }` (plus `"./rpc": "./src/rpc.ts"` when the component publishes an RPC contract), and both work.
- Server half: `import type { Plugin } from "@opencode/plugin"` only (type imports), and `export default { id, setup } satisfies Plugin.Plugin`. No runtime dependencies: a Git install then needs no `npm install` of `@opencode/plugin` and its Effect stack. `@opencode/plugin`, `@opencode/client` and friends are devDependencies, for types and tests.
- CLI half: static imports of `@opencode/plugin/tui`, `solid-js`, `solid-js/store`, `@opentui/core` and `@opentui/solid/jsx-runtime`. The host rewrites these static specifiers to its own runtime modules, also inside a Git install; dynamic `import(variable)` is not rewritten. No `.tsx`: JSX compiled by the host imports `@opentui/solid`, which a Git install cannot resolve. Build elements with `jsx("text", { ... })` from `@opentui/solid/jsx-runtime`, using getters (`get children() { ... }`) for reactive props.
- Where slots draw (2.0.24, verified): `prompt.footer.status` right after the footer's `dir:branch`; `prompt.footer.file` after that; `prompt.footer` at the far right of the footer row; `session.composer.top` just above the prompt box in a session; `sidebar.content` in the session sidebar under Context/spent; `sidebar.footer` at the sidebar's bottom; `home.footer.status` and `home.footer` on the home screen's bottom rows. OpenCode itself already shows `dir:branch`, context tokens and percent, and session cost.
- A component with only a CLI half must be listed in `cli.json` `plugins` when loaded from a local directory: the server's config scan drops a directory without `index.ts`/`server.ts`, so it never reaches the terminal. The smoke and e2e scripts handle this.
- Plugin ids are the component name without the `opencode-` prefix (`auto-effort`), and `<id>.tui` for the CLI half. Ids are unique across the suite.
- Server and CLI halves talk through plugin RPC (`Rpc` from `@opencode/plugin/rpc`, contract in `src/rpc.ts`), never through files, ports or globals. Server code cannot show toasts; emit an RPC event and let the CLI half show it.
- One shared server: OpenCode 2 runs every server half once, in a background service shared by all of the user's terminals, herdr panes and sessions (`--standalone` gives a private one). Server state is keyed by session id, never global "current session" state, and server code never reads a terminal's environment (`HERDR_PANE_ID`, `TERM`, tmux). Anything tied to a pane or to what the user is looking at runs in the CLI half, which runs in the terminal process; it learns its session from `context.ui.router.current()` (and the family through `context.data.session.root`).
- herdr: components report through the `herdr` RPC in `packages/opencode-herdr/src/herdr-rpc.ts` (copy it verbatim as `src/herdr-rpc.ts`; the copies are kept identical). Calls are per session; opencode-herdr's CLI half applies them to the pane showing that session. Ignore call failures (opencode-herdr absent) and resend state on its `ready` event.
- Settings: shared `~/.config/agents/<name>.json`, then plugin options (`ctx.options`), then `<project>/.agents/<name>.json` and `<project>/.opencode/<name>.json` (settings.ts).
- Tests use vitest with fakes of the plugin context; nothing in tests calls Jev or a model.

## Checks

- Root: `npm test` for suite contracts (metadata, licenses, runtime independence, unique plugin ids, helper parity, docs catalog).
- Components: `npm ci` in a component directory, then `npm run check` there (typecheck and tests), or root `npm run check` for every component.
- Load smoke: `node scripts/smoke.mjs [component ...]` installs a scratch OpenCode 2 into `.smoke/`, runs it with isolated XDG directories and checks that every server half loads and activates. `--tui` opens the TUI in a detached tmux session for a look at `/plugins`. It never touches the live configuration.
- End to end: `node scripts/e2e.mjs <component ...> [--variant high] [--script s.json] -- <prompt>` runs one `opencode run --standalone` in the scratch install with the built-in `anthropic` provider pointed at `scripts/mock-anthropic.mjs` (scripted text and tool-call replies, a Jev mock behind `TYPESAFE_ENDPOINT`), then prints the output, the plugin log lines and every request that reached the provider. Use it to prove hooks fire and change requests. It costs nothing; `--live-jev` (real Jev, paid) needs explicit authorization.
- Docs: `cd site && npm ci && npm run check && npm run build`. The site is static, separately deployed, and must not affect runtime installation.

All npm installations follow the machine's release-age policy. Never bypass it. Never run anything that makes paid classifier (Jev) calls in tests without explicit authorization; tests use stubs.

## Releases and installation

One Git commit versions the whole suite. Each component is pinned from that commit as `"opencode-<name>@github:justmytwospence/opencode-plugins#<commit>::path:packages/opencode-<name>"` in `opencode.jsonc` `plugins`; OpenCode loads the component's `./tui` half automatically. CLI-only components go in `cli.json` `plugins`. Never enable a retired standalone `opencode-*` package alongside its suite copy.

Publish source changes before bumping the pins in `~/dotfiles`. Read `~/dotfiles/AGENTS.md`, its chezmoi skill and `~/dotfiles/docs/plugins.md`; use `plugins try opencode-plugins` for local iteration and `plugins pin opencode-plugins` for published pins. Never edit an installed copy.

### Completion and rollout

Unless the user explicitly requests an uncommitted change or source-only work, finishing a change includes checking it, committing its files with a conventional commit, and pushing. For runtime changes, also update the pins with `plugins pin opencode-plugins`, commit and push only that pin change in dotfiles, and follow the dotfiles machine-synchronization policy. Running OpenCode clients need a restart (`opencode service restart` for the shared server) after installation; state any remaining step explicitly. Documentation-only changes need committing and pushing, but not a pin bump.

## Documentation ownership

`site/` owns the public landing, install, reference and requirement pages. The root README is a concise install/development front door; each component README is a short summary that links to its reference page. Do not invent external requirements or supported tools: verify source and tests. Label terminal illustrations as examples, not real screenshots.
