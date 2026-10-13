// opencode-herdr (server): the `herdr_child` tool, which starts interactive opencode children in a
// herdr tab, a split beside this pane, or a new worktree's space, sends each a task, and delivers
// each reply to the parent session as a prompt; and the pane token `bg` naming the children whose
// reply is still pending. The port of pi-herdr; src/core is shared with it verbatim.
//
// Only a server running in a herdr pane does anything (it needs HERDR_PANE_ID: opencode's TUI runs
// its server in-process). A shared server (`opencode serve`, or the server behind `opencode
// attach`) cannot tell which pane asked, so it registers nothing.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { type Hooks, type Plugin, tool } from "@opencode-ai/plugin";
import { Activity } from "./core/activity.ts";
import { type ChildRecord, Children, type Where } from "./core/children.ts";
import { exec } from "./exec.ts";
import { herdrTarget, socketCall } from "./core/herdr.ts";
import { PaneReporter } from "./core/report.ts";
import { type MessageLike, opencodeChild } from "./session.ts";

const BG_TTL_MS = 90_000;
const SOURCE = "opencode-herdr:server";

/** Where a parent session's children are saved, so they survive a restart. */
export function childrenFile(sessionID: string, root = path.join(process.env.XDG_DATA_HOME || path.join(homedir(), ".local/share"), "opencode-herdr")): string {
  return path.join(root, "children", `${sessionID.replace(/[^A-Za-z0-9_-]/gu, "_")}.json`);
}

function loadRecords(file: string): ChildRecord[] {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export const HerdrPlugin: Plugin = async ({ client, directory }) => {
  const target = herdrTarget();
  if (!target) return {};
  const call = socketCall(target.socketPath);
  const pane = new PaneReporter(call, target.paneId, "opencode", SOURCE);
  const activity = new Activity();
  const updateBg = () => void pane.setToken("bg", activity.token(), BG_TTL_MS);
  const refresh = setInterval(() => void pane.refresh(), 15_000);
  refresh.unref?.();

  const reader = {
    messages: async (sessionID: string, dir: string) => {
      try {
        const r = await (client.session.messages as any)({ path: { id: sessionID }, query: { directory: dir } });
        return Array.isArray(r?.data) ? (r.data as MessageLike[]) : undefined;
      } catch {
        return undefined;
      }
    },
  };
  const agent = opencodeChild(reader, exec);

  /** One Children per parent session (a server serves every session its TUI switches to). */
  const bySession = new Map<string, Children>();
  const forSession = (sessionID: string, dir: string): Children => {
    let c = bySession.get(sessionID);
    if (c) return c;
    const file = childrenFile(sessionID);
    const saved = new Map<string, ChildRecord>();
    c = new Children({
      call,
      agent,
      selfPane: target.paneId,
      exec,
      persist: (rec) => {
        saved.set(rec.name, rec);
        try {
          mkdirSync(path.dirname(file), { recursive: true });
          writeFileSync(file, JSON.stringify([...saved.values()], null, 2));
        } catch {
          // A lost save only costs `list` after a restart.
        }
      },
      deliver: (_rec, text) =>
        void (client.session.promptAsync as any)({ path: { id: sessionID }, query: { directory: dir }, body: { parts: [{ type: "text", text }] } }).catch(() => {}),
      hold: (rec, on) => {
        activity.apply("herdr:background", on ? { active: true, label: `child ${rec.name}`, id: `${sessionID}:${rec.name}` } : { active: false, id: `${sessionID}:${rec.name}` });
        updateBg();
      },
    });
    const records = loadRecords(file);
    for (const r of records) saved.set(r.name, r);
    c.restore(records);
    bySession.set(sessionID, c);
    return c;
  };

  /** The model the parent session last used, as provider/model. */
  const parentModel = async (sessionID: string, dir: string): Promise<string | undefined> => {
    const messages = ((await reader.messages(sessionID, dir)) ?? []) as Array<{ info?: { role?: string; providerID?: string; modelID?: string; model?: { providerID?: string; modelID?: string } } }>;
    for (let i = messages.length - 1; i >= 0; i--) {
      const info = messages[i]?.info;
      const providerID = info?.providerID ?? info?.model?.providerID;
      const modelID = info?.modelID ?? info?.model?.modelID;
      if (providerID && modelID) return `${providerID}/${modelID}`;
    }
    return undefined;
  };

  const s = tool.schema;
  const hooks: Hooks = {
    dispose: async () => {
      clearInterval(refresh);
      for (const c of bySession.values()) c.shutdown();
      await pane.clearTokens();
    },
    tool: {
      herdr_child: tool({
        description:
          "Start and talk to persistent, human-led opencode sessions in herdr, only for an explicit interactive-session request or a clear handoff to the user. Default to a subagent (the task tool) for delegated work that reports back to this session, even when long, multi-step, or parallel. Duration, complexity, and the possibility the user might want to watch are not reasons to create a Herdr pane. For an interactive handoff sharing this checkout and branch, use where=tab in the existing space; use where=split only for deliberate side-by-side interaction or when requested. Tabs and splits share files, not isolated parallel editors. Use where=worktree only for a user-requested independent branch/checkout; otherwise ask before creating one. It gets the checkout's own space (or a tab there if already open). Never create a new space or worktree merely because work is delegated, long, or parallel. Preserve focus unless asked to switch. action=spawn takes `task` (plus optional name, where, branch, model, focus); replies arrive as new messages in this session, so end your turn instead of polling. action=send (name, message), read (name), list, interrupt (name), close (name). Give it a complete, self-contained task: it cannot see this conversation.",
        args: {
          action: s.enum(["spawn", "send", "read", "list", "interrupt", "close"]).describe("spawn a child; send it a message; read its last reply or screen; list children; interrupt its turn (Escape); close its pane"),
          task: s.string().optional().describe("spawn: the complete, self-contained task"),
          name: s.string().optional().describe("spawn: a short name (lowercase, dashes); otherwise from the task. send/read/interrupt/close: which child"),
          where: s.enum(["tab", "split", "worktree"]).optional().describe("spawn: tab in this space for a persistent session sharing this checkout (default); split for side-by-side interaction; worktree for a user-requested independent branch/checkout in its own space (needs branch)"),
          branch: s.string().optional().describe("spawn with where=worktree: the user-requested independent branch (checked out, tracked or created from HEAD); do not create a worktree without the user's request"),
          model: s.string().optional().describe("spawn: provider/model; default this session's"),
          focus: s.boolean().optional().describe("spawn: switch to the child's pane (default false)"),
          message: s.string().optional().describe("send: the message"),
          lines: s.number().optional().describe("read: screen lines while it works (default 80)"),
        },
        async execute(args, ctx) {
          const dir = ctx.directory || directory;
          const children = forSession(ctx.sessionID, dir);
          const need = (v: string | undefined, what: string) => {
            if (!v?.trim()) throw new Error(`action=${args.action} needs \`${what}\`.`);
            return v.trim();
          };
          switch (args.action) {
            case "spawn": {
              const where: Where = args.where ?? "tab";
              const rec = await children.spawn({
                task: need(args.task, "task"),
                name: args.name,
                where,
                branch: args.branch,
                model: args.model ?? (await parentModel(ctx.sessionID, dir)),
                focus: args.focus,
                cwd: dir,
              });
              const place = where === "worktree" ? `worktree ${rec.branch} (${rec.cwd})` : where === "split" ? "a split beside this pane" : "a new tab";
              return `Started herdr child "${rec.name}" in ${place}, pane ${rec.paneId}, and sent it the task. Its reply arrives as a message in this session when its turn ends; end your turn instead of polling.`;
            }
            case "send": {
              const rec = await children.send(need(args.name, "name"), need(args.message, "message"));
              return `Sent to ${rec.name}. Its reply arrives as a message.`;
            }
            case "read":
              return children.read(need(args.name, "name"), args.lines);
            case "list":
              return children.list();
            case "interrupt":
              return children.interrupt(need(args.name, "name"));
            case "close":
              return children.close(need(args.name, "name"));
          }
        },
      }),
    },
  };
  return hooks;
};

export default { id: "opencode-herdr", server: HerdrPlugin };
