import type { Mode } from "./core/watcher.ts";

/**
 * `<path>[,<path>...]` follows those notebooks, `off` turns the plugin off; empty or unset follows
 * every notebook open under the project. Read from `MARIMO_NOTEBOOK` in the server's environment
 * and from the plugin option `notebook` (the same syntax), which wins when set.
 */
export function modeFromEnv(env: NodeJS.ProcessEnv = process.env, options: Record<string, unknown> = {}): Mode {
  const raw = typeof options.notebook === "string" ? options.notebook : env.MARIMO_NOTEBOOK;
  const pinned = raw?.trim();
  if (pinned === "off") return { kind: "off" };
  const paths = (pinned ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  return paths.length ? { kind: "pinned", paths } : { kind: "auto" };
}
