import type { ByteStream } from "./streams.js";

/**
 * Idle HTTP/1.1 connections of one module process, by origin (scheme, host and port), for keep-alive. A connection is
 * returned only after its response was read to its end; it is closed after 4 seconds idle (Node's default
 * `keepAliveTimeout`), when more than six wait for one origin, and when the process's network is closed.
 */
export const IDLE_MS = 4_000;
const PER_ORIGIN = 6;

interface Idle { readonly stream: ByteStream; readonly timer: ReturnType<typeof setTimeout> }

export class ConnectionPool {
  readonly #idle = new Map<string, Idle[]>();
  #closed = false;

  /** The most recently returned idle connection for `origin`, if any. */
  take(origin: string): ByteStream | undefined {
    const list = this.#idle.get(origin), idle = list?.pop();
    if (list?.length === 0) this.#idle.delete(origin);
    if (idle === undefined) return undefined;
    clearTimeout(idle.timer);
    return idle.stream;
  }

  give(origin: string, stream: ByteStream): void {
    const list = this.#idle.get(origin) ?? [];
    if (this.#closed || list.length >= PER_ORIGIN) { void stream.close(); return; }
    const idle: Idle = { stream, timer: setTimeout(() => {
      const current = this.#idle.get(origin), index = current?.indexOf(idle) ?? -1;
      if (current !== undefined && index >= 0) current.splice(index, 1);
      if (current?.length === 0) this.#idle.delete(origin);
      void stream.close();
    }, IDLE_MS) };
    list.push(idle); this.#idle.set(origin, list);
  }

  get size(): number { return [...this.#idle.values()].reduce((total, list) => total + list.length, 0); }

  close(): void {
    this.#closed = true;
    for (const list of this.#idle.values()) for (const idle of list) { clearTimeout(idle.timer); void idle.stream.close(); }
    this.#idle.clear();
  }
}
