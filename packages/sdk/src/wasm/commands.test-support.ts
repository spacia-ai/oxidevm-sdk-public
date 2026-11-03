import { decodeSerializedError, deserializeError, serializeUnknownError, VMError } from "../runtime/errors.js";
import { PROTOCOL_VERSION } from "../runtime/protocol/common.js";
import { decodeModuleCommandsResult, type ModuleCommandsRequest, type ModuleCommandsResult } from "../runtime/protocol/userspace-module-commands.js";
import { decodeUserspaceRequest } from "../runtime/userspace-protocol.js";
import type { ModuleCommands as Registrations } from "../runtime/workers/js-process/module-commands.js";
import type { ModuleCopies } from "../runtime/workers/js-process/module-copies.js";
import { decodeMissingKeys } from "../runtime/protocol/userspace-module-files.js";
import type { OwnedModuleCommands } from "../vm-adapter.js";
import type { LaunchPins } from "./handle.js";
import type { Release } from "./runner/fixtures.test-support.js";

/** The pins `oxidevm wasm stage` generates for a release's handle. */
export function pinsOf(release: Release): LaunchPins {
  return { release: release.descriptor.release, adapter: release.descriptor.adapter, artifacts: release.descriptor.artifacts };
}

/**
 * A VM's module commands as `vm-adapter` hands them to `enableModuleCommands`, connected to a real registration owner
 * the way the Userspace backend, the control worker and the Userspace worker connect them: each request is decoded as
 * the worker decodes it and each answer as the page decodes it, an error crosses as a serialized VMError, and a
 * cancellation reaches the owner while the page waits for its answer (`cancellation: "settled"`). `hold` keeps the next
 * requests from reaching the owner until it settles; `dispose` ends the VM, failing requests that are still on their way.
 */
export function relay(registrations: Registrations, copies: ModuleCopies) {
  const lifetime = new AbortController(), requests: ModuleCommandsRequest[] = [], answers: ModuleCommandsResult[] = [];
  const ended = new Promise<never>((_resolve, reject) => { lifetime.signal.addEventListener("abort", () => { reject(new VMError("ABORTED", "worker was disposed")); }, { once: true }); });
  ended.catch(() => undefined);
  const state: { hold: Promise<unknown>; id: number } = { hold: Promise.resolve(), id: 0 };
  const forward = async (sent: ModuleCommandsRequest, signal: AbortSignal | undefined): Promise<ModuleCommandsResult> => {
    const decoded = decodeUserspaceRequest(structuredClone({ id: ++state.id, version: PROTOCOL_VERSION, type: "module-commands", ...sent }));
    if (decoded.type !== "module-commands") throw new Error("Expected a module-commands request");
    requests.push(sent);
    await state.hold;
    // The worker sees the page's cancellation once it arrives, whether before or after its owner started.
    const cancellation = new AbortController(), cancel = () => { cancellation.abort(); };
    if (signal?.aborted === true) cancel();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const answer = decodeModuleCommandsResult(structuredClone(await registrations.request(decoded, cancellation.signal)));
      answers.push(answer);
      return answer;
    } catch (error: unknown) {
      throw deserializeError(decodeSerializedError(structuredClone(serializeUnknownError(error))));
    } finally { signal?.removeEventListener("abort", cancel); }
  };
  const owned: OwnedModuleCommands = {
    request: async (sent, signal) => {
      if (lifetime.signal.aborted) throw new VMError("PROTOCOL_ERROR", "VM has been disposed");
      // The worker client refuses a request whose signal already aborted, before anything is sent.
      if (signal?.aborted === true) throw new VMError("ABORTED", "operation was aborted");
      return Promise.race([forward(sent, signal), ended]);
    },
    disposed: lifetime.signal,
    // The store's answer, decoded as the page decodes a module-files result.
    missing: pins => {
      if (lifetime.signal.aborted) return Promise.reject(new VMError("PROTOCOL_ERROR", "VM has been disposed"));
      const decoded = decodeUserspaceRequest(structuredClone({ id: ++state.id, version: PROTOCOL_VERSION, type: "module-files", pins }));
      if (decoded.type !== "module-files") throw new Error("Expected a module-files request");
      return Promise.resolve(decodeMissingKeys(structuredClone({ missing: copies.missing(decoded.pins) })).missing);
    },
  };
  return {
    owned, requests, answers,
    hold(gate: Promise<unknown>): void { state.hold = gate; },
    /** The VM goes away: its worker drops every registration. */
    dispose(): void { lifetime.abort(); registrations.dispose(); },
  };
}
