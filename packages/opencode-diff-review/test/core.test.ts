import { describe, expect, it } from "vitest";
import { anchorThread, hunkSpan, layout, nextOfKind, selectionFromRows, threadRows } from "../src/model.ts";
import { parseDiff, parsePatches, unquote } from "../src/parse.ts";
import { defaultScope, parseScopeArgs, resolveRange, type UserMessage } from "../src/review.ts";
import { attachReplies, buildPrompt, parseReplies, type Thread } from "../src/threads.ts";

export const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@ function top()
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
 const e = 6;
diff --git a/new file.md b/new file.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new file.md
@@ -0,0 +1,2 @@
+# Title
+text
\\ No newline at end of file
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 4444444..0000000
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-gone
diff --git a/x.bin b/x.bin
index 5555555..6666666 100644
Binary files a/x.bin and b/x.bin differ
diff --git a/from.ts b/to.ts
similarity index 100%
rename from from.ts
rename to to.ts
diff --git "a/tab\\there" "b/tab\\there"
index 7777777..8888888 100644
--- "a/tab\\there"
+++ "b/tab\\there"
@@ -1 +1 @@
-x
+y
`;

export function thread(over: Partial<Thread> = {}): Thread {
  return {
    id: "abcd",
    file: "src/a.ts",
    side: "new",
    start: 2,
    end: 3,
    excerpt: ["- const b = 2;", "+ const b = 3;", "+ const c = 4;"],
    body: "why 3?",
    status: "draft",
    createdAt: 1,
    ...over,
  };
}

describe("parseDiff", () => {
  const files = parseDiff(PATCH);
  it("finds every file with its status", () => {
    expect(files.map((f) => [f.status, f.newPath])).toEqual([
      ["modified", "src/a.ts"],
      ["added", "new file.md"],
      ["deleted", "old.txt"],
      ["modified", "x.bin"],
      ["renamed", "to.ts"],
      ["modified", "tab\there"],
    ]);
  });
  it("numbers lines on both sides and counts changes", () => {
    const a = files[0]!;
    expect(a.additions).toBe(2);
    expect(a.deletions).toBe(1);
    expect(a.hunks[0]!.section).toBe("function top()");
    expect(a.hunks[0]!.lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ["context", 1, 1],
      ["del", 2, undefined],
      ["add", undefined, 2],
      ["add", undefined, 3],
      ["context", 3, 4],
      ["context", 4, 5],
    ]);
  });
  it("marks no-newline, binary and renames", () => {
    expect(files[1]!.hunks[0]!.lines[1]!.noNewline).toBe(true);
    expect(files[3]!.binary).toBe(true);
    expect(files[4]).toMatchObject({ status: "renamed", oldPath: "from.ts", newPath: "to.ts", similarity: 100 });
  });
  it("unquotes C-style paths including octal UTF-8", () => {
    expect(unquote('"a\\tb"')).toBe("a\tb");
    expect(unquote('"caf\\303\\251"')).toBe("café");
  });
});

describe("parsePatches", () => {
  it("wraps OpenCode's header-less per-file patches", () => {
    const files = parsePatches([
      { file: "hello.txt", status: "added", patch: "--- /dev/null\n+++ b/hello.txt\n@@ -0,0 +1 @@\n+hi\n" },
      { file: "README.md", status: "modified", patch: "Index: README.md\n===================================================================\n--- README.md\n+++ README.md\n@@ -1 +1 @@\n-# a\n+# b\n" },
      { file: "gone.txt", status: "deleted", patch: "@@ -1 +0,0 @@\n-x\n" },
    ]);
    expect(files.map((f) => [f.status, f.newPath, f.oldPath, f.additions, f.deletions])).toEqual([
      ["added", "hello.txt", "hello.txt", 1, 0],
      ["modified", "README.md", "README.md", 1, 1],
      ["deleted", "gone.txt", "gone.txt", 0, 1],
    ]);
  });
  it("keeps a full git patch as it is", () => {
    const files = parsePatches([{ file: "src/a.ts", status: "modified", patch: PATCH.split("diff --git a/new file.md")[0]! }]);
    expect(files).toHaveLength(1);
    expect(files[0]!.hunks[0]!.lines).toHaveLength(6);
  });
});

describe("layout", () => {
  const files = parseDiff(PATCH);
  const base = { folded: new Set<string>(), expanded: new Set<string>(), threads: [] as Thread[], maxLines: 1000 };

  it("pairs removals with additions", () => {
    const { rows } = layout(files, base);
    const del = rows.find((r) => r.kind === "line" && r.file === 0 && r.line.kind === "del");
    expect(del?.kind === "line" && del.pair?.text).toBe("const b = 3;");
  });

  it("anchors threads under their last line, one row per line, and re-anchors moved text", () => {
    const { rows } = layout(files, { ...base, threads: [thread({ body: "why 3?\nreally" })] });
    const i = rows.findIndex((r) => r.kind === "thread");
    const prev = rows[i - 1]!;
    expect(prev.kind === "line" && prev.line.text).toBe("const c = 4;");
    const mine = rows.filter((r) => r.kind === "thread");
    expect(mine.map((r) => r.kind === "thread" && [r.part, r.text])).toEqual([
      ["head", "comment abcd · draft · L2-3"],
      ["body", "why 3?"],
      ["body", "really"],
    ]);

    const moved = thread({ start: 9, end: 9, excerpt: ["+ const c = 4;"] });
    const a = anchorThread(rows, 0, rows.length, moved);
    expect(a.outdated).toBe(false);
    const r = rows[a.after]!;
    expect(r.kind === "line" && r.line.newLine).toBe(3);
  });

  it("shows suggestions and replies, and collects threads on files outside the diff", () => {
    const t = thread({ file: "elsewhere.ts", suggestion: "const c = 5;", body: "", status: "answered", reply: "done" });
    const { rows, orphanStart } = layout(files, { ...base, threads: [t] });
    expect(orphanStart).toBeDefined();
    expect(rows.slice(orphanStart! + 1).map((r) => r.kind === "thread" && [r.part, r.text, r.outdated])).toEqual([
      ["head", "suggestion abcd · answered · L2-3 · outdated", true],
      ["suggestion", "const c = 5;", true],
      ["reply", "done", true],
    ]);
    expect(threadRows(0, thread({ suggestion: "" }), false).map((r) => r.kind === "thread" && r.text)).toContain("(delete these lines)");
  });

  it("folds files and hides large ones behind a note", () => {
    const folded = layout(files, { ...base, folded: new Set(["src/a.ts"]) });
    expect(folded.rows[1]!.kind).toBe("file");
    const big = layout(files, { ...base, maxLines: 2 });
    expect(big.rows[1]).toMatchObject({ kind: "note", expand: true });
  });

  it("turns a row span into a selection on the new side", () => {
    const { rows } = layout(files, base);
    const from = rows.findIndex((r) => r.kind === "line" && r.line.kind === "del");
    const sel = selectionFromRows(rows, from, from + 2);
    expect(sel).toMatchObject({ side: "new", start: 2, end: 3 });
    expect(sel?.excerpt).toEqual(["- const b = 2;", "+ const b = 3;", "+ const c = 4;"]);
    const onlyDel = selectionFromRows(rows, from, from);
    expect(onlyDel).toMatchObject({ side: "old", start: 2, end: 2 });
    expect(selectionFromRows(rows, 0, 0)).toBeUndefined();
  });

  it("finds hunks and files from the cursor", () => {
    const { rows } = layout(files, base);
    const hunk = nextOfKind(rows, 0, "hunk", 1)!;
    expect(rows[hunk]!.kind).toBe("hunk");
    expect(hunkSpan(rows, hunk)).toEqual([hunk + 1, hunk + 6]);
    expect(nextOfKind(rows, 0, "file", 1)).toBe(rows.findIndex((r, i) => i > 0 && r.kind === "file"));
    expect(nextOfKind(rows, 0, "file", -1)).toBeUndefined();
  });
});

describe("threads", () => {
  it("builds a prompt that quotes the lines and asks for tagged replies", () => {
    const p = buildPrompt([thread(), thread({ id: "wxyz", suggestion: "const c = 5;", body: "" })], "last turn");
    expect(p).toContain("I reviewed your changes (last turn) and left 2 comments.");
    expect(p).toContain("[[dr:abcd]] `src/a.ts` lines 2-3");
    expect(p).toContain("```diff\n- const b = 2;");
    expect(p).toContain("Replace:\n```ts\nconst b = 2;\nconst b = 3;\nconst c = 4;\n```\nwith:\n```ts\nconst c = 5;\n```");
    expect(p).toMatch(/\[\[dr:wxyz\]\] <what you changed/);
  });
  it("parses replies, ignoring the template line", () => {
    const r = parseReplies("Done.\n\n- [[dr:abcd]] Changed it to 3.\n[[dr:wxyz]]: applied\n[[dr:zzzz]] <what you changed, or your answer>");
    expect([...r]).toEqual([
      ["abcd", "Changed it to 3."],
      ["wxyz", "applied"],
    ]);
  });
  it("attaches replies to sent threads only", () => {
    const sent = thread({ status: "sent" });
    const draft = thread({ id: "wxyz" });
    expect(attachReplies([sent, draft], "[[dr:abcd]] fixed\n[[dr:wxyz]] ignored")).toBe(true);
    expect(sent).toMatchObject({ status: "answered", reply: "fixed" });
    expect(draft.status).toBe("draft");
    expect(attachReplies([sent], "nothing")).toBe(false);
  });
});

describe("scopes", () => {
  const users: UserMessage[] = [
    { id: "m1", text: "add a hello file", created: 1 },
    { id: "m2", text: "now  rename   it", created: 2 },
    { id: "m3", text: "x".repeat(80), created: 3 },
  ];

  it("understands scope words", () => {
    expect(parseScopeArgs("")).toBeUndefined();
    expect(parseScopeArgs("turn 2")).toEqual({ kind: "turn", turn: 2 });
    expect(parseScopeArgs("last")).toEqual({ kind: "turn", turn: 1 });
    expect(parseScopeArgs("head")).toEqual({ kind: "head" });
    expect(parseScopeArgs("all")).toEqual({ kind: "session" });
    expect(parseScopeArgs("bogus")).toBeUndefined();
    expect(defaultScope([])).toEqual({ kind: "head" });
    expect(defaultScope(users)).toEqual({ kind: "unreviewed" });
  });

  it("resolves turn ranges against the user messages and the mark", () => {
    expect(resolveRange({ kind: "unreviewed" }, users, undefined)).toEqual({ kind: "turns", from: "m1", to: "m3", label: "unreviewed, since the session began (3 turns)" });
    expect(resolveRange({ kind: "unreviewed" }, users, { through: "m2", at: 1000 }, 61_000)).toEqual({ kind: "turns", from: "m3", to: "m3", label: "unreviewed, since your review 1m ago (1 turn)" });
    expect(resolveRange({ kind: "unreviewed" }, users, { through: "m3", at: 0 })).toBe("nothing unreviewed since your last review mark");
    // A mark from a message no longer in the list (forked away) counts as no mark.
    expect(resolveRange({ kind: "unreviewed" }, users, { through: "gone", at: 0 })).toMatchObject({ from: "m1", to: "m3" });
    expect(resolveRange({ kind: "session" }, users, undefined)).toMatchObject({ from: "m1", to: "m3" });
    expect(resolveRange({ kind: "turn" }, users, undefined)).toEqual({ kind: "turns", from: "m3", label: `last turn: ${"x".repeat(47)}…` });
    expect(resolveRange({ kind: "turn", turn: 2 }, users, undefined)).toEqual({ kind: "turns", from: "m2", label: "turn -2: now rename it" });
    expect(resolveRange({ kind: "turn", turn: 9 }, users, undefined)).toMatchObject({ from: "m1" });
    expect(resolveRange({ kind: "turn" }, [], undefined)).toBe("no turns in this session yet");
    expect(resolveRange({ kind: "head" }, [], undefined)).toEqual({ kind: "vcs", mode: "working", label: "uncommitted vs HEAD" });
    expect(resolveRange({ kind: "branch" }, [], undefined)).toMatchObject({ kind: "vcs", mode: "branch" });
  });
});
