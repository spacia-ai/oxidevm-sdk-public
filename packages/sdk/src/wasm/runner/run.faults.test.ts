import { describe, expect, it } from "vitest";
import { COMMAND_DECLARATION, buildRelease, type Release } from "./fixtures.test-support.js";
import { launch, records } from "./harness.test-support.js";
import type { Capability } from "../capabilities.js";

const wasm = Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0);
const commandRelease = (adapter: string, host: readonly Capability[] = ["files.sync"]): Promise<Release> =>
  buildRelease({ adapter, artifacts: { "tool.wasm": wasm }, declaration: { ...COMMAND_DECLARATION, requires: { host } } });

// The fault in an adapter-fault report (exit 123) says which rule the module broke, so tools such as
// `oxidevm wasm test` can name it without reading the message prose.
describe("adapter fault reports", () => {
  it("reports a main status outside 0-119 as an exit-status fault", async () => {
    const running = launch({ release: await commandRelease("export default () => ({ main: () => 200 });") });
    await expect(running.done).resolves.toBe(123);
    expect(records(running.linux.stderrLines).at(-1)).toMatchObject({ oxidevm: "error", kind: "adapter", fault: "exit-status" });
  });

  it("reports an adapter with the wrong shape as a shape fault", async () => {
    const running = launch({ release: await commandRelease("export default () => ({ run: () => 0 });") });
    await expect(running.done).resolves.toBe(123);
    expect(records(running.linux.stderrLines).at(-1)).toMatchObject({ kind: "adapter", fault: "shape" });
  });

  it("reports an error the adapter's own code throws as a thrown fault", async () => {
    const running = launch({ release: await commandRelease('export default () => ({ main: () => { throw new Error("boom"); } });') });
    await expect(running.done).resolves.toBe(123);
    expect(records(running.linux.stderrLines).at(-1)).toMatchObject({ kind: "adapter", fault: "thrown", message: "boom" });
  });

  it("warns once about an undeclared capability member, keeps it absent and names it in the fault", async () => {
    const running = launch({ release: await commandRelease(`export default host => ({ main: () => {
      host.log("absent=" + (host.process === undefined && !("process" in host)));
      return host.process.spawn("/bin/true", []);
    } });`) });
    await expect(running.done).resolves.toBe(123);
    const written = records(running.linux.stderrLines);
    expect(written.filter(line => line["oxidevm"] === "warning")).toEqual([
      { oxidevm: "warning", v: 1, kind: "undeclared-capability", member: "process", capabilities: ["process.info", "process.spawn", "process.signals"] },
    ]);
    expect(written.at(-1)).toMatchObject({ oxidevm: "error", kind: "adapter", fault: "undeclared-capability", capabilities: ["process.info", "process.spawn", "process.signals"] });
    expect(running.linux.stderrLines).toContain("absent=true");
  });

  it("names the one missing capability of a partly declared process member", async () => {
    const running = launch({ release: await commandRelease("export default host => ({ main: () => host.process.spawn(\"/bin/true\", []) });", ["process.info"]) });
    await expect(running.done).resolves.toBe(123);
    const written = records(running.linux.stderrLines);
    expect(written.filter(line => line["oxidevm"] === "warning")).toEqual([
      { oxidevm: "warning", v: 1, kind: "undeclared-capability", member: "process.spawn", capabilities: ["process.spawn"] },
    ]);
    expect(written.at(-1)).toMatchObject({ fault: "undeclared-capability", capabilities: ["process.spawn"] });
  });

  it("does not warn when the adapter only uses what it declared", async () => {
    const running = launch({ release: await commandRelease("export default host => ({ main: () => { host.fs; host.log(typeof host.kit); return 0; } });") });
    await expect(running.done).resolves.toBe(0);
    expect(records(running.linux.stderrLines)).toEqual([]);
  });
});
