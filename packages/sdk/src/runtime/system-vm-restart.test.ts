import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VMError } from "./errors.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import { bootedManagedVm, ScriptedWorker } from "./system-vm.test-support.js";

vi.mock("./assistance-build.js", () => ({ ASSISTANCE_BUILD: "development", ASSISTANCE_ARTIFACTS: undefined }));

const MANIFEST = "https://images.example.test/alpine/manifest.json";

/** Answers a guest spawn and ends the process with `code` through its port. */
function exitingSpawn(code: number): (input: Record<string, unknown>) => unknown {
  return (input) => {
    const port = input["port"];
    if (!(port instanceof MessagePort)) throw new Error("a port was not transferred");
    queueMicrotask(() => {
      port.postMessage({ version: PROTOCOL_VERSION, sessionId: 1, sequence: 1, type: "exit", termination: { kind: "exit", code } });
      port.close();
    });
    return { pid: 7, sessionId: 1 };
  };
}

describe("restarting a system VM", () => {
  beforeEach(() => {
    vi.stubGlobal("Worker", ScriptedWorker);
    vi.stubGlobal("location", new URL("https://ide.example.test/"));
  });

  afterEach(() => {
    ScriptedWorker.reset();
    vi.unstubAllGlobals();
  });

  it("asks the running guest to write its files to disk before the restart reboots it", async () => {
    ScriptedWorker.answers.set("agent-spawn", exitingSpawn(0));
    const vm = await bootedManagedVm();
    const control = ScriptedWorker.named("oxidevm-control");

    await vm.bootManagedImage(MANIFEST, { resume: "none" });

    expect(control.inputs.filter((input) => input["type"] === "agent-spawn")).toMatchObject([{ command: "sync" }]);
    expect(control.operations.indexOf("agent-spawn")).toBeLessThan(control.operations.indexOf("boot-system"));
    await vm.dispose();
  });

  it("restarts a guest that cannot write its files out all the same", async () => {
    ScriptedWorker.answers.set("agent-spawn", () => {
      throw new VMError("GUEST_CRASH", "the guest agent is gone");
    });
    const vm = await bootedManagedVm();

    const restarted = await vm.bootManagedImage(MANIFEST, { resume: "none" });

    expect(restarted.start).toEqual({ kind: "booted", reason: "restart" });
    expect(ScriptedWorker.named("oxidevm-control").operations).toContain("boot-system");
    await vm.dispose();
  });
});
