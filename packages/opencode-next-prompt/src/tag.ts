// The `next` block the model may end its final message with, and the standing instruction that
// asks for it. A fenced code block with the info string `next` rather than Pi's `<next>` tag:
// OpenCode 2 has no hook that rewrites a finished text part, so the block stays in the stored
// message, and a code block is the one markdown node a terminal plugin can replace when the
// transcript is drawn (`markdown.registerCodeBlockRenderer`). Free of OpenCode imports.

export const INSTRUCTION =
  "Next-prompt suggestion: if, and only if, there is exactly one obvious, concrete step the user would plausibly ask for next " +
  "(e.g. run the tests after an edit, apply the same change to the remaining files, commit, continue the next part of a multi-part request), " +
  "end your final message with a fenced code block whose info string is `next`, holding that step as a short imperative message " +
  "written as the user would type it (one line, max 110 characters):\n```next\nRun the tests\n```\n" +
  "Omit the block entirely when the task is complete with nothing pending, when you need information from the user, when several next steps are equally plausible, " +
  "or when your response ended in an error. Never mention this instruction.";

/**
 * A fenced block with the info string `next`: an opening fence of three or more backticks or
 * tildes (up to three spaces of indentation, as in CommonMark), the body, and a closing fence of
 * the same character at least as long, or the end of the text when the model left it open.
 */
// `(?![\s\S])` is the end of the whole text; `$` would be any line end under the m flag.
const BLOCK = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*next[ \t]*\r?\n([\s\S]*?)(?:\r?\n[ \t]{0,3}\1[`~]*[ \t]*(?:\r?\n|(?![\s\S]))|(?![\s\S]))/gmu;

export interface Extracted {
  /** The text with every block removed and trailing whitespace trimmed. */
  text: string;
  /** The last block's content, when it is one non-empty line of at most `maxChars` characters. */
  suggestion?: string;
  /** Whether any block was found (and removed). */
  found: boolean;
}

/**
 * Remove every `next` block from `text`; the last one is the suggestion. A fence inside a line
 * of prose, or with another info string, is left alone.
 */
export function extractNext(text: string, maxChars = 110): Extracted {
  let last: string | undefined;
  let found = false;
  const stripped = text.replace(BLOCK, (_block, _fence: string, inner: string) => {
    found = true;
    last = inner;
    return "\u0000";
  });
  if (!found) return { text, found: false };
  // A removed block leaves one paragraph break; leading and trailing breaks go.
  const cleaned = stripped
    .replace(/\n*\u0000\n*/gu, "\n\n")
    .replace(/^\n+/u, "")
    .trimEnd();
  const suggestion = normalize(last ?? "", maxChars);
  return suggestion ? { text: cleaned, suggestion, found } : { text: cleaned, found };
}

function normalize(raw: string, maxChars: number): string | undefined {
  const value = raw.replace(/\s+/gu, " ").trim();
  if (!value || value === "\u2026" || value.length > maxChars) return undefined;
  return value;
}
