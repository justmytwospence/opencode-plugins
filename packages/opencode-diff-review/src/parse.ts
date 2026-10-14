// Parse unified diff text into files, hunks and numbered lines. Ported from pi-diff-review's
// parse.ts; OpenCode's `session.diff` and `vcs.diff` give one patch per file, which may or may
// not start with a `diff --git` header, so `parsePatches` wraps each in one when it does not.

export type FileStatus = "added" | "deleted" | "modified" | "renamed" | "copied";

export type LineKind = "context" | "add" | "del";

export interface DiffLine {
  kind: LineKind;
  text: string;
  /** Line number in the old file (context and del). */
  oldLine?: number;
  /** Line number in the new file (context and add). */
  newLine?: number;
  /** The line has no trailing newline in its file. */
  noNewline?: boolean;
}

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Text after the second @@ (the enclosing function, when git finds one). */
  section: string;
  lines: DiffLine[];
}

export interface FileDiff {
  oldPath: string;
  newPath: string;
  status: FileStatus;
  binary: boolean;
  oldBlob?: string;
  newBlob?: string;
  oldMode?: string;
  newMode?: string;
  similarity?: number;
  hunks: Hunk[];
  additions: number;
  deletions: number;
}

/** The path a file is known by: its new path, or the old one when deleted. */
export function filePath(f: FileDiff): string {
  return f.status === "deleted" ? f.oldPath : f.newPath;
}

/** Undo git's C-style quoting of a path ("a/b\tc" with octal escapes). */
export function unquote(s: string): string {
  if (!s.startsWith('"') || !s.endsWith('"')) return s;
  const body = s.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string;
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"));
      continue;
    }
    const n = body[++i];
    const simple: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 };
    if (n !== undefined && n in simple) bytes.push(simple[n] as number);
    else if (n !== undefined && /[0-7]/.test(n)) {
      const oct = body.slice(i, i + 3);
      bytes.push(Number.parseInt(oct, 8));
      i += 2;
    } else if (n !== undefined) bytes.push(...Buffer.from(n, "utf8"));
  }
  return Buffer.from(bytes).toString("utf8");
}

function stripPrefix(p: string, prefix: string): string {
  const u = unquote(p);
  return u.startsWith(prefix) ? u.slice(prefix.length) : u;
}

/** Paths from `diff --git a/x b/y`, used only when no ---/+++ or rename lines name them. */
function pathsFromHeader(rest: string): [string, string] | undefined {
  if (rest.startsWith('"')) {
    const m = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*"|.*)$/.exec(rest);
    if (m) return [stripPrefix(m[1] as string, "a/"), stripPrefix(m[2] as string, "b/")];
  }
  // Unquoted: both sides are the same path for non-renames, so split in the middle.
  if (rest.startsWith("a/")) {
    const half = (rest.length - 1) / 2;
    if (Number.isInteger(half) && rest[half] === " " && rest.slice(2, half) === rest.slice(half + 3)) {
      return [rest.slice(2, half), rest.slice(half + 3)];
    }
    const idx = rest.indexOf(" b/");
    if (idx > 0) return [rest.slice(2, idx), rest.slice(idx + 3)];
  }
  return undefined;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

export function parseDiff(patch: string): FileDiff[] {
  const files: FileDiff[] = [];
  const lines = patch.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  let file: FileDiff | undefined;
  let hunk: Hunk | undefined;
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const paths = pathsFromHeader(line.slice("diff --git ".length));
      file = {
        oldPath: paths?.[0] ?? "",
        newPath: paths?.[1] ?? "",
        status: "modified",
        binary: false,
        hunks: [],
        additions: 0,
        deletions: 0,
      };
      files.push(file);
      hunk = undefined;
      continue;
    }
    if (!file) continue;

    if (hunk && (oldLeft > 0 || newLeft > 0 || line.startsWith("\\"))) {
      const c = line[0];
      if (c === "\\") {
        const last = hunk.lines[hunk.lines.length - 1];
        if (last) last.noNewline = true;
        continue;
      }
      if (c === " " || (c === undefined && line === "")) {
        hunk.lines.push({ kind: "context", text: line.slice(1), oldLine: oldNo++, newLine: newNo++ });
        oldLeft--;
        newLeft--;
        continue;
      }
      if (c === "-") {
        hunk.lines.push({ kind: "del", text: line.slice(1), oldLine: oldNo++ });
        file.deletions++;
        oldLeft--;
        continue;
      }
      if (c === "+") {
        hunk.lines.push({ kind: "add", text: line.slice(1), newLine: newNo++ });
        file.additions++;
        newLeft--;
        continue;
      }
    }

    const h = HUNK_RE.exec(line);
    if (h) {
      hunk = {
        oldStart: Number(h[1]),
        oldCount: h[2] === undefined ? 1 : Number(h[2]),
        newStart: Number(h[3]),
        newCount: h[4] === undefined ? 1 : Number(h[4]),
        section: h[5] ?? "",
        lines: [],
      };
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      oldLeft = hunk.oldCount;
      newLeft = hunk.newCount;
      file.hunks.push(hunk);
      continue;
    }

    const index = /^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: (\d+))?$/.exec(line);
    if (index) {
      file.oldBlob = index[1];
      file.newBlob = index[2];
      if (index[3]) file.oldMode = file.newMode = index[3];
    } else if (line.startsWith("--- ")) {
      const p = line.slice(4);
      if (p !== "/dev/null") file.oldPath = stripPrefix(p, "a/");
    } else if (line.startsWith("+++ ")) {
      const p = line.slice(4);
      if (p !== "/dev/null") file.newPath = stripPrefix(p, "b/");
    } else if (line.startsWith("new file mode ")) {
      file.status = "added";
      file.newMode = line.slice("new file mode ".length);
    } else if (line.startsWith("deleted file mode ")) {
      file.status = "deleted";
      file.oldMode = line.slice("deleted file mode ".length);
    } else if (line.startsWith("old mode ")) {
      file.oldMode = line.slice("old mode ".length);
    } else if (line.startsWith("new mode ")) {
      file.newMode = line.slice("new mode ".length);
    } else if (line.startsWith("rename from ")) {
      file.status = "renamed";
      file.oldPath = unquote(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) {
      file.status = "renamed";
      file.newPath = unquote(line.slice("rename to ".length));
    } else if (line.startsWith("copy from ")) {
      file.status = "copied";
      file.oldPath = unquote(line.slice("copy from ".length));
    } else if (line.startsWith("copy to ")) {
      file.status = "copied";
      file.newPath = unquote(line.slice("copy to ".length));
    } else if (line.startsWith("similarity index ")) {
      file.similarity = Number.parseInt(line.slice("similarity index ".length), 10);
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      file.binary = true;
    }
  }
  for (const f of files) {
    if (f.status === "added" && !f.oldPath) f.oldPath = f.newPath;
    if (f.status === "deleted" && !f.newPath) f.newPath = f.oldPath;
  }
  return files;
}

/** One file's diff as OpenCode reports it (`FileDiff.Info`). */
export interface PatchInfo {
  file: string;
  patch: string;
  status: "added" | "deleted" | "modified";
}

/**
 * The files of OpenCode's per-file patches. A patch without a `diff --git` header (a plain
 * `---`/`+++` patch, or hunks alone) gets one from its `file` and `status`; a file without
 * hunks is kept as its header only.
 */
export function parsePatches(patches: readonly PatchInfo[]): FileDiff[] {
  const out: FileDiff[] = [];
  for (const p of patches) {
    const text = p.patch ?? "";
    let parsed: FileDiff[];
    if (/^diff --git /m.test(text)) parsed = parseDiff(text);
    else {
      const header = [`diff --git a/${p.file} b/${p.file}`];
      if (p.status === "added") header.push("new file mode 100644");
      if (p.status === "deleted") header.push("deleted file mode 100644");
      // Drop a `diff` library's "Index:" banner; keep ---/+++ and hunks.
      const body = text
        .split("\n")
        .filter((l) => !l.startsWith("Index: ") && !/^=+$/.test(l))
        .join("\n");
      parsed = parseDiff(`${header.join("\n")}\n${body}`);
    }
    for (const f of parsed) {
      if (!f.oldPath && !f.newPath) f.oldPath = f.newPath = p.file;
      if (f.status === "modified" && p.status !== "modified") f.status = p.status;
      out.push(f);
    }
  }
  return out;
}
