import { protocol } from "../../js-process/codec.js";
import { NapiFailure } from "./errors.js";
import { nativeMapSize } from "./collection-size.js";

const BigInt = globalThis.BigInt, Set = globalThis.Set;

interface TransportScope { readonly handles: Set<bigint>; readonly public: bigint[] }
interface PublicScope {
  readonly transport: bigint;
  readonly environment: bigint;
  readonly escapable: boolean;
  readonly handles: Set<bigint>;
  escaped: boolean;
}
const publicTag = 0x8000_0000_0000_0000n;
const apply = Reflect.apply;
const stack: bigint[] = [], stackAt = Reflect.get(stack, "at"), stackPush = Reflect.get(stack, "push"), stackPop = Reflect.get(stack, "pop");
const values = new Map<bigint, unknown>(), transports = new Map<bigint, TransportScope>(), scopes = new Map<bigint, PublicScope>();
const valueGet = Reflect.get(values, "get"), valueSet = Reflect.get(values, "set"), valueHas = Reflect.get(values, "has"), valueDelete = Reflect.get(values, "delete"), clear = Reflect.get(values, "clear");
const transportGet = Reflect.get(transports, "get"), transportSet = Reflect.get(transports, "set"), transportHas = Reflect.get(transports, "has"), transportDelete = Reflect.get(transports, "delete");
const scopeGet = Reflect.get(scopes, "get"), scopeSet = Reflect.get(scopes, "set"), scopeDelete = Reflect.get(scopes, "delete");
const handles = new Set<bigint>(), handleAdd = Reflect.get(handles, "add"), handleIterator = Reflect.get(handles, Symbol.iterator);
const handleNext = Reflect.get(apply(handleIterator, handles, []), "next");

/** One authority for value identity and transport/public handle lifetimes. */
export class NativeHandles {
  readonly #values = new Map<bigint, unknown>();
  readonly #transports = new Map<bigint, TransportScope>();
  readonly #public = new Map<bigint, PublicScope>();
  #current = 0n;
  #nextValue = 0;
  #nextScope = 0;
  constructor(readonly prefix: bigint) { apply(transportSet, this.#transports, [0n, { handles: new Set<bigint>(), public: [] }]); }
  get currentTransport(): bigint { return this.#current; }

  createTransport(identity: bigint): void {
    if (identity <= 0n || identity > 0x1_ffff_ffffn || apply(transportHas, this.#transports, [identity]) || nativeMapSize(this.#transports) >= 193) protocol("Invalid or exhausted native handle scope");
    apply(transportSet, this.#transports, [identity, { handles: new Set<bigint>(), public: [] }]);
  }
  retireTransport(identity: bigint): void {
    const scope = apply(transportGet, this.#transports, [identity]);
    if (identity === 0n || identity === this.#current || scope === undefined) protocol("Invalid native scope retirement");
    const leaked = scope.public.length !== 0;
    for (const child of scope.public) {
      const entry = apply(scopeGet, this.#public, [child]); if (entry === undefined) protocol("Missing public scope");
      this.#retireHandles(entry.handles); apply(scopeDelete, this.#public, [child]);
    }
    this.#retireHandles(scope.handles); apply(transportDelete, this.#transports, [identity]);
    if (leaked) protocol("Native callback returned with an open public scope");
  }
  withTransport<T>(identity: bigint, action: () => T): T {
    if (!apply(transportHas, this.#transports, [identity])) protocol("Unknown or retired native handle scope");
    const previous = this.#current; this.#current = identity;
    try { return action(); } finally { this.#current = previous; }
  }
  #transport(): TransportScope {
    const scope = apply(transportGet, this.#transports, [this.#current]); if (scope === undefined) protocol("Missing native value scope"); return scope;
  }
  #retireHandles(handles: ReadonlySet<bigint>): void {
    const iterator = apply(handleIterator, handles, []);
    for (let step = apply(handleNext, iterator, []); step.done !== true; step = apply(handleNext, iterator, [])) apply(valueDelete, this.#values, [step.value]);
  }
  #add(value: unknown, handles: Set<bigint>): bigint {
    if (nativeMapSize(this.#values) >= 65536 || this.#nextValue >= 0xffff_ffff) protocol("Native value handle limit");
    const handle = this.prefix | BigInt(++this.#nextValue); apply(valueSet, this.#values, [handle, value]); apply(handleAdd, handles, [handle]); return handle;
  }
  add(value: unknown): bigint {
    const transport = this.#transport(), active = apply(stackAt, transport.public, [-1]);
    if (active === undefined) return this.#add(value, transport.handles);
    const scope = apply(scopeGet, this.#public, [active]); if (scope === undefined) protocol("Missing public scope");
    return this.#add(value, scope.handles);
  }
  get(handle: bigint): unknown { if (!apply(valueHas, this.#values, [handle])) protocol("Invalid or stale native value handle"); return apply(valueGet, this.#values, [handle]); }
  open(environment: bigint, escapable: boolean): bigint {
    if (nativeMapSize(this.#public) >= 4096 || this.#nextScope === 0xffff_ffff) throw new NapiFailure(9);
    const transport = this.#transport(), identity = publicTag | this.prefix | BigInt(++this.#nextScope);
    apply(scopeSet, this.#public, [identity, { transport: this.#current, environment, escapable, handles: new Set<bigint>(), escaped: false }]);
    apply(stackPush, transport.public, [identity]); return identity;
  }
  #scope(identity: bigint, environment: bigint): PublicScope {
    const scope = apply(scopeGet, this.#public, [identity]);
    if ((identity & 0xffff_ffff_0000_0000n) !== (publicTag | this.prefix) || scope === undefined || scope.transport !== this.#current || scope.environment !== environment) protocol("Foreign or stale native public scope");
    return scope;
  }
  close(identity: bigint, environment: bigint, escapable: boolean): void {
    const scope = this.#scope(identity, environment), transport = this.#transport();
    if (scope.escapable !== escapable || apply(stackAt, transport.public, [-1]) !== identity) throw new NapiFailure(13);
    this.#retireHandles(scope.handles); apply(scopeDelete, this.#public, [identity]); apply(stackPop, transport.public, []);
  }
  escape(identity: bigint, environment: bigint, handle: bigint): bigint {
    const scope = this.#scope(identity, environment), transport = this.#transport();
    if (!scope.escapable || apply(stackAt, transport.public, [-1]) !== identity) throw new NapiFailure(13);
    if (scope.escaped) throw new NapiFailure(12);
    const parentId = apply(stackAt, transport.public, [-2]), parent = parentId === undefined ? transport.handles : apply(scopeGet, this.#public, [parentId])?.handles;
    if (parent === undefined) protocol("Missing native parent scope");
    const escaped = this.#add(this.get(handle), parent); scope.escaped = true; return escaped;
  }
  dispose(): void { apply(clear, this.#values, []); apply(clear, this.#public, []); apply(clear, this.#transports, []); }
}
