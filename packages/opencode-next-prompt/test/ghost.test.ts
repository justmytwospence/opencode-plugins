import { expect, test } from "vitest";
import { Ghost, isPrompt } from "../src/ghost.ts";

/** A stand-in for OpenTUI's TextareaRenderable: a class accessor that records what it was given. */
class Textarea {
  _placeholder: unknown = null;
  applied: unknown[] = [];
  plainText = "";
  focused = true;
  isDestroyed = false;
  traits = { role: "prompt", owner: "opencode" };
  get placeholder() {
    return this._placeholder;
  }
  set placeholder(value: unknown) {
    const v = value ?? null;
    if (this._placeholder !== v) {
      this._placeholder = v;
      this.applied.push(v);
    }
  }
  setText(text: string) {
    this.plainText = text;
  }
  gotoBufferEnd() {
    return true;
  }
}

test("the suggestion replaces the host placeholder and the host's own writes are kept for later", () => {
  const ta = new Textarea();
  ta.placeholder = 'Ask anything... "Fix it"';
  const ghost = new Ghost();
  expect(ghost.attach(ta)).toBe(true);
  expect(ta._placeholder).toBe('Ask anything... "Fix it"');

  ghost.show("Run the tests");
  expect(ta._placeholder).toBe("Run the tests");
  expect(ghost.showing).toBe(true);

  // OpenCode re-sets its placeholder (session or width changed): the suggestion stays in front.
  ta.placeholder = 'Ask anything... "Other"';
  expect(ta._placeholder).toBe("Run the tests");
  expect(ta.placeholder).toBe('Ask anything... "Other"');

  ghost.show(undefined);
  expect(ta._placeholder).toBe('Ask anything... "Other"');
  expect(ghost.showing).toBe(false);

  ghost.show("Commit");
  ghost.detach();
  expect(ta._placeholder).toBe('Ask anything... "Other"');
  expect(Object.getOwnPropertyDescriptor(ta, "placeholder")).toBeUndefined();
  ta.placeholder = "plain again";
  expect(ta._placeholder).toBe("plain again");
});

test("attaching to another editor releases the first; a destroyed editor is not written to", () => {
  const a = new Textarea();
  const b = new Textarea();
  a.placeholder = "A";
  b.placeholder = "B";
  const ghost = new Ghost();
  ghost.attach(a);
  ghost.show("S");
  expect(ghost.attach(a)).toBe(true);
  expect(a._placeholder).toBe("S");
  ghost.attach(b);
  expect(a._placeholder).toBe("A");
  expect(b._placeholder).toBe("S");
  expect(ghost.target).toBe(b);
  b.isDestroyed = true;
  const before = b.applied.length;
  ghost.detach();
  expect(b.applied.length).toBe(before);
  expect(Object.getOwnPropertyDescriptor(b, "placeholder")).toBeUndefined();
});

test("an object without a placeholder accessor is refused", () => {
  const ghost = new Ghost();
  expect(ghost.attach({})).toBe(false);
  expect(ghost.showing).toBe(false);
});

test("isPrompt recognises OpenCode's prompt editor only", () => {
  expect(isPrompt(new Textarea())).toBe(true);
  expect(isPrompt({ plainText: "", traits: { role: "form", owner: "opencode" } })).toBe(false);
  expect(isPrompt({ plainText: "", traits: { role: "prompt", owner: "other" } })).toBe(false);
  expect(isPrompt(null)).toBe(false);
  expect(isPrompt({ traits: { role: "prompt", owner: "opencode" } })).toBe(false);
});
