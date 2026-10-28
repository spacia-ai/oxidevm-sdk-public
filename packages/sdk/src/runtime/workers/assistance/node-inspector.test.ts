import { describe, expect, it } from "vitest";
import { nodeInspector } from "./node-inspector.js";

describe("node inspector builtin", () => {
  it("reports no inspector url and refuses sessions explicitly", () => {
    expect(nodeInspector.url()).toBeUndefined();
    expect(() => { nodeInspector.open(); }).toThrow(/inspector/u);
    expect(() => { Reflect.construct(nodeInspector.Session, []); }).toThrow(/inspector/u);
    expect(() => { nodeInspector.close(); }).not.toThrow();
  });
});
