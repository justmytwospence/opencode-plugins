// Minimal summary: `branch [*] [↑N] [↓N] [!]`.
// Zero terms are hidden; conflicts, paused operations and unreadable Git end in !.

import { execFile } from "node:child_process";
import path from "node:path";
import { stat } from "node:fs/promises";

export interface GitStatus {
  branch: string;
  worktree: boolean;
  conflicts: number;
  dirty: boolean;
  changed: number;
  upstream: boolean;
  upstreamMissing: boolean;
  ahead: number;
  behind: number;
  unavailable?: boolean;
  operation?: boolean;
}

/** A run of text in the status line; `color` names a theme color, or the line's own when absent. */
export interface Segment {
  text: string;
  color?: "text" | "error" | "warning" | "success" | "textMuted";
}

/** Parse `git status --porcelain=v2 --branch -z --untracked-files=all`. */
export function parseStatus(input: string | Buffer, worktree = false): GitStatus {
  // Latin-1 is a one-to-one byte mapping: path identity must survive invalid UTF-8.
  // Only human-readable branch headers are decoded as UTF-8 below.
  const output = Buffer.isBuffer(input) ? input.toString("latin1") : input;
  const status: GitStatus = { branch: "", worktree, conflicts: 0, dirty: false, changed: 0, upstream: false, upstreamMissing: false, ahead: 0, behind: 0 };
  const changed = new Set<string>();
  const conflicts = new Set<string>();
  const invalid = (): GitStatus => ({ ...status, branch: "", unavailable: true });
  if (!output.endsWith("\0")) return invalid();
  let oid = "";
  const headers = new Set<string>();
  const records = output.slice(0, -1).split("\0");
  const hash = "(?:[0-9a-f]{40}|[0-9a-f]{64})";
  const xy = "[.MADRCUT]{2}";
  const sub = "(?:N\\.\\.\\.|S[.C][.M][.U])";
  const mode = "[0-7]{6}";
  const ordinary = new RegExp(`^1 ${xy} ${sub} ${mode} ${mode} ${mode} ${hash} ${hash} ([\\s\\S]+)$`);
  const renamed = new RegExp(`^2 ${xy} ${sub} ${mode} ${mode} ${mode} ${hash} ${hash} [RC](?:100|[1-9]?[0-9]) ([\\s\\S]+)$`);
  const unmerged = new RegExp(`^u (?:DD|AU|UD|UA|DU|AA|UU) ${sub} ${mode} ${mode} ${mode} ${mode} ${hash} ${hash} ${hash} ([\\s\\S]+)$`);
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.startsWith("# ")) {
      const header = /^# ([\w.]+) ([^\n\r]+)$/.exec(record);
      if (!header || headers.has(header[1])) return invalid();
      const key = header[1];
      const value = Buffer.isBuffer(input) ? Buffer.from(header[2], "latin1").toString("utf8") : header[2];
      headers.add(key);
      if (key === "branch.head") {
        if (/\s/.test(value)) return invalid();
        status.branch = value;
      } else if (key === "branch.oid") {
        if (value !== "(initial)" && !new RegExp(`^${hash}$`).test(value)) return invalid();
        oid = value;
      } else if (key === "branch.upstream") {
        if (/\s/.test(value)) return invalid();
        status.upstream = true;
      } else if (key === "branch.ab") {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (!match) return invalid();
        status.ahead = Number(match[1]);
        status.behind = Number(match[2]);
        if (!Number.isSafeInteger(status.ahead) || !Number.isSafeInteger(status.behind)) return invalid();
      } else if (key.startsWith("branch.")) return invalid();
      continue;
    }
    // Match metadata without splitting paths: filenames may contain spaces or newlines.
    if (/^[?!] [\s\S]+$/.test(record)) {
      if (record[0] === "?") changed.add(record.slice(2));
      continue;
    }
    const match = ordinary.exec(record) ?? renamed.exec(record) ?? unmerged.exec(record);
    if (!match) return invalid();
    changed.add(match[1]);
    if (record[0] === "u") conflicts.add(match[1]);
    if (record[0] === "2" && !records[++i]) return invalid(); // Separate NUL source path.
  }
  if (!status.branch || !oid ||
      (status.branch === "(detached)" && (oid === "(initial)" || status.upstream)) ||
      (headers.has("branch.ab") && !status.upstream)) return invalid();
  status.upstreamMissing = status.upstream && oid !== "(initial)" && !headers.has("branch.ab");
  status.changed = changed.size;
  status.conflicts = conflicts.size;
  status.dirty = status.changed > 0;
  if (status.branch === "(detached)") status.branch = `detached:${oid.slice(0, 7)}`;
  return status;
}

/** The status line's segments, separated by single spaces. */
export function segments(s: GitStatus | undefined): Segment[] | undefined {
  if (!s || (!s.branch && !s.unavailable)) return undefined;
  if (!s.branch) return [{ text: "!", color: "error" }];
  const parts: Segment[] = [];
  if (s.branch) parts.push({ text: s.branch, color: "text" });
  if (s.dirty || s.changed || s.conflicts) parts.push({ text: "*", color: "warning" });
  if (s.ahead) parts.push({ text: `↑${s.ahead}`, color: "success" });
  if (s.behind) parts.push({ text: `↓${s.behind}`, color: "error" });
  if (s.conflicts || s.unavailable || s.operation) parts.push({ text: "!", color: "error" });
  return parts.flatMap((p, i) => (i ? [{ text: " " }, p] : [p]));
}

interface GitResult {
  output: Buffer;
  failed: boolean;
  outside: boolean;
}

function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile("git", ["--no-optional-locks", "-C", cwd, ...args], { encoding: "buffer", timeout: 10_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } }, (err, stdout, stderr) =>
      resolve({ output: stdout, failed: !!err, outside: !!err && err.code === 128 && /^fatal: not a git repository \(or any (?:of the parent directories|parent up to mount point [^\n]+)\)(?:: \.git)?\n(?:Stopping at filesystem boundary \(GIT_DISCOVERY_ACROSS_FILESYSTEM not set\)\.\n)?$/.test(stderr.toString("utf8")) }),
    );
  });
}

/** The status of the checkout at cwd; undefined only outside a repository. */
export async function readStatus(cwd: string): Promise<GitStatus | undefined> {
  const unavailable = (): GitStatus => ({ ...parseStatus(""), unavailable: true });
  const gitDir = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  if (gitDir.failed) return gitDir.outside ? undefined : unavailable();
  const directory = (output: Buffer): string | undefined => {
    const value = output.toString("utf8");
    if (!value.endsWith("\n")) return undefined;
    const dir = value.slice(0, -1); // Remove only Git's terminator, not path newlines.
    return path.isAbsolute(dir) && !dir.includes("\0") ? dir : undefined;
  };
  const dir = directory(gitDir.output);
  if (!dir) return unavailable();
  const commonDir = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (commonDir.failed) return unavailable();
  const common = directory(commonDir.output);
  if (!common) return unavailable();
  const out = await git(cwd, ["status", "--porcelain=v2", "--branch", "--ahead-behind", "--untracked-files=all", "-z"]);
  if (out.failed) return unavailable();
  const status = parseStatus(out.output, path.normalize(dir) !== path.normalize(common));
  if (status.unavailable) return status;
  // These markers are per-checkout, including linked worktrees. Use raw directory
  // bytes and remove only Git's final newline; never inspect the working tree.
  const admin = gitDir.output.subarray(0, -1);
  try {
    const markers = await Promise.all(["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "sequencer"].map(async (name) => {
      try {
        await stat(Buffer.concat([admin, Buffer.from(`${path.sep}${name}`)]));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    }));
    if (markers.some(Boolean)) status.operation = true;
  } catch {
    status.unavailable = true;
  }
  return status;
}

export const sameStatus = (a: GitStatus | undefined, b: GitStatus | undefined): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
