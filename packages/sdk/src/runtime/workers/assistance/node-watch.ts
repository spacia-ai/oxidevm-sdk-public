import { Buffer } from "buffer";
import { exactKeys, record } from "../../decode.js";
import { VMError } from "../../errors.js";
import type { AssistanceWatchEvent } from "../../protocol/assistance-watch.js";
import type { AsyncContext } from "./async-context.js";
import type { ProcessIO } from "./process-io.js";
import type { ProcessScheduler } from "./process-scheduler.js";
import { nodeResult } from "./node-file-operations.js";
import { unavailableNodeApi } from "./node-capability.js";
import { createNodePath } from "./node-path.js";
import { EventEmitter } from "./node-streams.js";

export type FilesystemWatcher = EventEmitter & { close(): void; ref(): FilesystemWatcher; unref(): FilesystemWatcher };

export function createNodeWatchers(
  io: Pick<ProcessIO, "call" | "callSync" | "retain" | "fail">,
  context: AsyncContext, scheduler: Pick<ProcessScheduler, "enqueue">,
): { readonly watch: (path: unknown, options?: unknown, listener?: unknown) => FilesystemWatcher; dispose(): void } {
  const groups = new Map<number, Set<Watcher>>();
  const watchers = new Set<Watcher>();
  const retired = new Set<number>();
  let disposed = false; let reading = false; let sequence = 0n;
  const basename = createNodePath(() => "/").basename;

  function dispose(): void {
    disposed = true;
    for (const watcher of watchers) watcher.finish(false);
    groups.clear(); retired.clear();
  }
  function fail(error: unknown): void { if (!disposed) { dispose(); io.fail(error); } }
  function pump(): void {
    if (disposed || reading || groups.size === 0) return;
    reading = true;
    let pending;
    try { pending = io.call({ kind: "watch-read" }, false); }
    catch (error) { fail(error); return; }
    void pending.then(result => {
      if (disposed) return;
      scheduler.enqueue(() => {
        if (disposed) return;
        try {
          const reply = nodeResult(result);
          if (reply.kind !== "watch-events") throw new VMError("PROTOCOL_ERROR", "Invalid watcher reply");
          for (const event of reply.events) receive(event);
        } catch (error) { fail(error); }
        finally { reading = false; retired.clear(); pump(); }
      });
    }, fail);
  }
  function receive(event: AssistanceWatchEvent): void {
    if (event.sequence !== sequence + 1n) throw new VMError("PROTOCOL_ERROR", "Watcher event sequence was lost");
    sequence = event.sequence;
    if (event.change === "overflow") throw new VMError("GUEST_CRASH", "Linux watcher queue overflow; restart the affected task", { api: "fs.watch", restartRequired: true });
    if (event.watch === null) throw new VMError("PROTOCOL_ERROR", "Watcher event has no inode identity");
    const group = groups.get(event.watch);
    if (group === undefined) {
      if (retired.has(event.watch)) return;
      throw new VMError("PROTOCOL_ERROR", "Unknown watcher event identity");
    }
    const recipients = [...group];
    if (event.change === "retired") {
      groups.delete(event.watch);
      for (const watcher of recipients) watcher.native = false;
    }
    for (const watcher of recipients) watcher.receive(event);
  }

  class Watcher extends EventEmitter implements FilesystemWatcher {
    native = true;
    private closed = false;
    private release: (() => void) | undefined;
    private readonly run = context.capture();
    private readonly abort = () => this.close();
    constructor(readonly handle: number, readonly path: string, readonly encoding: WatchEncoding, persistent: boolean, readonly signal: AbortSignal | undefined) {
      super();
      watchers.add(this);
      if (persistent) this.ref();
      signal?.addEventListener("abort", this.abort, { once: true });
    }
    ref(): this { if (!this.closed) this.release ??= io.retain(); return this; }
    unref(): this { this.release?.(); this.release = undefined; return this; }
    close(): void {
      if (this.closed) return;
      if (this.native) {
        const result = nodeResult(io.callSync({ kind: "watch-remove", watch: this.handle }));
        if (result.kind !== "unit") throw new VMError("PROTOCOL_ERROR", "Invalid watcher close reply");
      }
      this.finish(true);
    }
    finish(notify: boolean): void {
      if (this.closed) return;
      this.closed = true; this.unref(); watchers.delete(this);
      this.signal?.removeEventListener("abort", this.abort);
      const group = groups.get(this.handle);
      group?.delete(this);
      if (group?.size === 0) {
        groups.delete(this.handle);
        if (reading) retired.add(this.handle);
      }
      if (notify) scheduler.enqueue(() => this.run(() => { this.emit("close"); }));
    }
    receive(event: AssistanceWatchEvent): void {
      if (this.closed) return;
      const bytes = event.name === null ? Buffer.from(basename(this.path)) : Buffer.from(event.name);
      const name = this.encoding === "buffer" ? bytes : this.encoding === "base64url" ? bytes.toString("base64").replace(/=/gu, "").replace(/\+/gu, "-").replace(/\//gu, "_") : bytes.toString(this.encoding);
      this.run(() => { this.emit("change", event.change === "change" ? "change" : "rename", name); });
    }
  }

  function watch(path: unknown, value?: unknown, callback?: unknown): FilesystemWatcher {
    if (disposed) throw new VMError("ABORTED", "Filesystem watcher owner is disposed");
    if (typeof path !== "string" || path.includes("\0")) throw new TypeError("Only UTF-8 string watch paths are supported");
    if (typeof value === "function") { callback = value; value = undefined; }
    if (callback !== undefined && typeof callback !== "function") throw new TypeError("Watch listener must be a function");
    const options = value === undefined || value === null ? {} : typeof value === "string" ? { encoding: value } : record(value, "watch options");
    exactKeys(options, [], ["encoding", "persistent", "recursive", "signal"]);
    const encoding = watchEncoding(options["encoding"] ?? "utf8");
    const persistent = options["persistent"] ?? true; const recursive = options["recursive"] ?? false;
    if (typeof persistent !== "boolean" || typeof recursive !== "boolean") throw new TypeError("Invalid watcher boolean option");
    if (recursive) unavailableNodeApi("fs.watch recursive");
    const signal = options["signal"];
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError("Invalid watcher AbortSignal");
    if (watchers.size >= 8192) throw new VMError("QUOTA_EXCEEDED", "Filesystem watcher count exhausted");
    let handle = 0;
    if (signal?.aborted !== true) {
      if (path === "") throw Object.assign(new Error("ENOENT: watch"), { code: "ENOENT", errno: -2, syscall: "watch", path });
      const result = nodeResult(io.callSync({ kind: "watch-add", path }));
      if (result.kind !== "watch-opened") throw new VMError("PROTOCOL_ERROR", "Invalid watcher creation reply");
      handle = result.watch;
    }
    const watcher = new Watcher(handle, path, encoding, persistent, signal);
    if (typeof callback === "function") watcher.on("change", (...args: unknown[]) => { Reflect.apply(callback, watcher, args); });
    if (signal?.aborted === true) { watcher.native = false; watcher.close(); return watcher; }
    const group = groups.get(handle) ?? new Set<Watcher>(); group.add(watcher); groups.set(handle, group);
    pump(); return watcher;
  }
  return { watch, dispose };
}

type WatchEncoding = "buffer" | "utf8" | "utf16le" | "latin1" | "ascii" | "base64" | "base64url" | "hex";
function watchEncoding(value: unknown): WatchEncoding {
  if (value === "buffer") return value;
  if (typeof value !== "string") throw new TypeError("Invalid watcher encoding");
  switch (value.toLowerCase()) {
    case "utf8": case "utf-8": return "utf8";
    case "ucs2": case "ucs-2": case "utf16le": case "utf-16le": return "utf16le";
    case "binary": case "latin1": return "latin1";
    case "ascii": return "ascii";
    case "base64": return "base64";
    case "base64url": return "base64url";
    case "hex": return "hex";
    default: throw new TypeError("Invalid watcher encoding");
  }
}
