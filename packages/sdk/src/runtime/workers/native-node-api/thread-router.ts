import { exactKeys, record } from "../../decode.js";
import { VMError } from "../../errors.js";
import { decodeJSIdentity, protocol, type JSProcessIdentity } from "../../js-process/codec.js";
import type { NativeProcessContext } from "../../userspace-command-abi.js";
import { NATIVE_TASK_CONTROL_VERSION, decodeThreadMetadata, type NativeThreadMetadata } from "./thread-metadata.js";

interface Route { readonly identity: JSProcessIdentity; readonly parent: bigint | null; readonly kind: NativeProcessContext["kind"]; readonly port: MessagePort; readonly begin: (metadata: NativeThreadMetadata | null) => void; disconnect?: () => void }
interface Waiting { readonly parent: bigint; readonly metadata: NativeThreadMetadata }
const key = (identity: JSProcessIdentity) => `${String(identity.generation)}:${String(identity.id)}`;

/** Only data and private ports pass here. Rust supplies every admitted environment identity. */
export class NativeThreadRouter {
  readonly #routes = new Map<string, Route>();
  readonly #waiting = new Map<string, Waiting>();
  attach(identity: JSProcessIdentity, context: NativeProcessContext, begin: (port: MessagePort, metadata: NativeThreadMetadata | null) => void, failed: (error: unknown) => void) {
    const token = key(identity); if (this.#routes.has(token) || this.#routes.size >= 32) protocol("Duplicate or exhausted native environment route");
    if (context.kind !== "main" && !this.#routes.has(key(decodeJSIdentity(identity.generation, context.parent)))) protocol("Native environment parent has retired");
    const channel = new MessageChannel(); let started = false;
    const route: Route = { identity, kind: context.kind, parent: context.kind === "main" ? null : context.parent, port: channel.port1, begin: metadata => {
      if (started) { metadata?.port.close(); protocol("Native environment has already started"); }
      started = true;
      if (context.kind === "fork") {
        if (metadata === null) protocol("Native fork IPC is absent");
        const ipc = new MessageChannel(), parent = metadata.port;
        let open = true;
        parent.onmessage = event => { if (open) ipc.port1.postMessage(event.data); };
        ipc.port1.onmessage = event => { if (open) parent.postMessage(event.data); };
        parent.onmessageerror = failed; ipc.port1.onmessageerror = failed; parent.start(); ipc.port1.start();
        route.disconnect = () => { if (!open) return; open = false; parent.postMessage({ disconnect: true }); ipc.port1.postMessage({ disconnect: true }); parent.close(); ipc.port1.close(); };
        begin(channel.port2, { ...metadata, port: ipc.port2 });
      } else begin(channel.port2, metadata);
    } };
    if (context.kind === "fork") route.disconnect = () => { failed(new VMError("VM_FAULT", "Native fork parent retired before IPC bootstrap")); };
    this.#routes.set(token, route);
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      try {
        const message = record(event.data, "native environment routing"); exactKeys(message, ["version", "type", "child", "metadata"]);
        if (message["version"] !== NATIVE_TASK_CONTROL_VERSION || message["type"] !== "prepare") protocol("Unknown native environment routing operation");
        const child = decodeJSIdentity(identity.generation, message["child"]), childKey = key(child), metadata = decodeThreadMetadata(message["metadata"]);
        if (this.#waiting.has(childKey) || this.#waiting.size >= 32) protocol("Duplicate or exhausted native worker metadata");
        const target = this.#routes.get(childKey);
        if (target !== undefined) { if (target.parent !== identity.id) protocol("Native worker parent mismatch"); target.begin(metadata); }
        else this.#waiting.set(childKey, { parent: identity.id, metadata });
      } catch (error) { failed(error); }
    }; channel.port1.onmessageerror = failed; channel.port1.start();
    if (context.kind === "main") route.begin(null);
    else {
      const waiting = this.#waiting.get(token);
      if (waiting !== undefined) { this.#waiting.delete(token); if (waiting.parent !== context.parent) protocol("Native worker metadata parent mismatch"); route.begin(waiting.metadata); }
    }
    return {
      online: () => this.#event(route, "online"),
      error: (error: unknown) => this.#event(route, "error", error),
      exception: (error: unknown) => this.#event(route, "exception", error),
      dispose: () => {
        if (!this.#routes.delete(token)) return;
        route.disconnect?.();
        for (const child of this.#routes.values()) if (child.parent === identity.id) child.disconnect?.();
        this.#event(route, "closed"); channel.port1.close(); channel.port2.close();
        for (const [childKey, waiting] of this.#waiting) if (waiting.parent === identity.id) { waiting.metadata.port.close(); this.#waiting.delete(childKey); }
      },
    };
  }
  #event(route: Route, type: "online" | "error" | "exception" | "closed", error?: unknown): void {
    if (route.parent === null || route.kind !== "thread") return;
    const parent = this.#routes.get(key(decodeJSIdentity(route.identity.generation, route.parent)));
    parent?.port.postMessage({ version: NATIVE_TASK_CONTROL_VERSION, type, child: route.identity.id, ...(type === "error" || type === "exception" ? { error } : {}) });
  }
}
