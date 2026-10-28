/** Node's `diagnostics_channel`: named publish/subscribe channels and the
 * tracing channel quintet, with Node's publication order. Channels are kept
 * by name for the process's lifetime. */
type Listener = (message: unknown, name: string | symbol) => void;
type Handlers = Partial<Record<"start" | "end" | "asyncStart" | "asyncEnd" | "error", Listener>>;
type Store = { run(value: unknown, fn: () => unknown): unknown };

export class Channel {
  readonly name: string | symbol;
  readonly #listeners = new Set<Listener>();
  readonly #stores = new Map<Store, ((data: unknown) => unknown) | undefined>();
  constructor(name: string | symbol) { this.name = name; }
  get hasSubscribers(): boolean { return this.#listeners.size > 0 || this.#stores.size > 0; }
  publish(message: unknown): void {
    for (const listener of [...this.#listeners]) {
      try { listener(message, this.name); } catch (error) { queueMicrotask(() => { throw error; }); }
    }
  }
  subscribe(listener: Listener): void { this.#listeners.add(listener); }
  unsubscribe(listener: Listener): boolean { return this.#listeners.delete(listener); }
  bindStore(store: Store, transform?: (data: unknown) => unknown): void { this.#stores.set(store, transform); }
  unbindStore(store: Store): boolean { return this.#stores.delete(store); }
  runStores(data: unknown, fn: (...args: unknown[]) => unknown, thisArg?: unknown, ...args: unknown[]): unknown {
    let run = (): unknown => Reflect.apply(fn, thisArg, args);
    for (const [store, transform] of this.#stores) {
      const inner = run;
      run = () => store.run(transform === undefined ? data : transform(data), inner);
    }
    this.publish(data);
    return run();
  }
}

export class TracingChannel {
  readonly start: Channel; readonly end: Channel; readonly asyncStart: Channel; readonly asyncEnd: Channel; readonly error: Channel;
  constructor(channels: { start: Channel; end: Channel; asyncStart: Channel; asyncEnd: Channel; error: Channel }) {
    this.start = channels.start; this.end = channels.end; this.asyncStart = channels.asyncStart; this.asyncEnd = channels.asyncEnd; this.error = channels.error;
  }
  get hasSubscribers(): boolean {
    return this.start.hasSubscribers || this.end.hasSubscribers || this.asyncStart.hasSubscribers || this.asyncEnd.hasSubscribers || this.error.hasSubscribers;
  }
  subscribe(handlers: Handlers): void {
    for (const name of ["start", "end", "asyncStart", "asyncEnd", "error"] as const) { const handler = handlers[name]; if (handler !== undefined) this[name].subscribe(handler); }
  }
  unsubscribe(handlers: Handlers): boolean {
    let all = true;
    for (const name of ["start", "end", "asyncStart", "asyncEnd", "error"] as const) { const handler = handlers[name]; if (handler !== undefined && !this[name].unsubscribe(handler)) all = false; }
    return all;
  }
  traceSync(fn: (...args: unknown[]) => unknown, context: Record<string, unknown> = {}, thisArg?: unknown, ...args: unknown[]): unknown {
    if (!this.hasSubscribers) return Reflect.apply(fn, thisArg, args);
    this.start.publish(context);
    try {
      const result: unknown = Reflect.apply(fn, thisArg, args);
      context["result"] = result;
      return result;
    } catch (error) {
      context["error"] = error;
      this.error.publish(context);
      throw error;
    } finally { this.end.publish(context); }
  }
  tracePromise(fn: (...args: unknown[]) => unknown, context: Record<string, unknown> = {}, thisArg?: unknown, ...args: unknown[]): Promise<unknown> {
    if (!this.hasSubscribers) return Promise.resolve(Reflect.apply(fn, thisArg, args));
    this.start.publish(context);
    let promise: Promise<unknown>;
    try { promise = Promise.resolve(Reflect.apply(fn, thisArg, args)); }
    catch (error) { context["error"] = error; this.error.publish(context); this.end.publish(context); throw error; }
    this.end.publish(context);
    return promise.then(result => { context["result"] = result; this.asyncStart.publish(context); this.asyncEnd.publish(context); return result; },
      (error: unknown) => { context["error"] = error; this.error.publish(context); this.asyncStart.publish(context); this.asyncEnd.publish(context); throw error; });
  }
  traceCallback(fn: (...args: unknown[]) => unknown, position = -1, context: Record<string, unknown> = {}, thisArg?: unknown, ...args: unknown[]): unknown {
    if (!this.hasSubscribers) return Reflect.apply(fn, thisArg, args);
    const index = position < 0 ? args.length + position : position;
    const callback = args[index];
    if (typeof callback !== "function") throw new TypeError("The callback argument must be a function");
    const { asyncStart, asyncEnd, error: errorChannel } = this;
    args[index] = function wrapped(this: unknown, error: unknown, ...rest: unknown[]): unknown {
      if (error !== undefined && error !== null) { context["error"] = error; errorChannel.publish(context); }
      else context["result"] = rest[0];
      asyncStart.publish(context);
      try { const result: unknown = Reflect.apply(callback, this, [error, ...rest]); return result; } finally { asyncEnd.publish(context); }
    };
    return this.traceSync(fn, context, thisArg, ...args);
  }
}

export function createNodeDiagnosticsChannel() {
  const channels = new Map<string | symbol, Channel>();
  const channel = (name: string | symbol): Channel => {
    const existing = channels.get(name);
    if (existing !== undefined) return existing;
    const created = new Channel(name);
    channels.set(name, created);
    return created;
  };
  const tracingChannel = (nameOrChannels: string | { start: Channel; end: Channel; asyncStart: Channel; asyncEnd: Channel; error: Channel }): TracingChannel =>
    typeof nameOrChannels === "string"
      ? new TracingChannel({ start: channel(`tracing:${nameOrChannels}:start`), end: channel(`tracing:${nameOrChannels}:end`),
        asyncStart: channel(`tracing:${nameOrChannels}:asyncStart`), asyncEnd: channel(`tracing:${nameOrChannels}:asyncEnd`), error: channel(`tracing:${nameOrChannels}:error`) })
      : new TracingChannel(nameOrChannels);
  return Object.freeze({
    Channel, TracingChannel, channel, tracingChannel,
    hasSubscribers: (name: string | symbol): boolean => channels.get(name)?.hasSubscribers === true,
    subscribe: (name: string | symbol, listener: Listener): void => { channel(name).subscribe(listener); },
    unsubscribe: (name: string | symbol, listener: Listener): boolean => channels.get(name)?.unsubscribe(listener) === true,
  });
}
