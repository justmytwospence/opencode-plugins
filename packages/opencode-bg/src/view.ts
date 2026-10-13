// What the /bg panel shows, as plain data: the rows (running first, oldest first; then ended,
// newest first), each with colored segments. tui.ts turns them into OpenTUI elements.
import { type TaskView, outcome, runtime } from "./format.ts";

export type Color = "base" | "muted" | "accent" | "success" | "warning" | "error";
export interface Segment {
  text: string;
  color: Color;
}

/** Running tasks first (oldest first), then what ended (newest first). */
export function ordered(tasks: readonly TaskView[]): TaskView[] {
  const running = tasks.filter((t) => t.status === "running").sort((a, b) => a.startedAt - b.startedAt);
  const ended = tasks.filter((t) => t.status !== "running").sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  return [...running, ...ended];
}

/** The color of a task's state. */
export function stateColor(t: Pick<TaskView, "status" | "kind" | "ready">): Color {
  switch (t.status) {
    case "running":
      return t.kind === "service" && !t.ready ? "warning" : "success";
    case "done":
      return "muted";
    case "killed":
      return "muted";
    default:
      return "error";
  }
}

/** `waiting · ready · 2:14`: what the task is doing and for how long. */
export function stats(t: TaskView, now: number): string {
  if (t.status !== "running") return `${outcome(t)} · ${runtime(t, now)}`;
  const bits: string[] = [];
  if (t.waiting) bits.push("waiting");
  if (t.kind === "service") bits.push(t.ready ? "ready" : t.readyPattern ? "starting" : "service");
  if (t.keep) bits.push("kept");
  bits.push(runtime(t, now));
  return bits.join(" · ");
}

/** One task's row: the marker, its name, kind and state; the command goes on the line under it. */
export function row(t: TaskView, now: number, selected: boolean): Segment[] {
  return [
    { text: selected ? "> " : "  ", color: "accent" },
    { text: t.name, color: selected ? "accent" : "base" },
    { text: ` ${t.kind}`, color: "muted" },
    { text: "  ", color: "muted" },
    { text: stats(t, now), color: stateColor(t) },
  ];
}

/** The command under a row, on one line, cut to the width. */
export function commandLine(t: TaskView, width: number): string {
  const text = `    ${t.command.replace(/\s+/gu, " ").trim()}`;
  return text.length > width && width > 4 ? `${text.slice(0, width - 1)}…` : text;
}

/** The panel's one-line summary: `2 running · 1 failed`. */
export function summary(tasks: readonly TaskView[]): string {
  const running = tasks.filter((t) => t.status === "running").length;
  const failed = tasks.filter((t) => t.status === "failed" || t.status === "timeout").length;
  const ended = tasks.length - running;
  const bits = [`${running} running`];
  if (ended) bits.push(`${ended} ended${failed ? ` (${failed} failed)` : ""}`);
  return bits.join(" · ");
}
