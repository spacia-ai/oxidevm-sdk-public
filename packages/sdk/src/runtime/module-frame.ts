import { VMError } from "./errors.js";
import { openExecutionFrame } from "./execution-frame.js";
import type { ModuleFrameSources } from "../module-execution.js";
import { decodeModuleFrameAnswer, isolationUnavailable, missingCapability, MODULE_FRAME_BOOTSTRAP_VERSION, type ModuleFrameProbe } from "./protocol/module-frame.js";

/**
 * Opens one module frame (engine ADR 0028): an `<iframe sandbox="allow-scripts" allow="cross-origin-isolated">` whose
 * document comes from the opener's own origin, so the sandbox makes it opaque. The opener (the application page, or the
 * hosted runtime frame's document) hands it the broker and runner code as Blobs from its own SDK assets; the frame
 * starts the broker and answers with what its probe found. A browser that cannot isolate module workers gets
 * FEATURE_NOT_AVAILABLE `wasm-module-isolation-unavailable` with the closed `capability` that failed, never a fallback.
 */


export interface OpenModuleFrame {
  /** The broker's port (module broker protocol 1), for the VM's Userspace worker. */
  readonly port: MessagePort;
  readonly frame: HTMLIFrameElement;
  readonly probe: ModuleFrameProbe;
  /** The heartbeat port: the frame's broker answers each `ping` with a `pong` while it lives. */
  readonly liveness: MessagePort;
  dispose(): void;
}

export async function openModuleFrame(url: URL, sources: ModuleFrameSources, signal?: AbortSignal): Promise<OpenModuleFrame> {
  let opened;
  try {
    opened = await openExecutionFrame(url, (port, nonce) => ({ version: MODULE_FRAME_BOOTSTRAP_VERSION, type: "module-bootstrap", nonce, port, broker: sources.broker, runner: sources.runner }), (input, nonce) => {
      const answer = decodeModuleFrameAnswer(input);
      if (answer.nonce !== nonce) throw new VMError("PROTOCOL_ERROR", "Module frame binding mismatch");
      if (answer.type === "module-failure") throw isolationUnavailable(answer.capability, `This browser cannot isolate WebAssembly modules (${answer.capability})`);
      const missing = missingCapability(answer.probe);
      if (missing !== undefined) throw isolationUnavailable(missing, `This browser cannot isolate WebAssembly modules (${missing})`);
      return answer;
    }, signal, "opaque");
  } catch (error: unknown) {
    // A frame that never loads or answers (Firefox blocks one whose CORP its opaque origin fails) is a capability too.
    if (error instanceof VMError && error.code === "CORE_LOAD_FAILED") throw isolationUnavailable("frame-load", "The module frame did not load");
    throw error;
  }
  const { liveness } = opened.receipt;
  return { port: opened.port, frame: opened.frame, probe: opened.receipt.probe, liveness, dispose: () => { liveness.close(); opened.dispose(); } };
}
