import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readStatus, segments } from "../src/git.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
vi.mock("node:fs/promises", () => ({ stat: vi.fn() }));
const exec = vi.mocked(execFile);
const inspect = vi.mocked(stat);
const text = (s: Awaited<ReturnType<typeof readStatus>>) => segments(s)?.map((p) => p.text).join("");
const probe = "/repo/.git\n";
const clean = `# branch.oid ${"a".repeat(40)}\0# branch.head main\0`;

function reply(error: object | null, stdout = "", stderr = "") {
  exec.mockImplementationOnce(((...args: unknown[]) => {
    const callback = args.at(-1) as (error: object | null, stdout: Buffer, stderr: Buffer) => void;
    callback(error, Buffer.from(stdout), Buffer.from(stderr));
  }) as typeof execFile);
}
function probes(dir = probe, common = probe) {
  reply(null, dir);
  reply(null, common);
}

beforeEach(() => {
  exec.mockReset();
  inspect.mockReset();
  inspect.mockRejectedValue(Object.assign(new Error("absent"), { code: "ENOENT" }));
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("readStatus command handling", () => {
  it.each([
    "fatal: not a git repository (or any of the parent directories): .git\n",
    "fatal: not a git repository (or any parent up to mount point /)\nStopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).\n",
  ])("stays blank for ordinary discovery failure: %s", async (stderr) => {
    reply({ code: 128 }, "", stderr);
    expect(await readStatus("/outside")).toBeUndefined();
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it.each([
    { code: "ENOENT" }, { code: "EACCES" },
    { killed: true, signal: "SIGTERM" },
    { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, { code: 128 },
  ])("reports probe failure %j rather than hiding it", async (error) => {
    reply(error);
    expect(text(await readStatus("/repo"))).toBe("!");
  });

  it("reports broken metadata rather than treating it as ordinary discovery", async () => {
    reply({ code: 128 }, "", "fatal: not a git repository: /repo/.git/worktrees/broken\n");
    expect(text(await readStatus("/repo"))).toBe("!");
  });

  it("reports common-directory failure even with an outside diagnostic", async () => {
    reply(null, probe);
    reply({ code: 128 }, "", "fatal: not a git repository (or any of the parent directories): .git\n");
    expect(text(await readStatus("/repo"))).toBe("!");
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("reports status failure even if partial output looks clean", async () => {
    probes();
    reply({ code: 128 }, clean);
    expect(text(await readStatus("/repo"))).toBe("!");
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it("does not hide a status failure as outside after successful probes", async () => {
    probes();
    reply({ code: 128 }, "", "fatal: not a git repository (or any of the parent directories): .git\n");
    expect(text(await readStatus("/repo"))).toBe("!");
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["empty output", ""],
    ["head without oid", "# branch.head main\0"],
    ["missing terminal NUL", clean.slice(0, -1)],
    ["truncated tracked record", clean + "1 .M N... 100644\0"],
  ])("reports malformed successful status: %s", async (_name, output) => {
    probes();
    reply(null, output);
    const s = await readStatus("/repo");
    expect(s?.unavailable).toBe(true);
    expect(text(s)).toBe("!");
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it.each(["", ".git\n", "\n", "/repo/.git", "/repo/.git\0\n"])("rejects malformed git directory: %j", async (output) => {
    reply(null, output);
    expect(text(await readStatus("/repo"))).toBe("!");
    expect(exec).toHaveBeenCalledTimes(1);
  });
  it.each(["", ".git\n", "\n", "/repo/.git", "/repo/.git\0\n"])("rejects malformed common directory: %j", async (output) => {
    probes(probe, output);
    expect(text(await readStatus("/repo"))).toBe("!");
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["ordinary repository", probe, probe, false],
    ["misleading /worktrees/name suffix", "/metadata/worktrees/name\n", "/metadata/worktrees/name\n", false],
    ["equivalent normalized directories", "/repo/./.git\n", probe, false],
    ["linked directory without a worktrees suffix", "/metadata/linked\n", "/metadata/common\n", true],
    ["embedded newlines", "/repo\nname/.git\n", "/repo\nname/.git\n", false],
    ["trailing path newline", "/metadata/linked\n\n", "/metadata/linked\n", true],
  ] as const)("compares git/common directories for %s", async (_name, dir, common, worktree) => {
    probes(dir, common);
    reply(null, clean);
    const s = await readStatus("/repo");
    expect(s).toMatchObject({ branch: "main", worktree, changed: 0, dirty: false });
    expect(text(s)).toBe("main");
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it("checks operation markers in the raw per-worktree directory, not the common directory", async () => {
    probes("/repo\n/.git/worktrees/feature\n\n", probe);
    reply(null, clean);
    inspect.mockResolvedValueOnce({} as Awaited<ReturnType<typeof stat>>);
    expect(text(await readStatus("/repo"))).toBe("main !");
    expect(inspect.mock.calls.map(([file]) => (file as Buffer).toString())).toEqual(
      ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "sequencer"].map((name) => `/repo\n/.git/worktrees/feature\n/${name}`),
    );
  });

  it("reports unreadable operation metadata without losing branch identity", async () => {
    probes();
    reply(null, clean);
    inspect.mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
    const s = await readStatus("/repo");
    expect(s).toMatchObject({ branch: "main", unavailable: true });
    expect(text(s)).toBe("main !");
  });

  it("preserves linked worktree detection and uses lock-free local-only buffer commands", async () => {
    vi.stubEnv("LC_ALL", "fr_FR.UTF-8");
    vi.stubEnv("OGS_TEST_ENV", "preserved");
    probes("/repo/.git/worktrees/feature\n", probe);
    reply(null, clean.replace("# branch.head main", "# branch.head feature"));
    expect(text(await readStatus("/repo"))).toBe("feature");
    expect(exec.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ["git", ["--no-optional-locks", "-C", "/repo", "rev-parse", "--path-format=absolute", "--git-dir"]],
      ["git", ["--no-optional-locks", "-C", "/repo", "rev-parse", "--path-format=absolute", "--git-common-dir"]],
      ["git", ["--no-optional-locks", "-C", "/repo", "status", "--porcelain=v2", "--branch", "--ahead-behind", "--untracked-files=all", "-z"]],
    ]);
    for (const call of exec.mock.calls) {
      expect(call[2]).toEqual({ encoding: "buffer", timeout: 10_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } });
    }
  });
});
