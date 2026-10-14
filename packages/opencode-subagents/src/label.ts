// Stable task names, independent of the agent role and any model calls (from pi-subagents).
import { stripVTControlCharacters } from "node:util";

function plain(text: string): string {
  return stripVTControlCharacters(text).replace(/\s+/gu, " ").replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").trim();
}

/** Normalize a supplied label, or derive one from the task's first nonempty line. */
export function taskLabel(task: string, label?: string): string {
  let text = label ? plain(label) : "";
  if (!text) {
    const first = task.replaceAll("{previous}", "").split(/\r?\n/u).map(plain).find(Boolean) ?? "";
    text = first.replace(/^(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/u, "").trim();
  }
  return text || "Task";
}

/** A short, filesystem- and branch-safe form of a label. */
export function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 24) || "task";
}

export function shortId(): string {
  return Math.random().toString(36).slice(2, 8);
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text;
}
