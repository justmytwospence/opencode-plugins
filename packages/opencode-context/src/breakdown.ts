// Counting and assembly for /context: which part of the context window each token of a model
// request belongs to, and the preview text of each part. Nothing here touches OpenCode or the
// terminal: the server half feeds it the `context` hook's event, the CLI half reconciles the
// result with the usage OpenCode reports and draws it.
//
// The split follows the three things a request carries: the system parts, the tool declarations
// and the messages. OpenCode 2 joins its ambient "instruction blocks" (the Code Mode tool
// catalog, the skills list, the instruction files such as AGENTS.md, the date and the
// environment) into one system part, and sends later changes to them as system-role messages, so
// both are cut into blocks by the lines those blocks start with (BLOCK_STARTS).
//
// Ported from pi-context, itself from pi-cc-extensions (MIT, minuque).

export type PartKey = "system" | "instructions" | "skills" | "tools" | "toolResults" | "conversation";

export interface Item {
  label: string;
  tokens: number;
}

export interface Part {
  key: PartKey;
  label: string;
  tokens: number;
  /** What the part is made of: files, tools, messages; in request order. */
  items: Item[];
  /** The part's text as the model receives it, Markdown, cut at PREVIEW_CHARS. */
  preview: string;
  truncated: boolean;
}

/** What the server half keeps of a session's last primary model request. */
export interface Snapshot {
  parts: Part[];
  /** When the request was made (ms since the epoch). */
  at: number;
  model: { providerID: string; id: string };
  agent: string;
  /** Messages in the request. */
  messages: number;
}

export const PART_ORDER: readonly PartKey[] = ["system", "instructions", "skills", "tools", "toolResults", "conversation"];

export const PART_LABELS: Readonly<Record<PartKey, string>> = {
  system: "System prompt",
  instructions: "Instructions",
  skills: "Skills",
  tools: "Tool definitions",
  toolResults: "Tool results",
  conversation: "Conversation",
};

/** The parts whose count is independent of the conversation: the first four of PART_ORDER. */
export const FIXED_PARTS = 4;

/** Characters kept of each part's preview, and of each item inside it. */
export const PREVIEW_CHARS = 120_000;
export const ITEM_PREVIEW_CHARS = 24_000;

/** The parts of a request the breakdown reads; narrowed so tests hand in plain data. */
export interface RequestLike {
  readonly system: readonly { readonly text: string }[];
  readonly tools: Readonly<Record<string, { readonly description: string; readonly input: unknown }>>;
  readonly messages: readonly MessageLike[];
}

export interface MessageLike {
  readonly role: string;
  readonly content: readonly PartLike[];
}

export interface PartLike {
  readonly type: string;
  readonly text?: string;
  readonly name?: string;
  readonly input?: unknown;
  readonly result?: { readonly type: string; readonly value: unknown };
  readonly media?: { readonly mime?: string; readonly source?: { readonly type?: string; readonly data?: unknown; readonly uri?: string } };
}

/** Characters / 4, the heuristic OpenCode's own estimates use. */
export function tokenEstimate(value: unknown): number {
  if (!value) return 0;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.max(0, Math.ceil(text.length / 4));
}

export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 100_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${Math.round(tokens / 1_000)}k`;
}

export function normalizePreviewText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[... ${text.length - max} more characters]`;
}

function previewValue(value: unknown): string {
  if (typeof value === "string") return value;
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

// --- Blocks -------------------------------------------------------------------------------------

export interface Block {
  key: PartKey;
  label: string;
  text: string;
}

/** The lines OpenCode 2 starts its instruction blocks and their updates with. */
const BLOCK_STARTS: ReadonlyArray<{ test: RegExp; key: PartKey; label: string | ((match: RegExpExecArray) => string) }> = [
  { test: /^# Code Mode$/, key: "tools", label: "Code Mode catalog" },
  { test: /^The Code Mode tool catalog has changed\./, key: "tools", label: "Code Mode catalog update" },
  { test: /^Code Mode tools are no longer available\./, key: "tools", label: "Code Mode catalog update" },
  { test: /^Skills provide specialized instructions and workflows/, key: "skills", label: "Available skills" },
  { test: /^The available skills have changed\./, key: "skills", label: "Skills update" },
  { test: /^New skills are available in addition/, key: "skills", label: "Skills update" },
  { test: /^The following skill IDs are no longer available/, key: "skills", label: "Skills update" },
  { test: /^<skill_content\b/, key: "skills", label: "Invoked skill" },
  { test: /^Instructions from: (.+)$/, key: "instructions", label: (m) => m[1] as string },
  { test: /^New instructions apply from:$/, key: "instructions", label: "Instructions update" },
  { test: /^The instructions from (.+?) (?:changed\.|no longer apply\.)/, key: "instructions", label: (m) => `${m[1] as string} (update)` },
  { test: /^Previously loaded instructions no longer apply\./, key: "instructions", label: "Instructions removed" },
  { test: /^Today's date: /, key: "system", label: "Date" },
  { test: /^Here is some useful information about the environment/, key: "system", label: "Environment" },
];

function blockStart(line: string): { key: PartKey; label: string } | undefined {
  for (const start of BLOCK_STARTS) {
    const match = start.test.exec(line);
    if (match) return { key: start.key, label: typeof start.label === "function" ? start.label(match) : start.label };
  }
  return undefined;
}

/** A label for text that no block start names: its first line, without heading marks, clipped. */
export function labelFor(text: string, fallback: string): string {
  const line = text
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find(Boolean);
  if (!line) return fallback;
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/** Whether the text begins with one of the lines an instruction block starts with. */
export function startsWithBlock(text: string): boolean {
  const first = text.split("\n").find((l) => l.trim());
  return first !== undefined && blockStart(first) !== undefined;
}

/**
 * Cut a system text into its blocks: the text before the first block start is one block of
 * `defaultKey`, labelled by its first line, and every block start opens a new block.
 */
export function splitBlocks(text: string, defaultKey: PartKey, defaultLabel: string): Block[] {
  const blocks: Block[] = [];
  let current: { key: PartKey; label: string | undefined; lines: string[] } = { key: defaultKey, label: undefined, lines: [] };
  const close = () => {
    const body = current.lines.join("\n").replace(/^\n+|\s+$/g, "");
    if (body) blocks.push({ key: current.key, label: current.label ?? labelFor(body, defaultLabel), text: body });
  };
  for (const line of text.split("\n")) {
    const start = blockStart(line);
    if (start) {
      close();
      current = { key: start.key, label: start.label, lines: [line] };
    } else current.lines.push(line);
  }
  close();
  return blocks;
}

// --- Collection ---------------------------------------------------------------------------------

type Bucket = { items: Item[]; previews: string[]; tokens: number; clipped: boolean };

function toolResultText(result: { type: string; value: unknown } | undefined): { text: string; preview: string } {
  if (!result) return { text: "", preview: "" };
  const value = result.value;
  if (result.type === "content" && Array.isArray(value)) {
    const parts = value.map((p: { type?: string; text?: string; mime?: string; name?: string; uri?: string }) =>
      p?.type === "text" ? (p.text ?? "") : `[${p?.type ?? "file"}: ${p?.name ?? p?.uri ?? p?.mime ?? ""}]`,
    );
    const text = parts.join("\n");
    return { text, preview: text };
  }
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return { text, preview: result.type === "error" ? `Error:\n\n${previewValue(value)}` : previewValue(value) };
}

function mediaLabel(part: PartLike): string {
  const media = part.media;
  const source = media?.source;
  const data = source?.data;
  const bytes = data instanceof Uint8Array ? data.byteLength : typeof data === "string" ? data.length : undefined;
  const where = source?.uri ?? (bytes !== undefined ? `${bytes} bytes` : "");
  return `${media?.mime ?? "media"}${where ? ` ${where}` : ""}`;
}

/** Count and preview each part of one model request. */
export function collectBreakdown(request: RequestLike): Part[] {
  const buckets: Record<PartKey, Bucket> = {
    system: { items: [], previews: [], tokens: 0, clipped: false },
    instructions: { items: [], previews: [], tokens: 0, clipped: false },
    skills: { items: [], previews: [], tokens: 0, clipped: false },
    tools: { items: [], previews: [], tokens: 0, clipped: false },
    toolResults: { items: [], previews: [], tokens: 0, clipped: false },
    conversation: { items: [], previews: [], tokens: 0, clipped: false },
  };
  const add = (key: PartKey, label: string, tokens: number, preview: string) => {
    const bucket = buckets[key];
    bucket.items.push({ label, tokens });
    bucket.tokens += tokens;
    bucket.previews.push(clip(preview, ITEM_PREVIEW_CHARS));
    if (preview.length > ITEM_PREVIEW_CHARS) bucket.clipped = true;
  };
  const addBlocks = (text: string, defaultKey: PartKey, defaultLabel: string) => {
    for (const block of splitBlocks(text, defaultKey, defaultLabel)) {
      add(block.key, block.label, tokenEstimate(block.text), block.text.startsWith("#") ? block.text : `## ${block.label}\n\n${block.text}`);
    }
  };

  for (const part of request.system) addBlocks(part.text ?? "", "system", "System prompt");

  for (const [name, tool] of Object.entries(request.tools)) {
    const definition = { name, description: tool.description, input: tool.input };
    add("tools", name, tokenEstimate(definition), `## ${name}\n\n${previewValue(definition)}`);
  }

  for (const message of request.messages) {
    for (const part of message.content) {
      if (message.role === "tool" || part.type === "tool-result") {
        const { text, preview } = toolResultText(part.result);
        add("toolResults", part.name ?? "tool", tokenEstimate(part.name) + tokenEstimate(text), `## Result: ${part.name ?? "tool"}\n\n${preview}`);
        continue;
      }
      if (part.type === "text") {
        const text = part.text ?? "";
        if (message.role === "system" || (message.role === "user" && startsWithBlock(text))) {
          addBlocks(text, "system", "System notice");
          continue;
        }
        const who = message.role === "assistant" ? "Assistant" : "User";
        add("conversation", `${who}: ${labelFor(text, who)}`, tokenEstimate(text), `## ${who}\n\n${text}`);
      } else if (part.type === "reasoning") {
        add("conversation", "Assistant reasoning", tokenEstimate(part.text), `## Assistant reasoning\n\n${part.text ?? ""}`);
      } else if (part.type === "tool-call") {
        add("conversation", `Tool call: ${part.name ?? ""}`, tokenEstimate(part.name) + tokenEstimate(part.input), `## Tool call: ${part.name ?? ""}\n\n${previewValue(part.input)}`);
      } else if (part.type === "media") {
        // Media tokens depend on the provider; they are listed but not counted.
        add("conversation", `Media: ${mediaLabel(part)} (not counted)`, 0, `## Media\n\n${mediaLabel(part)} (tokens not counted)`);
      } else {
        const { type: _type, ...rest } = part;
        add("conversation", part.type, tokenEstimate(rest), `## ${part.type}\n\n${previewValue(rest)}`);
      }
    }
  }

  const empty: Record<PartKey, string> = {
    system: "No system prompt.",
    instructions: "No instruction files in context.",
    skills: "No skills in context.",
    tools: "No tool definitions.",
    toolResults: "No tool results in the current context.",
    conversation: "No conversation yet.",
  };
  return PART_ORDER.map((key) => {
    const bucket = buckets[key];
    const full = bucket.previews.join("\n\n");
    const preview = full.length > PREVIEW_CHARS ? `${full.slice(0, PREVIEW_CHARS)}\n\n[... ${full.length - PREVIEW_CHARS} more characters]` : full;
    return { key, label: PART_LABELS[key], tokens: bucket.tokens, items: bucket.items, preview: preview || empty[key], truncated: bucket.clipped || full.length > PREVIEW_CHARS };
  });
}

// --- Assembly -----------------------------------------------------------------------------------

export interface ReportRow {
  key: PartKey | "other" | "free";
  label: string;
  tokens: number;
}

export interface Report {
  /** The parts, capped to the used total, then Other and Free space. */
  rows: ReportRow[];
  used: number;
  contextWindow: number;
}

/**
 * Scale the variable parts (after `fixedPrefix`) down proportionally so the total does not exceed
 * `target`. The fixed prefix is never changed; rounding error lands on the last variable part.
 */
export function capParts<T extends { tokens: number }>(parts: T[], target: number, fixedPrefix = 0): T[] {
  const fixed = parts.slice(0, fixedPrefix);
  const variable = parts.slice(fixedPrefix);
  const fixedTokens = fixed.reduce((sum, part) => sum + part.tokens, 0);
  const variableTarget = Math.max(0, target - fixedTokens);
  const estimated = variable.reduce((sum, part) => sum + part.tokens, 0);
  if (estimated <= variableTarget || estimated === 0) return parts;
  if (variableTarget === 0) return [...fixed, ...variable.map((part) => ({ ...part, tokens: 0 }))];

  let previous = 0;
  let cumulative = 0;
  const capped = variable.map((part, index) => {
    cumulative += part.tokens;
    const next = index === variable.length - 1 ? variableTarget : Math.round((cumulative / estimated) * variableTarget);
    const tokens = next - previous;
    previous = next;
    return { ...part, tokens };
  });
  return [...fixed, ...capped];
}

/**
 * The number of used tokens to show: what OpenCode reports for the last response (its input,
 * output, reasoning and cache tokens), unless that is far below what the content alone must
 * cost, or nothing has been reported yet; then the estimate.
 */
export function resolveUsedTokens(reported: number | undefined, estimated: number): number {
  if (reported === undefined || reported <= 0) return estimated;
  if (estimated > 0 && reported < estimated * 0.25) return estimated;
  return reported;
}

/** Reconcile the estimated parts with the usage OpenCode reports and add the Other and Free space rows. */
export function assembleReport(parts: readonly Part[], reported: number | undefined, contextWindow: number): Report {
  const estimated = parts.reduce((sum, part) => sum + part.tokens, 0);
  const fixedTokens = parts.slice(0, FIXED_PARTS).reduce((sum, part) => sum + part.tokens, 0);
  const used = Math.max(resolveUsedTokens(reported, estimated), fixedTokens);
  const capped = capParts(
    parts.map((p) => ({ key: p.key, label: p.label, tokens: p.tokens })),
    used,
    FIXED_PARTS,
  );
  const attributed = capped.reduce((sum, part) => sum + part.tokens, 0);
  const other = Math.max(0, used - attributed);
  const free = Math.max(0, contextWindow - used);
  return {
    rows: [...capped, { key: "other", label: "Other", tokens: other }, { key: "free", label: "Free space", tokens: free }],
    used,
    contextWindow,
  };
}

/** Plain-text report, one line per row. */
export function formatReport(report: Report): string {
  const percent = report.contextWindow > 0 ? (report.used / report.contextWindow) * 100 : 0;
  const header =
    report.contextWindow > 0
      ? `Context: ${formatTokens(report.used)} / ${formatTokens(report.contextWindow)} tokens (${percent.toFixed(1)}%)`
      : `Context: ${formatTokens(report.used)} tokens`;
  return [header, ...report.rows.map((row) => `${row.label}: ${formatTokens(row.tokens)} tokens`)].join("\n");
}
