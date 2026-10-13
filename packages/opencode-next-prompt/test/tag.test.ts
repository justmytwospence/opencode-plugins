import { expect, test } from "vitest";
import { INSTRUCTION, extractNext } from "../src/tag.ts";

const block = (body: string, fence = "```") => `${fence}next\n${body}\n${fence}`;

test("a last next block is removed and becomes the suggestion", () => {
  expect(extractNext(`Edited a.ts.\n\n${block("Run the tests")}`)).toEqual({ text: "Edited a.ts.", suggestion: "Run the tests", found: true });
  expect(extractNext(`Edited a.ts.\n\n${block("Run the tests")}\n`)).toEqual({ text: "Edited a.ts.", suggestion: "Run the tests", found: true });
});

test("whitespace, indentation, tildes and longer fences are tolerated", () => {
  expect(extractNext("Done.\n  ```next  \n  Commit the change  \n  ```  \n\n")).toEqual({ text: "Done.", suggestion: "Commit the change", found: true });
  expect(extractNext(`Done.\n${block("Commit", "~~~")}`)).toEqual({ text: "Done.", suggestion: "Commit", found: true });
  expect(extractNext(`Done.\n${block("Commit", "````")}`)).toEqual({ text: "Done.", suggestion: "Commit", found: true });
  expect(extractNext("Done.\r\n```next\r\nCommit\r\n```\r\n")).toEqual({ text: "Done.", suggestion: "Commit", found: true });
});

test("a block the model left open at the end still counts", () => {
  expect(extractNext("Done.\n\n```next\nRun the tests")).toEqual({ text: "Done.", suggestion: "Run the tests", found: true });
  expect(extractNext("Done.\n\n```next\nRun the tests\n")).toEqual({ text: "Done.", suggestion: "Run the tests", found: true });
});

test("no block leaves the text untouched", () => {
  const text = "All done, nothing pending.\n";
  expect(extractNext(text)).toEqual({ text, found: false });
  const other = "Run:\n```sh\nnpm test\n```\n";
  expect(extractNext(other)).toEqual({ text: other, found: false });
  const similar = "```nextjs\nexport default {}\n```";
  expect(extractNext(similar)).toEqual({ text: similar, found: false });
});

test("several blocks are all removed; the last one wins; a paragraph break remains between the rest", () => {
  const out = extractNext(`A\n${block("first")}\nB\n${block("second")}`);
  expect(out).toEqual({ text: "A\n\nB", suggestion: "second", found: true });
  expect(extractNext(`${block("first")}\n\nA`)).toEqual({ text: "A", suggestion: "first", found: true });
});

test("a fence inside prose or inside another code block is not a block of its own", () => {
  const text = "The model may end with a ```next block on its own line.";
  expect(extractNext(text)).toEqual({ text, found: false });
});

test("too long, multi-line or empty suggestions are stripped but not offered", () => {
  const long = "x".repeat(111);
  expect(extractNext(`Done.\n${block(long)}`)).toEqual({ text: "Done.", found: true });
  expect(extractNext(`Done.\n${block("x".repeat(110))}`).suggestion).toHaveLength(110);
  expect(extractNext(`Done.\n${block("  ")}`)).toEqual({ text: "Done.", found: true });
  expect(extractNext(`Done.\n${block("abcdef")}`, 5)).toEqual({ text: "Done.", found: true });
  expect(extractNext(`Done.\n${block("Run the\ntests")}`)).toEqual({ text: "Done.", suggestion: "Run the tests", found: true });
});

test("the instruction is short and shows the block", () => {
  expect(INSTRUCTION.length).toBeLessThan(900);
  expect(INSTRUCTION).toContain("```next\nRun the tests\n```");
});
