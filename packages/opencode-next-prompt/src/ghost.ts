// The ghost text: the suggestion shown as the empty prompt's placeholder. OpenCode's prompt is an
// OpenTUI TextareaRenderable whose `placeholder` OpenCode sets reactively (a random example such
// as `Ask anything... "Fix the tests"`, re-set when the session or the width changes). Rather
// than racing that, the prompt instance gets an own `placeholder` accessor in front of the class
// one: OpenCode's writes land in `host`, the class setter receives the suggestion while one is
// on offer and OpenCode's own text otherwise, and detaching puts the plain property back.
//
// A textarea draws its placeholder only while it is empty, which is exactly Pi's rule: typing
// hides the suggestion, clearing the prompt brings it back, sending a prompt drops it (the
// caller clears the offer then). Duck-typed so tests need no OpenTUI.

export interface EditorLike {
  plainText: string;
  focused: boolean;
  isDestroyed?: boolean;
  traits?: { role?: string; owner?: string };
  setText(text: string): void;
  gotoBufferEnd(): unknown;
}

/** OpenCode marks its prompt editor with these traits; dialog and form editors differ. */
export function isPrompt(value: unknown): value is EditorLike {
  const r = value as Partial<EditorLike> | null | undefined;
  return Boolean(r && typeof r === "object" && typeof r.plainText === "string" && r.traits?.role === "prompt" && r.traits.owner === "opencode");
}

function accessor(target: object, name: string): PropertyDescriptor | undefined {
  for (let proto = Object.getPrototypeOf(target); proto; proto = Object.getPrototypeOf(proto)) {
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (d) return d.get && d.set ? d : undefined;
  }
  return undefined;
}

export class Ghost {
  private editor: object | undefined;
  private restore: (() => void) | undefined;
  private apply: (() => void) | undefined;
  /** The placeholder on offer (a string or StyledText), or undefined for OpenCode's own. */
  private offer: unknown;

  /** The editor the ghost is attached to. */
  get target(): object | undefined {
    return this.editor;
  }

  /** Attach to a prompt editor; false when it has no settable placeholder. Re-attaching is a no-op. */
  attach(editor: object): boolean {
    if (this.editor === editor) return true;
    this.detach();
    const base = accessor(editor, "placeholder");
    if (!base?.get || !base.set) return false;
    const { get, set } = base;
    let host: unknown = get.call(editor);
    const apply = () => set.call(editor, this.offer ?? host);
    Object.defineProperty(editor, "placeholder", {
      configurable: true,
      enumerable: false,
      get: () => host,
      set: (value: unknown) => {
        host = value;
        apply();
      },
    });
    this.editor = editor;
    this.apply = apply;
    this.restore = () => {
      delete (editor as { placeholder?: unknown }).placeholder;
      if (!(editor as EditorLike).isDestroyed) set.call(editor, host);
    };
    apply();
    return true;
  }

  /** Put OpenCode's placeholder back and let go of the editor. */
  detach(): void {
    const restore = this.restore;
    this.editor = this.apply = this.restore = undefined;
    restore?.();
  }

  /** Show `value` as the placeholder (undefined: OpenCode's own). */
  show(value: unknown): void {
    if (this.offer === value) return;
    this.offer = value;
    this.apply?.();
  }

  get showing(): boolean {
    return this.offer !== undefined && this.editor !== undefined;
  }
}
