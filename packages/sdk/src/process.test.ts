import { expect, it } from "vitest";
import { adaptProcess, execProcess } from "./process.js";
import { GuestProcessTransport } from "./runtime/guest-process.js";
import { PROTOCOL_VERSION } from "./runtime/protocol.js";
import { VMError } from "./runtime/errors.js";

function guest() {
  const channel = new MessageChannel();
  const signals: string[] = [];
  let sequence = 0;
  const emit = (type: "stdout" | "stderr", data: string) => new Promise<void>(resolve => {
    const packetSequence = ++sequence;
    const ack = (event: MessageEvent<unknown>) => {
      const value = event.data;
      if (typeof value === "object" && value !== null && "sequence" in value && value.sequence === packetSequence) { channel.port2.removeEventListener("message", ack); resolve(); }
    };
    channel.port2.addEventListener("message", ack); channel.port2.start();
    channel.port2.postMessage({ version: PROTOCOL_VERSION, sessionId: 7, sequence: packetSequence, type, data: new TextEncoder().encode(data) });
  });
  const exit = (termination: { kind: "exit"; code: number } | { kind: "signal"; signal: number }) => channel.port2.postMessage({ version: PROTOCOL_VERSION, sessionId: 7, sequence: ++sequence, type: "exit", termination });
  const transport = new GuestProcessTransport(channel.port1, 42, 7, {
    write: data => Promise.resolve(data.length), closeStdin: () => Promise.resolve(),
    signal: name => { signals.push(name); exit({ kind: "signal", signal: 9 }); return Promise.resolve(); },
    signalNamed: (name, scope) => { signals.push(`${name}:${scope}`); exit({ kind: "signal", signal: 9 }); return Promise.resolve(); },
  });
  return { transport, signals, emit, exit, close: () => channel.port2.close() };
}
it("preserves an unnamed real-time signal's exact number", async () => {
  const owner = guest();
  const handle = adaptProcess(owner.transport, false);
  owner.exit({ kind: "signal", signal: 35 });
  expect(await handle.exit).toEqual({ kind: "signaled", signal: null, signalNumber: 35 });
  owner.close();
});
it("makes repeated signals to an exited handle harmless without addressing a reused PID", async () => {
  const owner = guest();
  const handle = adaptProcess(owner.transport, false);
  owner.exit({ kind: "exit", code: 0 });
  await handle.exit;
  await handle.kill();
  await handle.kill("SIGKILL", { scope: "process-group" });
  expect(owner.signals).toEqual([]);
  owner.close();
});
it("drains both pipes and closes stdin before returning", async () => {
  const owner = guest();
  let stdinClosed = false;
  const handle = adaptProcess(owner.transport, false);
  const process = { ...handle, stdin: new WritableStream<Uint8Array>({ close() { stdinClosed = true; } }) };
  const result = execProcess(process, { command: "test", maxOutputBytes: 8 });
  await owner.emit("stdout", "out");
  await owner.emit("stderr", "err");
  owner.exit({ kind: "exit", code: 0 });
  const channelResult = await result;
  expect(new TextDecoder().decode(channelResult.stdout)).toBe("out");
  expect(new TextDecoder().decode(channelResult.stderr)).toBe("err");
  expect(stdinClosed).toBe(true);
  expect(channelResult.exit).toEqual({ kind: "exited", code: 0 });
  owner.close();
});

it("kills and awaits the owned group on output overflow", async () => {
  const owner = guest();
  const process = adaptProcess(owner.transport, false);
  const result = execProcess(process, { command: "test", maxOutputBytes: 2 });
  const rejected = expect(result).rejects.toMatchObject({ code: "QUOTA_EXCEEDED", detail: { maxOutputBytes: 2 } });
  await owner.emit("stdout", "too much");
  await rejected;
  expect(owner.signals).toEqual(["SIGKILL:process-group"]);
  expect(await process.exit).toMatchObject({ kind: "signaled", signalNumber: 9 });
  owner.close();
});

for (const trigger of ["overflow", "abort"] as const) {
  it(`reports ${trigger} cleanup failure without awaiting a nonexistent exit receipt`, async () => {
    const owner = guest();
    const abort = new AbortController();
    const handle = adaptProcess(owner.transport, false);
    const process = { ...handle, kill: () => Promise.reject(new VMError("GUEST_CRASH", "native process owner was lost")) };
    const result = execProcess(process, { command: "test", maxOutputBytes: 2, signal: abort.signal });
    const settled = result.then(() => "unexpected success", (error: unknown) => error);
    if (trigger === "overflow") await owner.emit("stdout", "too much");
    else abort.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const observed = await Promise.race([settled, new Promise<string>(resolve => { timer = setTimeout(() => resolve("missing native exit receipt"), 250); })]);
      expect(observed).toMatchObject({ code: trigger === "overflow" ? "QUOTA_EXCEEDED" : "ABORTED", detail: { cleanupFailed: true, cleanupError: { code: "GUEST_CRASH" } } });
      expect(process.stdout.locked).toBe(false);
      expect(process.stderr.locked).toBe(false);
      expect(process.stdin.locked).toBe(false);
    } finally {
      clearTimeout(timer);
      owner.exit({ kind: "signal", signal: 9 });
      await settled;
      owner.close();
    }
  });
}
