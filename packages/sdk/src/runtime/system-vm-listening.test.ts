import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VMError } from "./errors.js";
import { createSystemRuntimeVM } from "./system-vm.js";
import { ScriptedWorker } from "./system-vm.test-support.js";
import type { ListeningPort } from "./vm-types.js";

vi.mock("./assistance-build.js", () => ({ ASSISTANCE_BUILD: "development", ASSISTANCE_ARTIFACTS: undefined }));

const BUN: ListeningPort = { port: 3000, address: "0.0.0.0", program: "bun dev", previewable: true };
const VITE: ListeningPort = { port: 5173, address: "::", program: "node vite", previewable: true };

function vm() {
  return createSystemRuntimeVM({ mode: "system", workspaceId: "listening", memoryMiB: 256, vcpus: 1, network: "local" });
}

function listenerOperations(): string[] {
  return ScriptedWorker.named("oxidevm-control").operations.filter((type) => type.startsWith("agent-listeners-"));
}

/** Control's end of the page's watch port, once the page has sent it. */
let watchPort: MessagePort | undefined;

function control(): MessagePort {
  if (watchPort === undefined) throw new Error("no watch port was sent");
  return watchPort;
}

function watcher() {
  const calls: (readonly ListeningPort[])[] = [];
  const stop = new AbortController();
  return { calls, stop, onChange: (ports: readonly ListeningPort[]) => { calls.push(ports); } };
}

describe("System listening ports", () => {
  beforeEach(() => {
    vi.stubGlobal("Worker", ScriptedWorker);
    vi.stubGlobal("location", new URL("https://ide.example.test/"));
    watchPort = undefined;
    ScriptedWorker.answers.set("agent-listeners-watch", (input) => {
      const port = input["port"];
      if (!(port instanceof MessagePort)) throw new Error("no port was transferred");
      watchPort = port;
      return undefined;
    });
    ScriptedWorker.answers.set("agent-listeners-unwatch", () => undefined);
  });

  afterEach(async () => {
    // A release waits a turn; let it reach this test's control before the next test scripts its own.
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    watchPort?.close();
    ScriptedWorker.reset();
    vi.unstubAllGlobals();
  });

  it("shares one control watch among watchers and stops it after the last one", async () => {
    const system = await vm();
    const first = watcher();
    const second = watcher();
    const firstWatch = system.watchListeningPorts(first.onChange, { signal: first.stop.signal });
    const secondWatch = system.watchListeningPorts(second.onChange, { signal: second.stop.signal });
    await vi.waitFor(() => { expect(watchPort).toBeDefined(); });
    control().postMessage({ type: "ports", ports: [BUN] });
    await vi.waitFor(() => { expect([first.calls, second.calls]).toEqual([[[BUN]], [[BUN]]]); });
    expect(listenerOperations()).toEqual(["agent-listeners-watch"]);
    first.stop.abort();
    await firstWatch;
    expect(listenerOperations()).toEqual(["agent-listeners-watch"]);
    second.stop.abort();
    await secondWatch;
    await vi.waitFor(() => { expect(listenerOperations()).toEqual(["agent-listeners-watch", "agent-listeners-unwatch"]); });
  });

  it("calls back only when the list changes, and gives a late watcher the latest list", async () => {
    const system = await vm();
    const first = watcher();
    const watching = system.watchListeningPorts(first.onChange, { signal: first.stop.signal });
    await vi.waitFor(() => { expect(watchPort).toBeDefined(); });
    control().postMessage({ type: "ports", ports: [BUN] });
    control().postMessage({ type: "ports", ports: [BUN] });
    control().postMessage({ type: "ports", ports: [BUN, VITE] });
    await vi.waitFor(() => { expect(first.calls).toEqual([[BUN], [BUN, VITE]]); });
    const late = watcher();
    const lateWatch = system.watchListeningPorts(late.onChange, { signal: late.stop.signal });
    await vi.waitFor(() => { expect(late.calls).toEqual([[BUN, VITE]]); });
    expect(listenerOperations()).toEqual(["agent-listeners-watch"]);
    first.stop.abort();
    late.stop.abort();
    await Promise.all([watching, lateWatch]);
  });

  it("keeps watching when the panel's Try again replaces its watcher in one turn", async () => {
    // Control holds one page port and an unwatch ends whichever port it holds.
    ScriptedWorker.answers.set("agent-listeners-unwatch", () => {
      watchPort?.close();
      watchPort = undefined;
      return undefined;
    });
    const system = await vm();
    const first = watcher();
    const firstWatch = system.watchListeningPorts(first.onChange, { signal: first.stop.signal });
    await vi.waitFor(() => { expect(watchPort).toBeDefined(); });
    control().postMessage({ type: "ports", ports: [BUN] });
    await vi.waitFor(() => { expect(first.calls).toEqual([[BUN]]); });
    // An effect that runs again stops its watcher and starts the next in the same turn.
    const second = watcher();
    first.stop.abort();
    const secondWatch = system.watchListeningPorts(second.onChange, { signal: second.stop.signal });
    await firstWatch;
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    await vi.waitFor(() => { expect(listenerOperations().at(-1)).toBe("agent-listeners-watch"); });
    control().postMessage({ type: "ports", ports: [BUN, VITE] });
    await vi.waitFor(() => { expect(second.calls.at(-1)).toEqual([BUN, VITE]); });
    second.stop.abort();
    await secondWatch;
    await vi.waitFor(() => { expect(listenerOperations().at(-1)).toBe("agent-listeners-unwatch"); });
  });

  it("sends a new watch only after the unwatch that ended the previous one", async () => {
    let answerFirstWatch = (): void => {};
    ScriptedWorker.answers.set("agent-listeners-watch", (input) => {
      const port = input["port"];
      if (!(port instanceof MessagePort)) throw new Error("no port was transferred");
      watchPort = port;
      // The first watch is answered late; later ones at once.
      if (listenerOperations().length > 1) return undefined;
      return new Promise<undefined>((resolve) => { answerFirstWatch = () => { resolve(undefined); }; });
    });
    ScriptedWorker.answers.set("agent-listeners-unwatch", () => {
      watchPort?.close();
      watchPort = undefined;
      return undefined;
    });
    const system = await vm();
    const first = watcher();
    const firstWatch = system.watchListeningPorts(first.onChange, { signal: first.stop.signal });
    await vi.waitFor(() => { expect(watchPort).toBeDefined(); });
    first.stop.abort();
    await firstWatch;
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    const second = watcher();
    const secondWatch = system.watchListeningPorts(second.onChange, { signal: second.stop.signal });
    answerFirstWatch();
    await vi.waitFor(() => {
      expect(listenerOperations()).toEqual(["agent-listeners-watch", "agent-listeners-unwatch", "agent-listeners-watch"]);
    });
    await vi.waitFor(() => { expect(watchPort).toBeDefined(); });
    control().postMessage({ type: "ports", ports: [VITE] });
    await vi.waitFor(() => { expect(second.calls).toEqual([[VITE]]); });
    second.stop.abort();
    await secondWatch;
  });

  it("rejects watchers with image-update-required when control refuses the watch", async () => {
    ScriptedWorker.answers.set("agent-listeners-watch", () => {
      throw new VMError("FEATURE_NOT_AVAILABLE", "update Linux", { reason: "image-update-required" });
    });
    const system = await vm();
    const refused = watcher();
    await expect(system.watchListeningPorts(refused.onChange, { signal: refused.stop.signal }))
      .rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE", detail: { reason: "image-update-required" } });
  });

  it("rejects every watcher when control says the agent cannot report ports", async () => {
    const system = await vm();
    const first = watcher();
    const second = watcher();
    const watches = [first, second].map((entry) => system.watchListeningPorts(entry.onChange, { signal: entry.stop.signal }));
    await vi.waitFor(() => { expect(watchPort).toBeDefined(); });
    control().postMessage({ type: "failed", error: { code: "FEATURE_NOT_AVAILABLE", message: "update Linux", detail: { reason: "image-update-required" } } });
    for (const watch of watches) {
      await expect(watch).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE", detail: { reason: "image-update-required" } });
    }
  });

  it("stops the VM with PROTOCOL_ERROR when a list is malformed", async () => {
    const system = await vm();
    const broken = watcher();
    const watching = system.watchListeningPorts(broken.onChange, { signal: broken.stop.signal });
    await vi.waitFor(() => { expect(watchPort).toBeDefined(); });
    control().postMessage({ type: "ports", ports: [{ ...BUN, port: 0 }] });
    await expect(watching).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(broken.calls).toEqual([]);
  });

  it("lists through control and passes its reasons through", async () => {
    ScriptedWorker.answers.set("agent-listeners-list", () => [BUN]);
    const system = await vm();
    await expect(system.listeningPorts()).resolves.toEqual([BUN]);
    ScriptedWorker.answers.set("agent-listeners-list", () => {
      throw new VMError("FEATURE_NOT_AVAILABLE", "the guest agent has not started yet", { reason: "agent-not-ready" });
    });
    await expect(system.listeningPorts()).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE", detail: { reason: "agent-not-ready" } });
  });

  it("refuses a watch without exactly an AbortSignal", async () => {
    const system = await vm();
    const method: unknown = Reflect.get(system, "watchListeningPorts");
    if (typeof method !== "function") throw new Error("watchListeningPorts is missing");
    const watching: unknown = Reflect.apply(method, system, [() => undefined, {}]);
    await expect(watching).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});
