---
title: About & credits
description: OpenCode Plugins is Spencer Boucher's personal OpenCode 2 plugin suite, ported from Pi Plugins, with preserved upstream attribution.
---
## A personal suite, built for OpenCode 2

OpenCode Plugins is maintained by [Spencer Boucher](https://github.com/justmytwospence). It collects focused changes to the coding session: background work, delegation, review, context and cost awareness, and terminal ergonomics, ported from [Pi Plugins](https://github.com/justmytwospence/pi-plugins) where OpenCode 2's plugin API allows. The ten Pi components that were not ported are mapped on [built into OpenCode 2](/guides/built-in/).

This documentation covers the suite at [justmytwospence/opencode-plugins](https://github.com/justmytwospence/opencode-plugins). It is an independent personal project, not the official OpenCode documentation. For OpenCode itself, start at [opencode.ai](https://opencode.ai).

All 16 components install on their own through a `::path:` Git specifier and are versioned together by one commit.

## Source and attribution

Component licenses remain with their source; each `packages/<name>/LICENSE` carries the notices its code descends from.

- **Side conversations** adapt pi-btw 0.6.1 (MIT, Dan Bachelder); the prompts and handoff formats are upstream's.
- **Context** keeps the copyright of minuque, whose [pi-cc-extensions](https://github.com/minuque/pi-cc-extensions) `/context` command pi-context was ported from; **markdown extras**' transforms descend from the same project.
- **Sticky prompt** carries the notice of the pi-collections contributors, whose pi-sticky-last-prompt the selection logic descends from.
- **Markdown extras** draws class and ER diagrams with [grok-mermaid](https://github.com/xl0/grok-mermaid).
- The documentation is built with [Astro](https://astro.build) and [Starlight](https://starlight.astro.build). Search is provided by [Pagefind](https://pagefind.app). Self-hosted fonts are DM Sans and IBM Plex Mono, distributed under the SIL Open Font License through Fontsource.

See the [suite license](https://github.com/justmytwospence/opencode-plugins/blob/main/LICENSE) and the individual `packages/<name>/LICENSE` files.

## Related projects

Several components share settings files under `~/.config/agents/` with their pi and Claude Code ports, so one file configures auto-effort, tool-gate, copy, next-prompt or prose-width everywhere. These are **related projects**, not products installed by this suite:

- [Pi Plugins](https://github.com/justmytwospence/pi-plugins), the Pi suite these components were ported from
- [claude-auto-effort](https://github.com/justmytwospence/claude-auto-effort), the Claude Code port of auto effort

## About the illustrations

The landing-page terminal is a CSS illustration of a possible workflow, and every terminal excerpt on the reference pages is an example. They are labeled as such and are not screenshots or evidence of a measured run. Times, percentages and status text are illustrative.

## Documentation boundaries

Reference pages are grounded in the repository's README files, implementation and tests, and two components (side conversations and delegation) were documented from source while their READMEs were still being written. OpenCode's own behavior is described as of version 2.0.24; its terminal internals and provider behavior can change. Test results establish what a test exercises, not an unrestricted support guarantee.

Found a mismatch? [Open an issue](https://github.com/justmytwospence/opencode-plugins/issues) with the relevant source path and a minimal reproduction. Do not include credentials or private session content.
