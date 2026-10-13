import { expect, test, vi } from "vitest";

vi.mock("@opencode/plugin/tui", () => ({ Plugin: { define: (p: unknown) => p } }));
vi.mock("@opentui/solid/jsx-runtime", () => ({ jsx: () => null }));
const { marks } = await import("../src/tui.ts");

const base = { branch: "main", worktree: false, conflicts: 0, dirty: false, changed: 0, upstream: true, upstreamMissing: false, ahead: 0, behind: 0 };

test("the footer gets only the marks: OpenCode already shows the branch", () => {
  expect(marks(undefined)).toBeUndefined();
  expect(marks(base)).toBeUndefined();
  expect(marks({ ...base, dirty: true, ahead: 1 })?.map((s) => s.text).join("")).toBe("* ↑1");
  expect(marks({ ...base, branch: "", unavailable: true })?.map((s) => s.text).join("")).toBe("!");
});
