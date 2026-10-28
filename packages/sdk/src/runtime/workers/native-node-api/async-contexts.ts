import type { AsyncContext } from "../assistance/async-context.js";
import type { AsyncScope } from "../assistance/async-resources.js";
import { protocol } from "../../js-process/codec.js";
import { NapiFailure } from "./errors.js";
import { nativeMapSize } from "./collection-size.js";

interface Context {
  readonly environment: bigint;
  readonly scope: AsyncScope;
  readonly run: ReturnType<AsyncContext["capture"]>;
  readonly retainedResource?: object;
}
interface CallbackScope {
  readonly identity: bigint;
  readonly environment: bigint;
  readonly transport: bigint;
  readonly close: ReturnType<AsyncScope["enter"]>;
  readonly restore: () => void;
}
const Map = globalThis.Map, BigInt = globalThis.BigInt, apply = Reflect.apply;
const contexts = new Map<bigint, Context>(), scopeStack: CallbackScope[] = [];
const contextGet = Reflect.get(contexts, "get"), contextSet = Reflect.get(contexts, "set"), contextDelete = Reflect.get(contexts, "delete"), contextClear = Reflect.get(contexts, "clear"), contextValues = Reflect.get(contexts, "values");
const contextNext = Reflect.get(apply(contextValues, contexts, []), "next");
const scopePush = Reflect.get(scopeStack, "push"), scopePop = Reflect.get(scopeStack, "pop"), scopeAt = Reflect.get(scopeStack, "at"), scopeFindIndex = Reflect.get(scopeStack, "findIndex");

/** Native handles own lifetimes; the shared JS owners own async IDs, hooks and storage. */
export class NativeAsyncContexts {
  readonly #contexts = new Map<bigint, Context>();
  readonly #scopes: CallbackScope[] = [];
  #next = 0;
  constructor(readonly prefix: bigint, readonly context: AsyncContext) {}

  #identity(): bigint {
    if (this.#next === 0xffff_ffff) throw new NapiFailure(9);
    return this.prefix | BigInt(++this.#next);
  }
  #get(identity: bigint, environment: bigint): Context {
    const entry = apply(contextGet, this.#contexts, [identity]);
    if (entry === undefined || entry.environment !== environment) throw new NapiFailure(1);
    return entry;
  }
  create(environment: bigint, externalResource: object | undefined, name: string, retention: "weak" | "strong" = "weak"): bigint {
    if (nativeMapSize(this.#contexts) >= 4096) throw new NapiFailure(9);
    const identity = this.#identity(), resource = externalResource ?? {}, run = this.context.capture();
    let initialized: AsyncScope | undefined;
    try {
      this.context.resources.create(name, resource, undefined, true, scope => {
        initialized = scope;
        apply(contextSet, this.#contexts, [identity, { environment, scope, run, ...(retention === "strong" || externalResource === undefined ? { retainedResource: resource } : {}) }]);
      });
      return identity;
    } catch (error) {
      apply(contextDelete, this.#contexts, [identity]); initialized?.destroy(); throw error;
    }
  }
  destroy(environment: bigint, identity: bigint): void {
    const entry = this.#get(identity, environment);
    apply(contextDelete, this.#contexts, [identity]); entry.scope.destroy();
  }
  make<Result>(environment: bigint, identity: bigint, receiver: object, callback: () => Result): Result {
    if (identity === 0n) {
      const restore = this.context.clear();
      try { return this.context.resources.runUntracked(receiver, callback); } finally { restore(); }
    }
    const entry = this.#get(identity, environment);
    return entry.run(() => {
      const close = entry.scope.enter(); let outcome: "returned" | "threw" = "threw";
      try { const result = callback(); outcome = "returned"; return result; } finally { close(outcome); }
    });
  }
  open(environment: bigint, identity: bigint, transport: bigint): bigint {
    const entry = this.#get(identity, environment);
    if (this.#scopes.length >= 4096) throw new NapiFailure(9);
    const scope = this.#identity(), restore = this.context.clear();
    try {
      apply(scopePush, this.#scopes, [{ identity: scope, environment, transport, restore, close: entry.scope.enter() }]);
      return scope;
    } catch (error) { restore(); throw error; }
  }
  #close(outcome: "returned" | "threw"): void {
    const entry = apply(scopePop, this.#scopes, []); if (entry === undefined) protocol("Missing native callback scope");
    try { entry.close(outcome); } finally { entry.restore(); }
  }
  close(environment: bigint, identity: bigint, transport: bigint): void {
    const entry = apply(scopeAt, this.#scopes, [-1]);
    if (entry === undefined || entry.identity !== identity || entry.environment !== environment || entry.transport !== transport) throw new NapiFailure(14);
    this.#close("returned");
  }
  retireTransport(transport: bigint): void {
    const leaked = apply(scopeFindIndex, this.#scopes, [(scope: CallbackScope) => scope.transport === transport]);
    if (leaked < 0) return;
    while (this.#scopes.length > leaked) this.#close("threw");
    protocol("Native callback returned with an open callback scope");
  }
  dispose(): void {
    while (this.#scopes.length > 0) this.#close("threw");
    const iterator = apply(contextValues, this.#contexts, []);
    for (let step = apply(contextNext, iterator, []); step.done !== true; step = apply(contextNext, iterator, [])) step.value.scope.destroy();
    apply(contextClear, this.#contexts, []);
  }
}
