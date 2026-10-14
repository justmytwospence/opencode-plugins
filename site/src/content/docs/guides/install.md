---
title: Install & select
description: Add OpenCode Plugins components to opencode.jsonc one Git entry at a time, pin them to one commit, and put terminal-only components in cli.json.
---
## Before you install

Use a working [OpenCode 2](https://opencode.ai) installation with Git available. The suite's loader checks and every component's tests target **OpenCode 2.0.24**; each reference page repeats the version it was tested with.

Plugins run with OpenCode's operating-system permissions, and server halves run in the background service shared by all of your terminals. Review the [source](https://github.com/justmytwospence/opencode-plugins) and [requirements](/guides/requirements/) before loading them. This website needs no credentials; some plugin features do.

## Add one entry per component

Each component installs on its own through an npm-compatible Git specifier with a `::path:` selector into the suite repository. Add the ones you want to `plugins` in `~/.config/opencode/opencode.jsonc`, all from the same commit:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "opencode-tool-gate@github:justmytwospence/opencode-plugins#<commit>::path:packages/opencode-tool-gate",
    "opencode-cache-guard@github:justmytwospence/opencode-plugins#<commit>::path:packages/opencode-cache-guard",
    "opencode-bg@github:justmytwospence/opencode-plugins#<commit>::path:packages/opencode-bg"
  ]
}
```

Replace `<commit>` with a **full 40-character commit hash** from the repository. OpenCode keeps exact commits fixed; a branch name is checked for updates at startup instead. Copy the exact entry from a component's reference page; the name before `@` must match the directory after `::path:packages/`.

OpenCode loads a component's terminal half (`./tui`) automatically from the same entry. You do not add the same package to `cli.json`. A project `opencode.jsonc` or `.opencode/opencode.jsonc` can add entries too; plugin arrays from every applicable config file are applied in precedence order rather than replacing one another.

The server installs a missing package in the background after startup. Restart the shared server once the install has finished, so that every terminal sees it:

```sh
opencode service restart
```

:::caution[Choose before running a prompt]
Several components make paid classifier requests when `TYPESAFE_API_KEY` is set. Adding a component does not mean every feature is free or entirely offline. Read [requirements and costs](/guides/requirements/) first.
:::

## Terminal-only components go in cli.json

Four components have no server half: [diff review](/plugins/opencode-diff-review/), [markdown extras](/plugins/opencode-markdown-extras/), [prose width](/plugins/opencode-prose-width/) and the [sticky prompt](/plugins/opencode-sticky-last-prompt/). The server's config scan drops a package without a server entry point, so these go in `~/.config/opencode/cli.json` instead, where they also stay active against a remote server:

```json
{
  "plugins": [
    "opencode-prose-width@github:justmytwospence/opencode-plugins#<commit>::path:packages/opencode-prose-width",
    "opencode-sticky-last-prompt@github:justmytwospence/opencode-plugins#<commit>::path:packages/opencode-sticky-last-prompt"
  ]
}
```

Use the same commit as the entries in `opencode.jsonc`. `opencode plugin check` and `opencode plugin update` cover both files.

## Pass options to a component

Use the object form for a component that takes plugin options. The `package` value is the same specifier:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-auto-effort@github:justmytwospence/opencode-plugins#<commit>::path:packages/opencode-auto-effort",
      "options": { "toast": false }
    }
  ]
}
```

Most components also read a shared settings file under `~/.config/agents/<name>.json` and a project `.agents/<name>.json`; the reference pages list the keys and the merge order.

## Disable without removing

Plugin entries are processed in order. Prefix a plugin **id** with `-` to disable it, and a later id re-enables it. Suite ids are the component name without the `opencode-` prefix, and `<id>.tui` for the terminal half:

```jsonc
{
  "plugins": [
    "opencode-tool-gate@github:justmytwospence/opencode-plugins#<commit>::path:packages/opencode-tool-gate",
    "-tool-gate"
  ]
}
```

`*` matches every plugin and `.*` matches an id prefix, so `"-opencode.provider.*"` disables a family of built-ins. Directives in `cli.json` work the same way for terminal plugins. Two OpenCode built-ins ignore removals: `opencode.config.policy` and `opencode.provider.opencode`.

## Manage from the command line

```sh
opencode plugin add 'opencode-bg@github:justmytwospence/opencode-plugins#<commit>::path:packages/opencode-bg'
opencode plugin list
opencode plugin check
opencode plugin update
opencode plugin remove 'opencode-bg@github:justmytwospence/opencode-plugins#<commit>::path:packages/opencode-bg'
```

`plugin add` writes the entry to the global configuration; quote the specifier so your shell leaves `#` and `::` alone. `plugin check` and `plugin update` cover server and terminal-only package plugins and skip exact commit pins. `/plugins` inside the TUI lists what is loaded and whether anything failed.

## Try a local checkout

A clone of the repository can be loaded by directory path instead of a Git specifier; relative paths resolve from the config file that contains them:

```jsonc
{
  "plugins": ["/home/me/opencode-plugins/packages/opencode-bg"]
}
```

A local directory plugin is resolved by its `index.ts` and `tui.ts` files, not by `package.json` exports, and a terminal-only directory must be listed in `cli.json`. [Development and testing](/development/) describes the scratch install the repository's own smoke and end-to-end scripts use.

## Avoid double registration

Never enable both a suite entry and another copy of the same component. The suite replaced the retired standalone `opencode-*` repositories (for example `opencode-git-status`, which [status footer](/plugins/opencode-status-footer/) replaces); remove their entries from `opencode.jsonc` and `cli.json` before adding the suite copy. Two copies register the same tools, commands, slots and RPC twice.

Next, [pin a known revision](/guides/releases/) for a reproducible installation, or read what each component [requires](/guides/requirements/).
