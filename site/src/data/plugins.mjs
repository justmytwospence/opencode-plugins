// Public navigation and catalog; scripts/test-contracts.mjs and check-docs compare this list to packages/.
export const groups = [
  { title: "Run & coordinate", eyebrow: "01 / Execution", description: "Keep long-running work visible. Delegate bounded tasks without losing the thread.", plugins: [
    { name: "opencode-bg", label: "Background work", description: "Jobs and services with readiness, waiting that stays inside the turn, logs and a viewer." },
    { name: "opencode-subagents", label: "Delegation", description: "Parallel tasks, chains and worktree isolation on top of OpenCode's own subagents." },
    { name: "opencode-herdr", label: "Herdr", description: "Pane metadata, interactive children and the herdr bridge other components report through." },
    { name: "opencode-marimo", label: "Notebooks", description: "Live notebook state alongside your conversation, without taking over the kernel." },
    { name: "opencode-btw", label: "Side conversation", description: "Ask a side question in its own thread while the main run keeps going." },
  ] },
  { title: "Think & review", eyebrow: "02 / Decisions", description: "Make the decision explicit and review the actual changes.", plugins: [
    { name: "opencode-diff-review", label: "Diff review", description: "Line comments and suggested edits on the last turn's changes, sent back to the agent together." },
    { name: "opencode-tool-gate", label: "Tool gate", description: "Permission modes and classifier-assisted auto approval through OpenCode's own prompts. Not a sandbox." },
  ] },
  { title: "Context & cost", eyebrow: "03 / Awareness", description: "See what the session is using and choose when to spend more reasoning or context.", plugins: [
    { name: "opencode-cache-guard", label: "Cache guard", description: "Cache-expiry warnings, a cache clock and optional Jev context trimming." },
    { name: "opencode-auto-effort", label: "Auto effort", description: "Classifier-guided reasoning levels, bounded by the variant you chose." },
    { name: "opencode-status-footer", label: "Status footer", description: "Git marks beside the branch and subscription windows in the sidebar." },
    { name: "opencode-context", label: "Context breakdown", description: "See what fills the context window, part by part, with previews." },
  ] },
  { title: "Make it yours", eyebrow: "04 / Terminal craft", description: "Small, focused improvements to the place you spend your working day.", plugins: [
    { name: "opencode-copy", label: "Copy picker", description: "Pick useful fragments from the session instead of copying a whole reply." },
    { name: "opencode-next-prompt", label: "Next prompt", description: "An optional next step in the empty prompt. Accept it with Tab; never auto-sent." },
    { name: "opencode-markdown-extras", label: "Markdown extras", description: "Text diagrams for Mermaid fences and tidier Markdown in the transcript." },
    { name: "opencode-prose-width", label: "Prose width", description: "Readable paragraphs without narrowing code blocks and tables." },
    { name: "opencode-sticky-last-prompt", label: "Sticky prompt", description: "Keep the prompt you scrolled past in view." },
  ] },
];
export const plugins = groups.flatMap((group) => group.plugins);
