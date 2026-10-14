---
title: Development & testing
description: How the OpenCode Plugins monorepo is laid out, what each check proves, and how to load a component in a scratch OpenCode 2 without touching your configuration.
---
## Layout

The repository is the development source for the suite. Each component lives under `packages/<name>/` with its own `package.json`, tests and README; the root holds the suite contracts and scripts; `site/` holds this documentation. Components are independently installable: each one installs alone through a `::path:packages/<name>` Git specifier, so it must not import a sibling at runtime. Optional sibling integrations go through OpenCode's plugin RPC (for example the `herdr` RPC), never through relative imports. Shared helpers are deliberate identical copies, and `scripts/test-contracts.mjs` lists them.

Entry points sit at the package root: `index.ts` (server half) and `tui.ts` (terminal half), each a one-line re-export from `src/`. A local directory plugin resolves only those files; a Git install resolves `package.json` `exports` (`.`, `./tui`, and `./rpc` for a component that publishes an RPC contract), so both are provided. Server halves import `@opencode/plugin` as types only and have no runtime dependencies, so a Git install needs no `npm install` of OpenCode's Effect stack. Terminal halves build elements with `jsx()` from `@opentui/solid/jsx-runtime` rather than `.tsx`, which a Git install cannot resolve.

Plugin ids are the component name without the `opencode-` prefix (`auto-effort`) and `<id>.tui` for the terminal half. Settings are read from `~/.config/agents/<name>.json`, then the plugin options, then `<project>/.agents/<name>.json` and `<project>/.opencode/<name>.json`.

## Checks

| Command | What it proves |
| --- | --- |
| `npm test` (root) | Suite contracts: component metadata, licenses, runtime independence, unique plugin ids, helper parity, and that the public catalog matches `packages/` |
| `npm ci && npm run check` in a component | Its typecheck and vitest tests, against fakes of the plugin context; nothing in tests calls Jev or a model |
| `npm run check` (root) | The same for every component |
| `node scripts/smoke.mjs [component ...]` | Installs a scratch OpenCode 2 into `.smoke/`, runs it with isolated XDG directories and checks that every server half loads and activates; `--tui` opens the TUI in a detached tmux session for a look at `/plugins` |
| `node scripts/e2e.mjs <component ...> [--variant high] [--script s.json] -- <prompt>` | One `opencode run --standalone` in the scratch install with the built-in `anthropic` provider pointed at `scripts/mock-anthropic.mjs` (scripted text and tool-call replies, a Jev mock behind `TYPESAFE_ENDPOINT`), then the output, the plugin log lines and every request that reached the provider. Use it to prove hooks fire and change requests. It costs nothing; `--live-jev` (real Jev, paid) needs explicit authorization |
| `cd site && npm ci && npm run check && npm run build` | This site: catalog and reference coverage, frontmatter, install entries, links, then a static build with rendered-link checks |

The smoke and end-to-end scripts never touch the live configuration. A component with only a terminal half must be listed in `cli.json` when loaded from a local directory; the scripts handle this.

## Facts about the OpenCode 2 loader

These were verified against OpenCode 2.0.24 and shape how components are written:

- One shared server runs every server half once, for all terminals, herdr panes and sessions (`--standalone` gives a private one). Server state is keyed by session id, never a global "current session", and server code never reads a terminal's environment. Anything tied to a pane or to what you are looking at runs in the terminal half, which learns its session from `context.ui.router.current()`.
- Plugin instances are per location: a server half loads once per project directory it serves.
- Plugin tools are reachable only through Code Mode's `execute` tool by default; a tool the model should see directly needs `options: { codemode: false }`.
- Keymap layers that carry palette or slash commands need `mode: "global"`.
- Server code cannot show toasts; it emits an RPC event and the terminal half shows it.
- `ctx.session.prompt({ sessionID, text, delivery: "queue" })` delivers a message to a possibly busy session without interrupting it.

## Releases

One Git commit versions the whole suite; see [pin, update and rollback](/guides/releases/). Source changes are published before pins are bumped, and running OpenCode clients need `opencode service restart` after installation. Documentation-only changes need no pin bump. The suite follows the maintainer's npm release-age policy for its own dependencies; the components themselves have none at runtime except markdown extras' `grok-mermaid`.

## Contributing

Open an [issue](https://github.com/justmytwospence/opencode-plugins/issues) or a pull request against [justmytwospence/opencode-plugins](https://github.com/justmytwospence/opencode-plugins). Keep each component independently usable, keep its README the short summary that links to its reference page here, and keep both in step with the source. Do not invent external requirements or supported tools.
