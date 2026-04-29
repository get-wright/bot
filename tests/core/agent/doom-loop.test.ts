import { describe, it, expect } from "vitest";
import { DoomLoopDetector } from "../../../src/core/agent/doom-loop.js";

describe("DoomLoopDetector", () => {
  it("does not trigger for different calls", () => {
    const detector = new DoomLoopDetector();
    detector.record("read", { path: "a.py" });
    detector.record("grep", { pattern: "foo" });
    detector.record("read", { path: "b.py" });
    expect(detector.check()).toBe("ok");
  });

  it("triggers warning after 3 identical consecutive calls", () => {
    const detector = new DoomLoopDetector();
    detector.record("read", { path: "a.py" });
    detector.record("read", { path: "a.py" });
    detector.record("read", { path: "a.py" });
    expect(detector.check()).toBe("warn");
  });

  it("triggers abort after warning + 3 more identical calls", () => {
    const detector = new DoomLoopDetector();
    detector.record("read", { path: "a.py" });
    detector.record("read", { path: "a.py" });
    detector.record("read", { path: "a.py" });
    expect(detector.check()).toBe("warn");
    detector.acknowledge();
    detector.record("read", { path: "a.py" });
    detector.record("read", { path: "a.py" });
    detector.record("read", { path: "a.py" });
    expect(detector.check()).toBe("abort");
  });

  it("resets when a different call breaks the streak", () => {
    const detector = new DoomLoopDetector();
    detector.record("read", { path: "a.py" });
    detector.record("read", { path: "a.py" });
    detector.record("grep", { pattern: "foo" });
    detector.record("read", { path: "a.py" });
    detector.record("read", { path: "a.py" });
    expect(detector.check()).toBe("ok");
  });
});
