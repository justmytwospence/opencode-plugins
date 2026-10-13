import { describe, expect, test } from "vitest";
import { HerdrHold, herdrTarget } from "../src/herdr.js";

const target = { socketPath: "/tmp/herdr.sock", paneId: "w1:p1" };

function recorder(focused = false) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const send = async (_t: unknown, method: string, params: Record<string, unknown>) => {
    calls.push([method, params]);
    return method === "pane.get" ? { result: { pane: { focused } } } : { result: {} };
  };
  return { calls, send };
}

describe("herdr reports of the kernel hold", () => {
  test("only inside a herdr pane", () => {
    expect(herdrTarget({})).toBeUndefined();
    expect(herdrTarget({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/s", HERDR_PANE_ID: "w1:p1" })).toEqual({ socketPath: "/s", paneId: "w1:p1" });
  });

  test("the token while held, then cleared with a notification", async () => {
    const { calls, send } = recorder();
    const herdr = new HerdrHold("pi", target, send);
    await herdr.apply({ kind: "held", value: "fit.py: Model fit" });
    await herdr.apply({ kind: "finished", title: "fit.py finished", body: "ran 2m00s" });
    expect(calls).toEqual([
      ["pane.report_metadata", { pane_id: "w1:p1", source: "marimo", agent: "pi", tokens: { marimo: "fit.py: Model fit" }, ttl_ms: 86_400_000 }],
      ["pane.report_metadata", { pane_id: "w1:p1", source: "marimo", agent: "pi", tokens: { marimo: null } }],
      ["pane.get", { pane_id: "w1:p1" }],
      ["notification.show", { title: "fit.py finished", body: "ran 2m00s", sound: "done" }],
    ]);
  });

  test("no notification on a focused pane or a release; nothing outside herdr", async () => {
    const focused = recorder(true);
    const herdr = new HerdrHold("pi", target, focused.send);
    await herdr.apply({ kind: "held", value: "fit.py: 2 queued" });
    await herdr.apply({ kind: "finished", title: "fit.py finished", body: "ran 1s" });
    expect(focused.calls.map(([m]) => m)).toEqual(["pane.report_metadata", "pane.report_metadata", "pane.get"]);
    const released = recorder();
    const other = new HerdrHold("pi", target, released.send);
    await other.apply({ kind: "held", value: "fit.py: Model fit" });
    await other.apply({ kind: "released" });
    expect(released.calls.map(([m]) => m)).toEqual(["pane.report_metadata", "pane.report_metadata"]);
    const outside = recorder();
    await new HerdrHold("pi", undefined, outside.send).apply({ kind: "held", value: "x" });
    expect(outside.calls).toEqual([]);
  });
});
