/// <reference lib="webworker" />
import { exactKeys, record } from "../../decode.js";
import { VMError } from "../../errors.js";
import { NESTED_FRAME_PROBE } from "../../module-frame-policy.js";
import { MODULE_FRAME_BOOTSTRAP_VERSION } from "../../protocol/module-frame.js";
import { ModuleBroker, serveBrokerControl } from "./broker.js";

// The module frame's broker (engine ADR 0028). The frame's bootstrap starts it as a classic blob: worker, because
// Chromium refuses module-type blob: workers in an opaque origin; scripts/build-module-frame.ts bundles it as one
// classic script. It probes itself and a nested blob: worker (isolation, WebAssembly and the frame's policy), reports to the frame document, and then serves the port
// the document hands it (module broker protocol 1) and answers the page's heartbeat itself. Runners are nested classic blob: workers of the runner Blob.

const NESTED_PROBE_MS = 10_000;

interface BrokerProbe { readonly brokerIsolated: boolean; readonly sharedMemory: boolean; readonly atomicsWait: boolean; readonly runnerIsolated: boolean; readonly wasm: boolean; readonly runnerPolicy: boolean }
interface NestedProbe { readonly isolated: boolean; readonly wasm: boolean; readonly policy: boolean }
const NOTHING: NestedProbe = { isolated: false, wasm: false, policy: false };

function timedWait(): boolean {
  try { return Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1) === "timed-out"; } catch { return false; }
}

async function nested(): Promise<NestedProbe> {
  const url = URL.createObjectURL(new Blob([NESTED_FRAME_PROBE], { type: "text/javascript" }));
  let worker: Worker | undefined;
  try {
    worker = new Worker(url, { name: "oxidevm-module-probe" });
    const started = worker, answer = Promise.withResolvers<NestedProbe>();
    const timer = setTimeout(() => { answer.resolve(NOTHING); }, NESTED_PROBE_MS);
    started.onmessage = (event: MessageEvent<unknown>) => {
      const facts = typeof event.data === "object" && event.data !== null ? event.data : {};
      answer.resolve({ isolated: Reflect.get(facts, "isolated") === true, wasm: Reflect.get(facts, "wasm") === true, policy: Reflect.get(facts, "policy") === true });
    };
    started.onerror = (event: ErrorEvent) => { event.preventDefault(); answer.resolve(NOTHING); };
    try { return await answer.promise; } finally { clearTimeout(timer); }
  } catch { return NOTHING; }
  finally { worker?.terminate(); URL.revokeObjectURL(url); }
}

async function probe(): Promise<BrokerProbe> {
  const sharedMemory = typeof SharedArrayBuffer === "function", runner = await nested();
  return { brokerIsolated: self.crossOriginIsolated, sharedMemory, atomicsWait: sharedMemory && timedWait(), runnerIsolated: runner.isolated, wasm: runner.wasm, runnerPolicy: runner.policy };
}

let initialized = false;
self.onmessage = (event: MessageEvent<unknown>) => {
  if (initialized) return;
  initialized = true;
  const init = record(event.data, "module broker bootstrap"); exactKeys(init, ["version", "type", "port", "runner"]);
  const control = init["port"], runner = init["runner"];
  if (init["version"] !== MODULE_FRAME_BOOTSTRAP_VERSION || init["type"] !== "broker-init" || !(control instanceof MessagePort) || !(runner instanceof Blob)) throw new VMError("PROTOCOL_ERROR", "Invalid module broker bootstrap");
  const runnerUrl = URL.createObjectURL(runner.type === "text/javascript" ? runner : new Blob([runner], { type: "text/javascript" }));
  const broker = new ModuleBroker({ startRunner: pid => new Worker(runnerUrl, { name: `oxidevm-module-${String(pid)}` }) });
  serveBrokerControl(control, broker);
  void probe().then(facts => { control.postMessage({ version: MODULE_FRAME_BOOTSTRAP_VERSION, type: "broker-probe", probe: facts }); });
};
