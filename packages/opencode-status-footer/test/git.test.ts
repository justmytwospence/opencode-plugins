import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseStatus, readStatus, sameStatus, segments } from "../src/git.js";

const text = (s: ReturnType<typeof segments>) => s?.map((p) => p.text).join("");
const oid = "aabbccddeeff".padEnd(40, "0");
const hashes = ["a", "b", "c"].map((c) => c.repeat(40));
const nul = (...records: string[]) => [...records, ""].join("\0");
const headers = [`# branch.oid ${oid}`, "# branch.head main"];
const tracked = (name: string, xy = ".M") => `1 ${xy} N... 100644 100644 100644 ${hashes[0]} ${hashes[1]} ${name}`;
const renamed = (name: string) => `2 RM N... 100644 100644 100644 ${hashes[0]} ${hashes[1]} R100 ${name}`;
const conflict = (name: string) => `u UU N... 100644 100644 100644 100644 ${hashes[0]} ${hashes[1]} ${hashes[2]} ${name}`;
const status = (...records: string[]) => parseStatus(nul(...headers, "# branch.upstream origin/main", "# branch.ab +0 -0", ...records));

describe("parseStatus", () => {
  it("reads branch, upstream, ahead/behind, conflicts and unique changes", () => {
    const s = parseStatus(nul(`# branch.oid ${oid}`, "# branch.head feat/x", "# branch.upstream origin/feat/x", "# branch.ab +2 -3",
      conflict("f"), "? new"));
    expect(s).toEqual({ branch: "feat/x", worktree: false, conflicts: 1, dirty: true, changed: 2, upstream: true, upstreamMissing: false, ahead: 2, behind: 3 });
  });
  it.each([oid, "f".repeat(64)])("names a detached head by its commit %s", (commit) => {
    const s = parseStatus(nul(`# branch.oid ${commit}`, "# branch.head (detached)"));
    expect(s.branch).toBe(`detached:${commit.slice(0, 7)}`);
    expect(s.unavailable).not.toBe(true);
  });
  it("counts staged and unstaged changes to a path only once", () => {
    expect(status(tracked("both", "MM"), tracked("staged", "M."), tracked("unstaged"), "? new").changed).toBe(4);
    expect(status(tracked("same", "M."), tracked("same")).changed).toBe(1);
  });
  it("counts conflicts as changes even without other dirty paths", () => {
    expect(status(conflict("f"), conflict("f"))).toMatchObject({ conflicts: 1, changed: 1, dirty: true });
  });
  it("skips a rename's source field under -z", () => {
    const s = status(renamed("new"), "u odd-source-name\n? fake", "? other");
    expect(s).toMatchObject({ conflicts: 0, changed: 2, dirty: true });
  });
  it("splits only NUL, preserving spaces and newline filenames", () => {
    const s = status(tracked("name\nu UU fake\n? fake"), "? untracked\n# branch.head fake", "? spaced name");
    expect(s).toMatchObject({ branch: "main", conflicts: 0, changed: 3 });
  });
  it("preserves raw path bytes while decoding UTF-8 branch headers", () => {
    const output = Buffer.concat([
      Buffer.from(nul(`# branch.oid ${oid}`, "# branch.head café/日本語")),
      Buffer.from([0x3f, 0x20, 0xff, 0x00, 0x3f, 0x20, 0xfe, 0x00]),
    ]);
    const s = parseStatus(output);
    expect(s).toMatchObject({ branch: "café/日本語", changed: 2, dirty: true, upstreamMissing: false });
    expect(s.unavailable).not.toBe(true);
  });
  it("ignores ignored paths", () => {
    expect(status("! ignored", "! hidden\nu UU fake\n# branch.head fake")).toMatchObject({ branch: "main", changed: 0, conflicts: 0, dirty: false });
  });
  it("deduplicates literal paths without trimming or interpreting filename contents", () => {
    const name = "  # branch.head fake\n? fake\t ";
    const s = status(tracked(name, "M."), tracked(name), `? ${name}`, "? spaced name", "? spaced name ");
    expect(s).toMatchObject({ branch: "main", conflicts: 0, changed: 3, dirty: true });
    expect(s.unavailable).not.toBe(true);
  });
  it.each([oid, "f".repeat(64), "(initial)"])("accepts branch.oid %s", (commit) => {
    const s = parseStatus(nul(`# branch.oid ${commit}`, "# branch.head main"));
    expect(s).toEqual({ branch: "main", worktree: false, conflicts: 0, dirty: false, changed: 0, upstream: false, upstreamMissing: false, ahead: 0, behind: 0 });
  });
  it("allows an unborn branch's upstream without branch.ab", () => {
    const s = parseStatus(nul("# branch.oid (initial)", "# branch.head main", "# branch.upstream origin/main"));
    expect(s).toMatchObject({ branch: "main", upstream: true, ahead: 0, behind: 0 });
    expect(s.unavailable).not.toBe(true);
  });
  it("preserves status when the configured upstream ref is missing", () => {
    const s = parseStatus(nul(...headers, "# branch.upstream origin/main", "? changed"));
    expect(s).toMatchObject({ branch: "main", upstream: true, upstreamMissing: true, changed: 1 });
    expect(s.unavailable).not.toBe(true);
    expect(text(segments(s))).toBe("main *");
  });
  it("allows branch names starting with a parenthesis", () => {
    const s = parseStatus(nul(`# branch.oid ${oid}`, "# branch.head (topic"));
    expect(s.branch).toBe("(topic");
    expect(s.unavailable).not.toBe(true);
  });
  it("allows unknown non-branch headers", () => {
    const s = status("# stash 2", "# future.header value");
    expect(s.branch).toBe("main");
    expect(s.unavailable).not.toBe(true);
  });
  it("accepts submodule flags, zero hashes and deleted-file modes", () => {
    const s = status(
      `1 .M SCMU 160000 160000 160000 ${hashes[0]} ${hashes[1]} module`,
      `1 D. N... 100755 000000 000000 ${hashes[0]} ${"0".repeat(40)} gone`,
      `1 .M N... 120000 120000 120000 ${hashes[0]} ${hashes[1]} symlink`,
    );
    expect(s).toMatchObject({ changed: 3, dirty: true });
    expect(s.unavailable).not.toBe(true);
  });
  it.each([
    { kind: "ordinary", record: tracked("file"), source: [] },
    { kind: "rename", record: renamed("file"), source: ["old"] },
    { kind: "unmerged", record: conflict("file"), source: [] },
  ])("accepts full SHA-256 hashes in $kind metadata", ({ record, source }) => {
    for (const hash of hashes) record = record.replace(hash, hash[0].repeat(64));
    const s = status(record, ...source);
    expect(s.changed).toBe(1);
    expect(s.unavailable).not.toBe(true);
  });
  it("consumes a copy's source as a literal NUL record", () => {
    const copy = renamed("copy").replace(" RM ", " C. ").replace("R100", "C75");
    expect(status(copy, "# branch.head misleading\n? source", "? other")).toMatchObject({ branch: "main", changed: 2, conflicts: 0 });
  });
});

describe("parseStatus strict validation", () => {
  it.each([
    ["empty output", ""],
    ["missing oid", nul("# branch.head main")],
    ["missing head", nul(`# branch.oid ${oid}`)],
    ["empty head", nul(`# branch.oid ${oid}`, "# branch.head ")],
    ["head with whitespace", nul(`# branch.oid ${oid}`, "# branch.head main branch")],
    ["newline in head", nul(`# branch.oid ${oid}`, "# branch.head main\n? fake")],
    ["truncated header", nul(...headers, "# branch.upstream")],
    ["empty upstream", nul(...headers, "# branch.upstream ", "# branch.ab +0 -0")],
    ["ab without upstream", nul(...headers, "# branch.ab +0 -0")],
    ["detached initial commit", nul("# branch.oid (initial)", "# branch.head (detached)")],
    ["detached upstream", nul(`# branch.oid ${oid}`, "# branch.head (detached)", "# branch.upstream origin/main", "# branch.ab +0 -0")],
    ["duplicate head", nul(...headers, "# branch.head other")],
    ["duplicate oid", nul(...headers, `# branch.oid ${oid}`)],
    ["unknown branch header", nul(...headers, "# branch.unknown value")],
    ["missing header terminal NUL", headers.join("\0")],
    ["missing record terminal NUL", nul(...headers, tracked("file")).slice(0, -1)],
    ["empty interior record", nul(...headers, "", "? file")],
    ["unknown record", nul(...headers, "x file")],
    ["truncated ordinary record", nul(...headers, "1 .M N... 100644")],
    ["truncated rename record", nul(...headers, "2 R. N... 100644")],
    ["truncated unmerged record", nul(...headers, "u UU N... 100644")],
    ["empty tracked path", nul(...headers, tracked(""))],
    ["empty rename destination", nul(...headers, renamed(""), "old")],
    ["empty conflict path", nul(...headers, conflict(""))],
    ["empty untracked path", nul(...headers, "? ")],
    ["empty ignored path", nul(...headers, "! ")],
    ["missing rename source", nul(...headers, renamed("new"))],
    ["empty rename source", nul(...headers, renamed("new"), "")],
    ["unterminated rename source", nul(...headers, renamed("new")) + "old"],
  ])("marks %s unavailable without throwing", (_name, output) => {
    const s = parseStatus(output);
    expect(s.unavailable).toBe(true);
    expect(text(segments(s))).toBe("!");
  });
  it.each(["", "aabbccddeeff", "a".repeat(39), "a".repeat(41), "a".repeat(63), "a".repeat(65), "g".repeat(40), "(initial) trailing"])("rejects invalid branch.oid %j", (commit) => {
    expect(parseStatus(nul(`# branch.oid ${commit}`, "# branch.head main")).unavailable).toBe(true);
  });
  it.each(["", "2 -3", "+2 3", "+x -3", "+2 --3", "+2  -3", "prefix +2 -3", "+2 -3 suffix", "+2 -3\n", "+9007199254740992 -0", "+0 -9007199254740992"])("rejects malformed branch.ab %j", (ab) => {
    expect(parseStatus(nul(...headers, "# branch.upstream origin/main", `# branch.ab ${ab}`)).unavailable).toBe(true);
  });
  it.each(["R", "R101", "R-1", "X100", "R100suffix"])("rejects invalid rename score %s", (score) => {
    expect(status(renamed("new").replace("R100", score), "old").unavailable).toBe(true);
  });
  describe.each([
    { kind: "ordinary", record: tracked("file"), modes: [3, 4, 5], hashes: [6, 7], source: [] },
    { kind: "rename", record: renamed("file"), modes: [3, 4, 5], hashes: [6, 7], source: ["old"] },
    { kind: "unmerged", record: conflict("file"), modes: [3, 4, 5, 6], hashes: [7, 8, 9], source: [] },
  ])("$kind metadata", ({ record, modes, hashes: hashFields, source }) => {
    const malformed = (field: number, value: string) => {
      const fields = record.split(" ");
      fields[field] = value;
      return parseStatus(nul(...headers, fields.join(" "), ...source));
    };
    it.each(["M", "MMM", "ZZ"])("rejects invalid XY %j", (xy) => {
      expect(malformed(1, xy).unavailable).toBe(true);
    });
    it.each(["N..", "N...x", "Sxyz", "SCMZ"])("rejects invalid submodule field %j", (submodule) => {
      expect(malformed(2, submodule).unavailable).toBe(true);
    });
    it.each(modes)("validates mode field %i", (field) => {
      for (const value of ["10064", "1006444", "100648", "abcdef"]) expect(malformed(field, value).unavailable).toBe(true);
    });
    it.each(hashFields)("validates hash field %i", (field) => {
      for (const value of ["a", "a".repeat(39), "a".repeat(41), "a".repeat(63), "a".repeat(65), "g".repeat(40)]) expect(malformed(field, value).unavailable).toBe(true);
    });
  });
  it("rejects a non-conflict XY on an unmerged record", () => {
    expect(status(conflict("file").replace(" UU ", " MM ")).unavailable).toBe(true);
  });
});

describe("segments", () => {
  it("renders the minimal suffix in order with colors", () => {
    const s = segments({ ...status(), branch: "feat/x", worktree: true, conflicts: 2, dirty: true, changed: 5, ahead: 1, behind: 3 });
    expect(text(s)).toBe("feat/x * ↑1 ↓3 !");
    expect(s?.filter((p) => p.color && p.color !== "text").map((p) => p.color)).toEqual(["warning", "success", "error", "error"]);
  });
  it("shows a clean tracked branch alone, and nothing outside a repository", () => {
    expect(text(segments(status()))).toBe("main");
    expect(segments(undefined)).toBeUndefined();
  });
  it("omits tracking labels on clean and dirty branches", () => {
    expect(text(segments(parseStatus(nul(...headers))))).toBe("main");
    expect(text(segments(parseStatus(nul(...headers, "? f"))))).toBe("main *");
  });
  it("excludes no upstream from clean and dirty detached summaries", () => {
    const detached = [`# branch.oid ${oid}`, "# branch.head (detached)"];
    expect(text(segments(parseStatus(nul(...detached))))).toBe("detached:aabbccd");
    expect(text(segments(parseStatus(nul(...detached, "? f"))))).toBe("detached:aabbccd *");
  });
  it.each([1, 2, 5])("uses one marker for %i conflicts without file counts", (count) => {
    const records = Array.from({ length: count }, (_, i) => conflict(`file-${i}`));
    expect(text(segments(status(...records)))).toBe("main * !");
  });
  it("omits zero terms independently", () => {
    expect(text(segments(parseStatus(nul(...headers, "# branch.upstream origin/main", "# branch.ab +2 -0"))))).toBe("main ↑2");
    expect(text(segments(parseStatus(nul(...headers, "# branch.upstream origin/main", "# branch.ab +0 -3"))))).toBe("main ↓3");
    expect(text(segments(status(conflict("f"))))).toBe("main * !");
  });
  it("renders failure explicitly, not as fake clean", () => {
    expect(text(segments({ ...status(), unavailable: true }))).toBe("main !");
    expect(text(segments(parseStatus("")))).toBe("!");
    expect(text(segments(parseStatus(nul(...headers, "# branch.upstream origin/main", "# branch.ab +2 -3", "truncated"))))).toBe("!");
  });
  it("marks administrative operations even with no uncommitted files", () => {
    expect(text(segments({ ...status(), operation: true }))).toBe("main !");
    expect(text(segments({ ...status(), dirty: true, operation: true, conflicts: 3, ahead: 2, behind: 4, unavailable: true }))).toBe("main * ↑2 ↓4 !");
    expect(sameStatus(status(), { ...status(), operation: true })).toBe(false);
  });
  it("detects changes to counts, upstream and availability", () => {
    expect(sameStatus(status(), status())).toBe(true);
    expect(sameStatus(status("? a"), status("? a", "? b"))).toBe(false);
    expect(sameStatus(status(), { ...status(), upstream: false })).toBe(false);
    expect(sameStatus(status(), { ...status(), unavailable: true })).toBe(false);
    expect(sameStatus(status(), { ...status(), upstreamMissing: true })).toBe(false);
  });
});

async function fixture(run: (repo: string, git: (...args: string[]) => string) => Promise<void>, { initial = true }: { initial?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "ogs-"));
  try {
    expect(await readStatus(dir)).toBeUndefined();
    const repo = path.join(dir, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    const git = (...args: string[]) => execFileSync("git", ["--no-optional-locks", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (initial) git("commit", "-q", "--allow-empty", "-m", "initial");
    await run(repo, git);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("readStatus real fixtures", () => {
  it("reads clean branches with and without upstream, and local ahead/behind", async () => {
    await fixture(async (repo, git) => {
      expect(text(segments(await readStatus(repo)))).toBe("main");
      git("remote", "add", "origin", ".");
      git("update-ref", "refs/remotes/origin/main", "HEAD");
      git("branch", "--set-upstream-to=origin/main", "main");
      expect(text(segments(await readStatus(repo)))).toBe("main");
      git("commit", "-q", "--allow-empty", "-m", "ahead");
      expect(text(segments(await readStatus(repo)))).toBe("main ↑1");
      git("update-ref", "refs/remotes/origin/main", "HEAD");
      git("reset", "--hard", "HEAD~1");
      expect(text(segments(await readStatus(repo)))).toBe("main ↓1");
    });
  });
  it("counts staged+unstaged, renamed and individual untracked files, excluding ignored files", async () => {
    await fixture(async (repo, git) => {
      writeFileSync(path.join(repo, "both"), "initial\n");
      writeFileSync(path.join(repo, "old\n? source"), "rename\n");
      writeFileSync(path.join(repo, ".gitignore"), "ignored/\n");
      git("add", ".");
      git("commit", "-q", "-m", "files");
      writeFileSync(path.join(repo, "both"), "staged\n");
      git("add", "both");
      writeFileSync(path.join(repo, "both"), "unstaged\n");
      git("mv", "old\n? source", "new\nu fake");
      mkdirSync(path.join(repo, "untracked"));
      writeFileSync(path.join(repo, "untracked", "a\n# branch.head fake"), "a");
      writeFileSync(path.join(repo, "untracked", "b"), "b");
      mkdirSync(path.join(repo, "ignored"));
      writeFileSync(path.join(repo, "ignored", "hidden"), "ignored");
      const s = await readStatus(repo);
      expect(s).toMatchObject({ branch: "main", changed: 4, conflicts: 0, dirty: true });
      expect(text(segments(s))).toBe("main *");
    });
  });
  it("counts real merge conflicts as unique changed paths", async () => {
    await fixture(async (repo, git) => {
      const name = "conflict\n? fake";
      writeFileSync(path.join(repo, name), "base\n");
      git("add", ".");
      git("commit", "-q", "-m", "base");
      git("checkout", "-q", "-b", "other");
      writeFileSync(path.join(repo, name), "other\n");
      git("commit", "-qam", "other");
      git("checkout", "-q", "main");
      writeFileSync(path.join(repo, name), "main\n");
      git("commit", "-qam", "main");
      expect(() => git("merge", "other")).toThrow();
      const s = await readStatus(repo);
      expect(s).toMatchObject({ changed: 1, conflicts: 1, dirty: true });
      expect(text(segments(s))).toBe("main * !");
    });
  });
  it("reads a detached checkout without labeling a missing upstream", async () => {
    await fixture(async (repo, git) => {
      const commit = git("rev-parse", "HEAD").trim();
      git("checkout", "-q", "--detach", "HEAD");
      const clean = await readStatus(repo);
      expect(clean).toMatchObject({ branch: `detached:${commit.slice(0, 7)}`, upstream: false, worktree: false, dirty: false, changed: 0 });
      expect(text(segments(clean))).toBe(`detached:${commit.slice(0, 7)}`);
      writeFileSync(path.join(repo, "new\n# branch.head fake"), "new");
      expect(text(segments(await readStatus(repo)))).toBe(`detached:${commit.slice(0, 7)} *`);
    });
  });
  it("reads clean and dirty unborn branches", async () => {
    await fixture(async (repo, git) => {
      expect(git("status", "--porcelain=v2", "--branch", "-z")).toContain("# branch.oid (initial)\0");
      const clean = await readStatus(repo);
      expect(clean).toEqual({ branch: "main", worktree: false, conflicts: 0, dirty: false, changed: 0, upstream: false, upstreamMissing: false, ahead: 0, behind: 0 });
      expect(text(segments(clean))).toBe("main");
      writeFileSync(path.join(repo, "new\n? fake"), "new");
      const dirty = await readStatus(repo);
      expect(dirty).toMatchObject({ branch: "main", changed: 1, dirty: true });
      expect(text(segments(dirty))).toBe("main *");
    }, { initial: false });
  });
  it("reads a linked worktree without labeling the main checkout as a worktree", async () => {
    await fixture(async (repo, git) => {
      const worktree = path.join(repo, "..", "linked");
      git("worktree", "add", "-q", "-b", "feature", worktree);
      const clean = await readStatus(worktree);
      expect(clean).toMatchObject({ branch: "feature", worktree: true, changed: 0, dirty: false });
      expect(text(segments(clean))).toBe("feature");
      writeFileSync(path.join(worktree, "new\n? fake"), "new");
      expect(text(segments(await readStatus(worktree)))).toBe("feature *");
      expect(await readStatus(repo)).toMatchObject({ branch: "main", worktree: false, changed: 0, dirty: false });
    });
  });
  it("does not infer a linked worktree from a misleading /worktrees/name gitdir", async () => {
    await fixture(async (repo, git) => {
      const gitDir = path.join(repo, "..", "worktrees", "name");
      mkdirSync(path.dirname(gitDir), { recursive: true });
      git("init", "-q", "--separate-git-dir", gitDir);
      const dirs = git("rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir").trimEnd().split("\n");
      expect(dirs).toHaveLength(2);
      expect(dirs[0]).toBe(dirs[1]);
      expect(dirs[0]).toMatch(/\/worktrees\/name$/);
      const s = await readStatus(repo);
      expect(s).toMatchObject({ branch: "main", worktree: false, changed: 0, dirty: false });
      expect(text(segments(s))).toBe("main");
    });
  });
  it("still calculates ahead/behind when status.aheadBehind is false", async () => {
    await fixture(async (repo, git) => {
      git("remote", "add", "origin", ".");
      git("update-ref", "refs/remotes/origin/main", "HEAD");
      git("branch", "--set-upstream-to=origin/main", "main");
      git("config", "status.aheadBehind", "false");
      git("commit", "-q", "--allow-empty", "-m", "ahead");
      const ahead = await readStatus(repo);
      expect(ahead).toMatchObject({ upstream: true, ahead: 1, behind: 0 });
      expect(text(segments(ahead))).toBe("main ↑1");
      git("update-ref", "refs/remotes/origin/main", "HEAD");
      git("reset", "--hard", "HEAD~1");
      const behind = await readStatus(repo);
      expect(behind).toMatchObject({ upstream: true, ahead: 0, behind: 1 });
      expect(text(segments(behind))).toBe("main ↓1");
    });
  });
});
