import type { Mode } from "./core/watcher.js";

/**
 * MARIMO_NOTEBOOK=<path>[,<path>...] follows those notebooks, =off turns the plugin off; unset
 * follows every notebook open under the project.
 */
export function modeFromEnv(env: NodeJS.ProcessEnv = process.env): Mode {
  const pinned = env.MARIMO_NOTEBOOK?.trim();
  if (pinned === "off") return { kind: "off" };
  const paths = (pinned ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  return paths.length ? { kind: "pinned", paths } : { kind: "auto" };
}
