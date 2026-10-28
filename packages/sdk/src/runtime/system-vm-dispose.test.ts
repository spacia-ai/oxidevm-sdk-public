import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bootedManagedVm, ScriptedWorker } from "./system-vm.test-support.js";

vi.mock("./assistance-build.js", () => ({ ASSISTANCE_BUILD: "development", ASSISTANCE_ARTIFACTS: undefined }));

describe("system VM disposal", () => {
  beforeEach(() => {
    vi.stubGlobal("Worker", ScriptedWorker);
    vi.stubGlobal("location", new URL("https://ide.example.test/"));
  });

  afterEach(() => {
    ScriptedWorker.reset();
    vi.unstubAllGlobals();
  });

  it("runs the guest while it writes the workspace out, after the page stopped its own execution", async () => {
    const vm = await bootedManagedVm();
    const control = ScriptedWorker.named("oxidevm-control");
    // The IDE shows the console in an execution of its own, and ends it before a mode switch.
    const session = new AbortController();
    const execution = await vm.diagnostics.startSystem({ signal: session.signal });
    session.abort();
    control.operations.length = 0;

    await vm.dispose();

    // The guest agent answers only while the guest runs.
    const operations = control.operations;
    const flushed = operations.indexOf("agent-sync-workspace");
    expect(flushed).toBeGreaterThan(0);
    expect(operations.slice(0, flushed)).toContain("start-system");
    await expect(execution.exit).resolves.toMatchObject({ kind: "halted" });
  });

  it("stops the page's running execution and runs the flush in its own", async () => {
    const vm = await bootedManagedVm();
    const control = ScriptedWorker.named("oxidevm-control");
    await vm.diagnostics.startSystem();
    control.operations.length = 0;

    await vm.dispose();

    const operations = control.operations;
    const flushed = operations.indexOf("agent-sync-workspace");
    expect(operations.slice(0, flushed)).toEqual(["assistance-dispose", "stop-system", "start-system"]);
    // Disposal then stops the flush's execution and the workers.
    expect(operations.slice(flushed + 1)).toEqual(["stop-system", "dispose"]);
  });

  it("keeps the CPU alive until the workspace and filesystem synchronization receipt arrives", async () => {
    const vm = await bootedManagedVm();
    const control = ScriptedWorker.named("oxidevm-control");
    control.operations.length = 0;
    const receipt = Promise.withResolvers<boolean>();
    ScriptedWorker.answers.set("agent-sync-workspace", () => receipt.promise);
    const closing = vm.dispose();
    await vi.waitFor(() => expect(control.operations).toContain("agent-sync-workspace"));
    const index = control.operations.indexOf("agent-sync-workspace");
    expect(control.operations.slice(index + 1)).toEqual([]);
    receipt.resolve(true);
    await closing;
    expect(control.operations.slice(index + 1)).toEqual(["stop-system", "dispose"]);
  });
  it("retires an ephemeral guest without capturing a workspace that disposal discards", async () => {
    const vm = await bootedManagedVm(true);
    const control = ScriptedWorker.named("oxidevm-control");
    await vm.diagnostics.startSystem(); control.operations.length = 0;
    await vm.dispose();
    expect(control.operations).not.toContain("agent-sync-workspace");
    expect(control.operations).not.toContain("agent-workspace-delta");
    expect(control.operations).toEqual(["assistance-dispose", "stop-system", "dispose"]);
  });
});
