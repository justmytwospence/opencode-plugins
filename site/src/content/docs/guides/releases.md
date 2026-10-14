---
title: Pin, update & rollback
description: Treat OpenCode Plugins as one Git-versioned suite while installing each component on its own, pinned to a full commit hash.
---
## One commit, many entries

One Git commit versions the whole suite: every component directory under `packages/` is tested together at that commit. Your `plugins` entries choose which components load, and each entry names the commit it comes from. Keep every entry on the same commit; two components from different commits have not been tested together, and shared helpers such as the herdr RPC contract are kept identical only within one commit.

There are no per-component version tags or npm releases. The component `package.json` versions are informational.

## Pin a revision

Choose a full commit hash from the [repository](https://github.com/justmytwospence/opencode-plugins). OpenCode keeps exact commits fixed: startup never moves a full-hash pin, and `opencode plugin update` skips it. A branch name such as `#main` is checked for updates at startup instead, and a short hash is not a pin.

```jsonc
{
  "plugins": [
    "opencode-cache-guard@github:justmytwospence/opencode-plugins#<commit>::path:packages/opencode-cache-guard",
    "opencode-context@github:justmytwospence/opencode-plugins#<commit>::path:packages/opencode-context"
  ]
}
```

`<commit>` stands for the 40-character hash in every example on this site; it is a placeholder, not a published release. Terminal-only entries in `cli.json` use the same hash.

## Update intentionally

To move the suite forward, change the hash in **every** suite entry, in `opencode.jsonc` and `cli.json`, then restart the shared server so that it installs the new packages and every terminal reloads them:

```sh
opencode service restart
```

| Entry | What startup does |
| --- | --- |
| Full commit hash | Installs it once, then leaves it alone |
| Branch name | Installs it, and checks the branch for updates at startup without changing the installed package until you update |
| Local directory path | Loads your checkout; you manage its files and dependencies |

`opencode plugin check` reports which unpinned packages have updates; `opencode plugin update [target]` installs them. Neither touches a full-hash pin, which is the point of pinning.

After an update, read the commit log for the components you use: a component may change its commands, settings keys or footer text. Then try the interactions you rely on. Loader and unit tests establish what a test exercises, not full terminal certification.

## Roll back

1. Put the previous hash back in every suite entry, in both files.
2. Run `opencode service restart`.
3. Reproduce the workflow that regressed.

Rolling plugin code back does not undo files edited by an agent, remove logs under `~/.local/share/opencode/`, or guarantee older code can read state a newer component stored (tool-gate modes, btw threads, diff-review drafts and cache-guard clocks are kept per session). Keep normal Git commits and backups for your work.

## Remove a component

Delete its entry from `opencode.jsonc` or `cli.json`, or run `opencode plugin remove` with the configured specifier, then `opencode service restart`. Removal unregisters the plugin; it does not delete the component's settings files, logs or the data it kept in OpenCode's plugin storage.

## Maintainer flow

Source changes are published to the repository first, then the pins are bumped. The maintainer's dotfiles pin the suite with a `plugins pin opencode-plugins` helper; that helper is not part of this suite, and a plain hash edit does the same thing.
