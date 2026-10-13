import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readStatus, segments } from "../src/git.js";

const text = (s: Awaited<ReturnType<typeof readStatus>>) => segments(s)?.map((part) => part.text).join("");

async function fixture(run: (repo: string, git: (...args: string[]) => string) => Promise<void>) {
  const dir = mkdtempSync(path.join(tmpdir(), "ogs-operations-"));
  try {
    const repo = path.join(dir, "repo\ncheckout");
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    const git = (...args: string[]) => execFileSync("git", ["--no-optional-locks", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    writeFileSync(path.join(repo, "file"), "base\n");
    git("add", ".");
    git("commit", "-qm", "base");
    git("checkout", "-qb", "other");
    writeFileSync(path.join(repo, "file"), "other\n");
    git("commit", "-qam", "other");
    git("checkout", "-q", "main");
    writeFileSync(path.join(repo, "file"), "main\n");
    git("commit", "-qam", "main");
    await run(repo, git);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("paused Git operations", () => {
  it.each([
    { name: "merge", args: ["merge", "other"], abort: ["merge", "--abort"] },
    { name: "cherry-pick", args: ["cherry-pick", "other"], abort: ["cherry-pick", "--abort"] },
    { name: "merge-backend rebase", args: ["rebase", "--merge", "other"], abort: ["rebase", "--abort"] },
    { name: "apply-backend rebase", args: ["rebase", "--apply", "other"], abort: ["rebase", "--abort"] },
  ])("keeps ! after resolving $name conflicts, even with a clean index", async ({ args, abort }) => {
    await fixture(async (repo, git) => {
      expect(() => git(...args)).toThrow();
      const conflicted = await readStatus(repo);
      expect(conflicted).toMatchObject({ dirty: true, conflicts: 1, operation: true });
      expect(text(conflicted)).toBe(`${conflicted?.branch} * !`);
      // Resolving to HEAD makes the index and working tree clean but leaves the operation paused.
      writeFileSync(path.join(repo, "file"), git("show", "HEAD:file"));
      git("add", "file");
      const resolved = await readStatus(repo);
      expect(resolved).toMatchObject({ dirty: false, conflicts: 0, operation: true });
      expect(text(resolved)).toBe(`${resolved?.branch} !`);
      git(...abort);
      expect(text(await readStatus(repo))).toBe("main");
    });
  });

  it("keeps linked-worktree operations separate from the main checkout", async () => {
    await fixture(async (repo, git) => {
      const linked = path.join(repo, "..", "linked\ncheckout");
      git("worktree", "add", "-qb", "feature", linked);
      expect(() => execFileSync("git", ["-C", linked, "-c", "user.name=t", "-c", "user.email=t@t", "merge", "other"], { stdio: "pipe" })).toThrow();
      const s = await readStatus(linked);
      expect(s).toMatchObject({ branch: "feature", worktree: true, operation: true, conflicts: 1 });
      expect(text(s)).toBe("feature * !");
      expect(text(await readStatus(repo))).toBe("main");
    });
  });
});
