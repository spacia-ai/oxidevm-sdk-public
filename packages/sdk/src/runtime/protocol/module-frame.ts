import { boolean, exactKeys, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import { MODULE_ISOLATION_CAPABILITIES, type ModuleIsolationCapability } from "./module-isolation.js";

/**
 * The module frame's bootstrap (engine ADR 0028), module frame bootstrap version 2. The opener (the application page, or
 * the hosted runtime frame's document) loads the frame from its own origin into an opaque sandbox and posts it one
 * bootstrap: a one-use port and the broker and runner code as Blobs from the opener's own SDK assets. The frame starts
 * the broker as a classic blob: worker; the broker probes itself and a nested runner and answers on the port with
 * `module-ready` and what it found, or `module-failure` naming the capability that failed. The page then hands the port
 * to the Userspace worker (`attach-module-frame`), which speaks module broker protocol 1 on it.
 *
 * Version 2 adds the frame's check of its own policy (`frame-policy`, probe fact `framePolicy`): served without the
 * headers of its `frame.json`, the frame is still opaque and isolated, because the opener's iframe sandbox and the
 * page's isolation see to that, but its content security policy is gone and with it ADR 0029's "the frame allows no
 * network". Under the policy a fetch of a `data:` URL from the document and `importScripts` of one from a runner are
 * refused; a frame where either works refuses modules instead.
 */
export const MODULE_FRAME_BOOTSTRAP_VERSION = 2;
/** Spawn, start, stop and signal notices on the attached port and each process's channel. */
export const MODULE_BROKER_VERSION = 1;

function protocol(message: string): never { throw new VMError("PROTOCOL_ERROR", message); }

export interface ModuleFrameBootstrap {
  readonly version: typeof MODULE_FRAME_BOOTSTRAP_VERSION; readonly type: "module-bootstrap";
  readonly nonce: string; readonly port: MessagePort; readonly broker: Blob; readonly runner: Blob;
}

export function decodeModuleFrameBootstrap(value: unknown): ModuleFrameBootstrap {
  const input = record(value, "module frame bootstrap"); exactKeys(input, ["version", "type", "nonce", "port", "broker", "runner"]);
  const nonce = string(input["nonce"], "module frame nonce"), port = input["port"], broker = input["broker"], runner = input["runner"];
  if (input["version"] !== MODULE_FRAME_BOOTSTRAP_VERSION || input["type"] !== "module-bootstrap" || nonce.length === 0 || nonce.length > 64 || !(port instanceof MessagePort) || !(broker instanceof Blob) || !(runner instanceof Blob)) protocol("Invalid module frame bootstrap");
  return { version: MODULE_FRAME_BOOTSTRAP_VERSION, type: "module-bootstrap", nonce, port, broker, runner };
}

/**
 * What the frame found about itself, its broker and a nested runner. `framePolicy`: the frame's policy holds in a
 * nested runner, which `importScripts` of a `data:` URL shows.
 */
export interface ModuleFrameProbe {
  readonly documentIsolated: boolean; readonly opaqueOrigin: boolean; readonly agentCluster: boolean; readonly framePolicy: boolean;
  readonly brokerIsolated: boolean; readonly sharedMemory: boolean; readonly atomicsWait: boolean; readonly runnerIsolated: boolean; readonly wasm: boolean;
}
const PROBE_KEYS = ["documentIsolated", "opaqueOrigin", "agentCluster", "framePolicy", "brokerIsolated", "sharedMemory", "atomicsWait", "runnerIsolated", "wasm"] as const;

export type ModuleFrameAnswer =
  /** `liveness` is the heartbeat port: the frame's broker answers each `ping` with a `pong` while it lives. */
  | { readonly type: "module-ready"; readonly nonce: string; readonly probe: ModuleFrameProbe; readonly liveness: MessagePort }
  | { readonly type: "module-failure"; readonly nonce: string; readonly capability: ModuleIsolationCapability };

export function decodeModuleFrameAnswer(value: unknown): ModuleFrameAnswer {
  const input = record(value, "module frame answer");
  if (input["version"] !== MODULE_FRAME_BOOTSTRAP_VERSION) protocol("Module frame bootstrap version mismatch");
  const nonce = string(input["nonce"], "module frame nonce");
  if (input["type"] === "module-failure") {
    exactKeys(input, ["version", "type", "nonce", "capability"]);
    const capability = MODULE_ISOLATION_CAPABILITIES.find(known => known === input["capability"]);
    if (capability === undefined) protocol("Unknown module isolation capability");
    return { type: "module-failure", nonce, capability };
  }
  exactKeys(input, ["version", "type", "nonce", "probe", "liveness"]);
  const liveness = input["liveness"];
  if (input["type"] !== "module-ready" || !(liveness instanceof MessagePort)) protocol("Unknown module frame answer");
  const probe = record(input["probe"], "module frame probe"); exactKeys(probe, PROBE_KEYS);
  const fact = (key: (typeof PROBE_KEYS)[number]): boolean => boolean(probe[key], `module frame ${key}`);
  return { type: "module-ready", nonce, liveness, probe: { documentIsolated: fact("documentIsolated"), opaqueOrigin: fact("opaqueOrigin"), agentCluster: fact("agentCluster"), framePolicy: fact("framePolicy"), brokerIsolated: fact("brokerIsolated"), sharedMemory: fact("sharedMemory"), atomicsWait: fact("atomicsWait"), runnerIsolated: fact("runnerIsolated"), wasm: fact("wasm") } };
}

/** The first capability a probe shows missing, in the order the frame needs them; undefined when all hold. */
export function missingCapability(probe: ModuleFrameProbe): ModuleIsolationCapability | undefined {
  if (!probe.documentIsolated) return "frame-cross-origin-isolation";
  if (!probe.opaqueOrigin) return "separate-origin";
  if (!probe.agentCluster) return "separate-agent-cluster";
  if (!probe.framePolicy) return "frame-policy";
  if (!probe.brokerIsolated || !probe.runnerIsolated) return "blob-workers";
  if (!probe.sharedMemory) return "worker-shared-memory";
  if (!probe.atomicsWait) return "worker-atomics-wait";
  if (!probe.wasm) return "wasm-compilation";
  return undefined;
}
