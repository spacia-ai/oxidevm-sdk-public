import type Emitter from "events/";
import type { NodeAsyncHooks, NodeAsyncResource } from "./node-async-hooks.js";
import { unavailableNodeApi } from "./node-capability.js";

export interface NodeEventEmitterAsyncResource extends Emitter {
  emitDestroy(): void;
  readonly asyncId: number;
  readonly triggerAsyncId: number;
  readonly asyncResource: NodeAsyncResource & { readonly eventEmitter: Emitter };
}

/** Event dispatch uses the same captured scope and lifetime as AsyncResource. */
export function createEventEmitterAsyncResource(EventEmitter: typeof Emitter, hooks: NodeAsyncHooks): new (options?: unknown) => NodeEventEmitterAsyncResource {
  class EmitterResource extends hooks.AsyncResource {
    readonly #emitter: Emitter;
    constructor(emitter: Emitter, name: unknown, options: unknown) {
      super(name, options);
      this.#emitter = emitter;
    }
    get eventEmitter(): Emitter { return this.#emitter; }
  }

  return class EventEmitterAsyncResource extends EventEmitter {
    readonly #resource: EmitterResource;
    constructor(options?: unknown) {
      const record = typeof options === "object" && options !== null || typeof options === "function" ? options : undefined;
      const name: unknown = record === undefined ? undefined : Reflect.get(record, "name");
      if (typeof options !== "string" && new.target === EventEmitterAsyncResource && typeof name !== "string") {
        throw Object.assign(new TypeError("The \"options.name\" property must be of type string"), { code: "ERR_INVALID_ARG_TYPE" });
      }
      const capture: unknown = record === undefined ? undefined : Reflect.get(record, "captureRejections");
      if (capture !== undefined && typeof capture !== "boolean") {
        throw Object.assign(new TypeError("The \"options.captureRejections\" property must be of type boolean"), { code: "ERR_INVALID_ARG_TYPE" });
      }
      // shortcut: the pinned base emitter lacks rejection capture; reject it until its shared owner supports it.
      if (capture === true) unavailableNodeApi("events.EventEmitterAsyncResource captureRejections");
      super();
      const hasName = Boolean(name);
      const resourceName: unknown = typeof options === "string" ? options : hasName ? name : new.target.name;
      this.#resource = new EmitterResource(this, resourceName, typeof options === "string" ? undefined : options);
    }
    override emit(event: string | symbol, ...args: unknown[]): boolean {
      return this.#resource.runInAsyncScope(() => super.emit(event, ...args)) === true;
    }
    emitDestroy(): void { this.#resource.emitDestroy(); }
    get asyncId(): number { return this.#resource.asyncId(); }
    get triggerAsyncId(): number { return this.#resource.triggerAsyncId(); }
    get asyncResource(): EmitterResource { return this.#resource; }
  };
}
