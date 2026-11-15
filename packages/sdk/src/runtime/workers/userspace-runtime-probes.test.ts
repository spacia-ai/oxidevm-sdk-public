import { expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "../protocol/common.js";
import { collectRuntimeProbe, UserspaceRuntimeProbes, type RuntimeProbePorts } from "./userspace-runtime-probes.js";

const SHA = (digit: string) => digit.repeat(64), NVM = "/home/user/.nvm/versions/node/v24.11.0/bin/node";
const CONFIG = '{"variables":{}}', LINES = `v24.11.0\n24.11.0\n1.51.0\n10\n\n${CONFIG}\n`;

/** Rust's side of operations 11 and 12, and a Linux that runs probes as told. */
function ports(requests: string[], run: RuntimeProbePorts["run"]) {
  const reports: { readonly sha256: string; readonly tag: number }[] = [];
  const value: RuntimeProbePorts = {
    command(bytes) {
      if (bytes[4] === 14) return Uint8Array.of(0);
      if (bytes[4] === 11) { const next = requests.shift(); return next === undefined ? new Uint8Array() : new TextEncoder().encode(next); }
      reports.push({ sha256: new TextDecoder().decode(bytes.subarray(21, 85)), tag: bytes[85] ?? -1 });
      return new Uint8Array();
    },
    run,
  };
  return { value, reports };
}

it("takes every probe Rust asks for, runs it in Linux and reports its build", async () => {
  const calls: unknown[] = [];
  const rust = ports([SHA("a") + NVM, SHA("b") + "/opt/bun/bin/bun"], (sha256, path) => {
    calls.push([sha256, path]);
    return Promise.resolve({ stdout: new TextEncoder().encode(LINES), ending: { kind: "exit", code: 0 } });
  });
  const probes = new UserspaceRuntimeProbes(rust.value);
  probes.pump(); await probes.idle();
  expect(calls).toEqual([[SHA("a"), NVM], [SHA("b"), "/opt/bun/bin/bun"]]);
  expect(rust.reports).toEqual([{ sha256: SHA("a"), tag: 0 }, { sha256: SHA("b"), tag: 0 }]);
  probes.dispose();
});

it("polls Rust's background scheduler only while this runtime is active", async () => {
  vi.useFakeTimers();
  let polls = 0, wakes = 0;
  const probes = new UserspaceRuntimeProbes({
    command: bytes => { if (bytes[4] === 14) { polls++; return Uint8Array.of(1); } return new Uint8Array(); },
    run: () => Promise.reject(new Error("no runtime probe")), settled: () => { wakes++; },
  });
  try {
    probes.pump();
    await vi.advanceTimersByTimeAsync(500);
    expect(polls).toBe(1); expect(wakes).toBe(1);
    await probes.suspend();
    await vi.advanceTimersByTimeAsync(1000);
    expect(polls).toBe(1);
    probes.resume();
    await vi.advanceTimersByTimeAsync(500);
    expect(polls).toBe(2);
    probes.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(polls).toBe(2);
  } finally { probes.dispose(); vi.useRealTimers(); }
});

it("stops the background timer when Rust disables this runtime's policy", async () => {
  vi.useFakeTimers();
  let polls = 0;
  const probes = new UserspaceRuntimeProbes({
    command: bytes => { if (bytes[4] === 14) { polls++; return Uint8Array.of(2); } return new Uint8Array(); },
    run: () => Promise.reject(new Error("no runtime probe")),
  });
  try {
    probes.pump();
    await vi.advanceTimersByTimeAsync(500);
    expect(polls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    await probes.suspend(); probes.resume(); probes.pump();
    await vi.advanceTimersByTimeAsync(1000);
    expect(polls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally { probes.dispose(); vi.useRealTimers(); }
});

it("reports a probe that could not start, lost its port or was ended by a save as cancelled", async () => {
  const failing = ports([SHA("c") + NVM, SHA("f") + NVM], () => failing.reports.length === 0 ? Promise.reject(new Error("process limit")) : Promise.resolve({ stdout: new Uint8Array(), ending: "unavailable" }));
  const probes = new UserspaceRuntimeProbes(failing.value, 1);
  probes.pump(); await probes.idle(); probes.pump(); await probes.idle();
  expect(failing.reports).toEqual([{ sha256: SHA("c"), tag: 2 }, { sha256: SHA("f"), tag: 2 }]);
  let release: (() => void) | undefined;
  const saving = ports([SHA("d") + NVM, SHA("e") + NVM], (_sha256, _path, signal) => new Promise(resolve => {
    release = () => { resolve({ stdout: new Uint8Array(), ending: { kind: "signal", signal: 9 } }); };
    signal.addEventListener("abort", () => { release?.(); });
  }));
  const saved = new UserspaceRuntimeProbes(saving.value, 1);
  saved.pump();
  await saved.suspend();
  expect(saving.reports).toEqual([{ sha256: SHA("d"), tag: 2 }]);
  saved.pump();
  expect(saving.reports).toHaveLength(1);
  saved.resume();
  release?.(); await saved.idle();
  expect(saving.reports).toEqual([{ sha256: SHA("d"), tag: 2 }, { sha256: SHA("e"), tag: 1 }]);
  probes.dispose(); saved.dispose();
});

it("collects a probe's stdout in order, acknowledging each chunk, until it exits", async () => {
  const channel = new MessageChannel(), acks: unknown[] = [];
  const acknowledged = new Promise<void>(resolve => { channel.port1.onmessage = (event: MessageEvent<unknown>) => { if (acks.push(event.data) === 3) resolve(); }; });
  const run = collectRuntimeProbe(channel.port2, 7, () => { throw new Error("not killed"); }, new AbortController().signal);
  const send = (sequence: number, value: Record<string, unknown>) => { channel.port1.postMessage({ version: PROTOCOL_VERSION, sessionId: 7, sequence, ...value }); };
  send(1, { type: "stdout", data: new TextEncoder().encode("v24.11.0\n") });
  send(2, { type: "stderr", data: new TextEncoder().encode("warning\n") });
  send(3, { type: "stdout", data: new TextEncoder().encode("rest\n") });
  send(4, { type: "exit", termination: { kind: "exit", code: 0 } });
  const result = await run;
  await acknowledged;
  expect(new TextDecoder().decode(result.stdout)).toBe("v24.11.0\nrest\n");
  expect(result.ending).toEqual({ kind: "exit", code: 0 });
  expect(acks).toEqual([1, 2, 3].map(sequence => ({ version: PROTOCOL_VERSION, sessionId: 7, type: "output-ack", sequence })));
});

it("kills a probe that passes its deadline, prints too much or is cancelled", async () => {
  for (const [name, deadline, chunk, abort] of [["timeout", 0, 1, false], ["overflow", 60_000, 80 * 1024, false], ["cancelled", 60_000, 1, true]] as const) {
    const channel = new MessageChannel(), controller = new AbortController();
    channel.port1.onmessage = () => {};
    let killed = 0;
    const run = collectRuntimeProbe(channel.port2, 7, () => { killed++; channel.port1.postMessage({ version: PROTOCOL_VERSION, sessionId: 7, sequence: 2, type: "exit", termination: { kind: "signal", signal: 9 } }); }, controller.signal, deadline);
    channel.port1.postMessage({ version: PROTOCOL_VERSION, sessionId: 7, sequence: 1, type: "stdout", data: new Uint8Array(chunk) });
    if (abort) controller.abort();
    const result = await run;
    expect(killed, name).toBe(1);
    // A cancelled probe ends as it ended; the caller reports it cancelled.
    expect(result.ending, name).toEqual(name === "cancelled" ? { kind: "signal", signal: 9 } : name);
  }
});

it("kills a probe whose output cannot be decoded or belongs to another session", async () => {
  for (const data of [null, { version: PROTOCOL_VERSION, sessionId: 8, sequence: 1, type: "stdout", data: new Uint8Array() }]) {
    const channel = new MessageChannel();
    let killed = 0;
    const run = collectRuntimeProbe(channel.port2, 7, () => { killed++; }, new AbortController().signal);
    channel.port2.dispatchEvent(new MessageEvent("message", { data }));
    const result = await run;
    expect(result.ending).toBe("unavailable");
    expect(killed).toBe(1);
    channel.port1.close();
  }
});

it("stops a probe when its port cannot deserialize a message", async () => {
  const channel = new MessageChannel();
  let killed = 0;
  const run = collectRuntimeProbe(channel.port2, 7, () => { killed++; }, new AbortController().signal);
  try {
    channel.port2.dispatchEvent(new MessageEvent("messageerror"));
    expect(killed).toBe(1);
  } finally {
    channel.port2.dispatchEvent(new MessageEvent("message", { data: null }));
    await run;
    channel.port1.close();
  }
});

it("cancels a probe and closes its collector when an output acknowledgement fails", async () => {
  const channel = new MessageChannel(), kill = vi.fn<() => void>();
  const post = vi.spyOn(channel.port2, "postMessage").mockImplementation(() => {
    throw new Error("probe output port failed");
  });
  const run = collectRuntimeProbe(channel.port2, 7, kill, new AbortController().signal);
  try {
    const message = new MessageEvent<unknown>("message", { data: {
      version: PROTOCOL_VERSION, sessionId: 7, sequence: 1,
      type: "stdout", data: new TextEncoder().encode(LINES),
    } });
    expect(() => { channel.port2.onmessage?.call(channel.port2, message); }).not.toThrow();
    expect(kill).toHaveBeenCalledOnce();
    expect(await run).toEqual({ stdout: new Uint8Array(), ending: "unavailable" });
    expect(channel.port2.onmessage).toBeNull();
    expect(channel.port2.onmessageerror).toBeNull();
  } finally {
    post.mockRestore();
    channel.port2.dispatchEvent(new MessageEvent("messageerror"));
    await run;
    channel.port1.close();
  }
});

it("bounds cancellation even when a killed probe never sends an exit", async () => {
  vi.useFakeTimers();
  const channel = new MessageChannel(), controller = new AbortController();
  let settled = false;
  const run = collectRuntimeProbe(channel.port2, 7, () => {}, controller.signal);
  void run.then(() => { settled = true; });
  try {
    controller.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(true);
    expect((await run).ending).toBe("unavailable");
  } finally {
    channel.port2.dispatchEvent(new MessageEvent("message", { data: { version: PROTOCOL_VERSION, sessionId: 7, sequence: 1, type: "exit", termination: { kind: "signal", signal: 9 } } }));
    await run; channel.port1.close(); vi.useRealTimers();
  }
});

it("services new Rust knowledge after a probe settles even when guest execution is idle", async () => {
  let settled = 0;
  const rust = ports([SHA("a") + NVM], () => Promise.resolve({ stdout: new TextEncoder().encode(LINES), ending: { kind: "exit", code: 0 } }));
  const probes = new UserspaceRuntimeProbes({ ...rust.value, settled: () => { settled++; } });
  probes.pump(); await probes.idle();
  expect(settled).toBe(1);
  probes.dispose();
});

it("does not report into a retired runtime after disposal", async () => {
  let release: (() => void) | undefined;
  const rust = ports([SHA("a") + NVM], () => new Promise(resolve => {
    release = () => { resolve({ stdout: new TextEncoder().encode(LINES), ending: { kind: "exit", code: 0 } }); };
  }));
  const probes = new UserspaceRuntimeProbes(rust.value);
  probes.pump(); probes.dispose(); release?.(); await probes.idle();
  expect(rust.reports).toEqual([]);
  probes.resume();
  expect(rust.reports).toEqual([]);
});
