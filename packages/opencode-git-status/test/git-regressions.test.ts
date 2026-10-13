import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseStatus, readStatus, segments } from "../src/git.js";

const text = (s: ReturnType<typeof segments>) => s?.map((p) => p.text).join("");
const statusArgs = ["status", "--porcelain=v2", "--branch", "--ahead-behind", "--untracked-files=all", "-z"];
const rawStatus = (repo: string) => execFileSync("git", ["--no-optional-locks", "-C", repo, ...statusArgs], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, LC_ALL: "C" },
});

async function fixture(
  run: (repo: string, git: (...args: string[]) => string) => Promise<void>,
  { name = "repo" }: { name?: string } = {},
) {
  const dir = mkdtempSync(path.join(tmpdir(), "ogs-regressions-"));
  try {
    expect(await readStatus(dir)).toBeUndefined();
    const repo = path.join(dir, name);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    const git = (...args: string[]) => execFileSync("git", ["--no-optional-locks", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git("commit", "-q", "--allow-empty", "-m", "initial");
    await run(repo, git);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("real Git regressions", () => {
  it("keeps a non-unborn branch and change counts when its configured upstream ref is pruned", async () => {
    await fixture(async (repo, git) => {
      writeFileSync(path.join(repo, "tracked"), "initial\n");
      git("add", "tracked");
      git("commit", "-q", "-m", "tracked file");
      git("remote", "add", "origin", ".");
      git("update-ref", "refs/remotes/origin/topic", "HEAD");
      git("branch", "--set-upstream-to=origin/topic", "main");
      const before = await readStatus(repo);
      expect(before).toMatchObject({ branch: "main", upstream: true, upstreamMissing: false, ahead: 0, behind: 0 });
      expect(text(segments(before))).toBe("main");

      // The local-only remote has no topic branch, so fetch really prunes its tracking ref.
      git("fetch", "-q", "--prune", "origin");
      expect(() => git("show-ref", "--verify", "--quiet", "refs/remotes/origin/topic")).toThrow();
      expect(git("config", "--get", "branch.main.remote").trim()).toBe("origin");
      expect(git("config", "--get", "branch.main.merge").trim()).toBe("refs/heads/topic");
      writeFileSync(path.join(repo, "tracked"), "staged\n");
      git("add", "tracked");
      writeFileSync(path.join(repo, "tracked"), "unstaged\n");
      writeFileSync(path.join(repo, "new"), "untracked\n");

      const output = git(...statusArgs);
      expect(output).not.toContain("# branch.oid (initial)\0");
      expect(output).toContain("# branch.upstream origin/topic\0");
      expect(output).not.toContain("# branch.ab ");
      for (const s of [parseStatus(output), await readStatus(repo)]) {
        expect(s).toMatchObject({ branch: "main", worktree: false, conflicts: 0, dirty: true, changed: 2, upstream: true, upstreamMissing: true, ahead: 0, behind: 0 });
        expect(s?.unavailable).not.toBe(true);
        const summary = text(segments(s));
        expect(summary).toBe("main *");
        expect(summary).not.toContain("!");
        expect(summary).not.toMatch(/[↑↓]/);
      }
    });
  });

  it("reads checkout paths with embedded newlines and still detects a linked worktree", async () => {
    await fixture(async (repo, git) => {
      const main = await readStatus(repo);
      expect(main).toMatchObject({ branch: "main", worktree: false, changed: 0, dirty: false, upstreamMissing: false });
      expect(main?.unavailable).not.toBe(true);
      expect(text(segments(main))).toBe("main");

      const worktree = path.join(repo, "..", "linked\ncheckout");
      git("worktree", "add", "-q", "-b", "feature", worktree);
      const clean = await readStatus(worktree);
      expect(clean).toMatchObject({ branch: "feature", worktree: true, changed: 0, dirty: false, upstreamMissing: false });
      expect(clean?.unavailable).not.toBe(true);
      expect(text(segments(clean))).toBe("feature");
      writeFileSync(path.join(worktree, "new"), "untracked\n");
      const dirty = await readStatus(worktree);
      expect(dirty).toMatchObject({ branch: "feature", worktree: true, changed: 1, dirty: true, upstreamMissing: false });
      expect(dirty?.unavailable).not.toBe(true);
      expect(text(segments(dirty))).toBe("feature *");
      expect(await readStatus(repo)).toMatchObject({ branch: "main", worktree: false, changed: 0, dirty: false, upstreamMissing: false });
    }, { name: "repo\ncheckout" });
  });

  it("accepts the legal branch name '(topic' rather than treating it as a sentinel", async () => {
    await fixture(async (repo, git) => {
      expect(git("check-ref-format", "--branch", "(topic").trim()).toBe("(topic");
      git("branch", "-m", "(topic");
      writeFileSync(path.join(repo, "new"), "untracked\n");
      for (const s of [parseStatus(git(...statusArgs)), await readStatus(repo)]) {
        expect(s).toMatchObject({ branch: "(topic", worktree: false, conflicts: 0, dirty: true, changed: 1, upstream: false, upstreamMissing: false, ahead: 0, behind: 0 });
        expect(s?.unavailable).not.toBe(true);
        expect(text(segments(s))).toBe("(topic *");
      }
    });
  });

  it.skipIf(process.platform === "win32")("counts distinct raw FF and FE filenames without corrupting a UTF-8 branch", async ({ skip }) => {
    await fixture(async (repo, git) => {
      const branch = "café/日本語";
      git("branch", "-m", branch);
      const prefix = Buffer.from(`${repo}${path.sep}`);
      try {
        for (const byte of [0xff, 0xfe]) {
          // Keep the filename byte literal: decoding either byte as UTF-8 would yield the same replacement character.
          writeFileSync(Buffer.concat([prefix, Buffer.from([byte])]), "untracked\n");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EILSEQ") skip("Filesystem rejects non-UTF-8 filenames");
        throw error;
      }
      const output = rawStatus(repo);
      expect(output.includes(Buffer.from([0x3f, 0x20, 0xff, 0x00]))).toBe(true);
      expect(output.includes(Buffer.from([0x3f, 0x20, 0xfe, 0x00]))).toBe(true);
      expect(output.includes(Buffer.from(`# branch.head ${branch}\0`, "utf8"))).toBe(true);
      for (const s of [parseStatus(output), await readStatus(repo)]) {
        expect(s).toMatchObject({ branch, worktree: false, conflicts: 0, dirty: true, changed: 2, upstream: false, upstreamMissing: false, ahead: 0, behind: 0 });
        expect(s?.unavailable).not.toBe(true);
        expect(text(segments(s))).toBe(`${branch} *`);
      }
    });
  });

  it("reports ! when a linked worktree's admin directory is removed but its .git remains", async () => {
    await fixture(async (repo, git) => {
      const worktree = path.join(repo, "..", "broken-linked");
      git("worktree", "add", "-q", "-b", "feature", worktree);
      expect(await readStatus(worktree)).toMatchObject({ branch: "feature", worktree: true, upstreamMissing: false });
      const gitFile = path.join(worktree, ".git");
      const pointer = readFileSync(gitFile, "utf8");
      const adminDir = pointer.replace(/^gitdir: /, "").replace(/\n$/, "");
      expect(path.isAbsolute(adminDir)).toBe(true);
      expect(pointer).toBe(`gitdir: ${adminDir}\n`);
      rmSync(adminDir, { recursive: true });
      expect(readFileSync(gitFile, "utf8")).toBe(pointer);

      const s = await readStatus(worktree);
      expect(s).toBeDefined();
      expect(s).toMatchObject({ unavailable: true, upstreamMissing: false });
      expect(text(segments(s))).toBe("!");
      expect(await readStatus(repo)).toMatchObject({ branch: "main", worktree: false, upstreamMissing: false });
    });
  });
});
