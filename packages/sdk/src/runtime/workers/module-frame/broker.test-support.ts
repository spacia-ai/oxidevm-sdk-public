import { expect, vi } from "vitest";
import { JS_PROCESS_PROTOCOL_VERSION } from "../../js-process/codec.js";
import { MODULE_BROKER_VERSION } from "../../protocol/module-frame.js";
import { ModuleBroker, type RunnerWorker } from "./broker.js";

// The module broker's test double side (engine ADR 0028): fake runners, and the Userspace worker's ends of each
// process's channel, service port and attention port.

export const WASM = Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0);
export const KEY = `${"a".repeat(64)}:8`;
export const launch = () => ({ kind: "host", descriptor: "{\"v\":1}", adapter: new Blob(["export default () => ({ main: () => 0 });"]), artifacts: { "tool.wasm": { blob: new Blob([WASM]), module: null } }, tls: null });

/** A runner the broker starts: the test sees its start message and plays the module's side of its ports. */
export class FakeRunner implements RunnerWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null;
  readonly started = Promise.withResolvers<Readonly<Record<string, unknown>>>();
  terminated = false;
  postMessage(message: unknown): void { if (typeof message === "object" && message !== null) this.started.resolve(Object.fromEntries(Object.entries(message))); }
  terminate(): void { this.terminated = true; }
}

export const next = (port: MessagePort): Promise<unknown> => new Promise(resolve => { port.addEventListener("message", event => { resolve(event.data); }, { once: true }); port.start(); });

/** One module process through a broker: the Userspace worker's ends of its channel and service port, and its runner. */
export async function spawn(broker: MessagePort, runners: FakeRunner[], pid = 7) {
  const channel = new MessageChannel(), service = new MessageChannel(), notices = new MessageChannel();
  broker.postMessage({ version: MODULE_BROKER_VERSION, type: "spawn", pid, port: channel.port2 }, [channel.port2]);
  const created = runners.length;
  channel.port1.postMessage({ version: MODULE_BROKER_VERSION, type: "start", value: { version: JS_PROCESS_PROTOCOL_VERSION, type: "start", launch: launch(), keys: { "tool.wasm": KEY }, tls: null, reach: 0 }, port: service.port2, attention: notices.port2 }, [service.port2, notices.port2]);
  await vi.waitFor(() => { expect(runners.length).toBe(created + 1); }, { interval: 2 });
  const runner = runners.at(-1);
  if (runner === undefined) throw new Error("no runner");
  const start = await runner.started.promise, port = start["port"], mailbox = start["mailbox"], signals = start["signals"];
  if (!(port instanceof MessagePort) || !(mailbox instanceof SharedArrayBuffer) || !(signals instanceof SharedArrayBuffer)) throw new Error("bad start");
  return { channel: channel.port1, service: service.port1, notices: notices.port1, runner, start, port, mailbox, header: new Int32Array(mailbox, 0, 4), words: new Int32Array(signals) };
}

export function brokerWith(compile = vi.fn((bytes: ArrayBuffer) => WebAssembly.compile(bytes))) {
  const runners: FakeRunner[] = [], attached = new MessageChannel();
  new ModuleBroker({ startRunner: () => { const runner = new FakeRunner(); runners.push(runner); return runner; }, compile }).attach(attached.port2);
  return { port: attached.port1, runners, compile };
}

export const request = (sequence: number, sync: boolean) => ({ version: JS_PROCESS_PROTOCOL_VERSION, type: "request", sequence, sync, operation: 1, payload: Uint8Array.of(sequence) });
export const reply = (sequence: number) => ({ version: JS_PROCESS_PROTOCOL_VERSION, type: "reply", sequence, errno: 0, value: 5n, payload: new Uint8Array() });
