// Deliberately narrow declarations for the pinned compatibility packages. The
// process adapter exposes only API forms covered by the local-script profile.
declare module "events/" {
  export default class EventEmitter {
    on(event: string | symbol, listener: (...args: unknown[]) => void): this;
    addListener(event: string | symbol, listener: (...args: unknown[]) => void): this;
    prependListener(event: string | symbol, listener: (...args: unknown[]) => void): this;
    prependOnceListener(event: string | symbol, listener: (...args: unknown[]) => void): this;
    once(event: string | symbol, listener: (...args: unknown[]) => void): this;
    removeListener(event: string | symbol, listener: (...args: unknown[]) => void): this;
    removeAllListeners(event?: string | symbol): this;
    emit(event: string | symbol, ...args: unknown[]): boolean;
    listenerCount(event: string | symbol): number;
  }
}
declare module "readable-stream" {
  import EventEmitter from "events/";
  export class Stream extends EventEmitter {
    static Stream: typeof Stream;
    static Readable: typeof Readable;
    static Writable: typeof Writable;
    static Duplex: typeof Duplex;
    static Transform: typeof Transform;
    static PassThrough: typeof PassThrough;
    static pipeline: (...streams: [...Stream[], (error: Error | null | undefined) => void]) => Stream;
    static finished: (stream: Stream, callback: (error?: Error | null) => void) => () => void;
    static promises: { pipeline: (...streams: Stream[]) => Promise<void>; finished: (stream: Stream) => Promise<void> };
  }
  export class Readable extends Stream {
    constructor(options?: { highWaterMark?: number; read?(size: number): void; autoDestroy?: boolean; emitClose?: boolean;
      construct?(callback: (error?: Error | null) => void): void;
      destroy?(error: Error | null, callback: (error?: Error | null) => void): void });
    static from(iterable: Iterable<unknown> | AsyncIterable<unknown>, options?: { objectMode?: boolean; highWaterMark?: number }): Readable;
    push(chunk: Uint8Array | null): boolean;
    read(size?: number): unknown;
    setEncoding(encoding: string): this;
    [Symbol.asyncIterator](): AsyncIterableIterator<unknown>;
    pipe<Destination extends Writable | Duplex>(destination: Destination, options?: { end?: boolean }): Destination;
    resume(): this;
    pause(): this;
    destroy(error?: Error): this;
    readonly destroyed: boolean;
    readonly readableEnded: boolean;
    readonly closed: boolean;
    readonly readableLength: number;
    readonly readableFlowing: boolean | null;
    readonly _readableState: { readingMore: boolean; readonly resumeScheduled: boolean };
  }
  export class Writable extends Stream {
    constructor(options: { highWaterMark?: number; autoDestroy?: boolean; emitClose?: boolean; defaultEncoding?: string;
      construct?(callback: (error?: Error | null) => void): void;
      write(chunk: unknown, encoding: string, callback: (error?: Error | null) => void): void;
      final?(callback: (error?: Error | null) => void): void;
      destroy?(error: Error | null, callback: (error?: Error | null) => void): void });
    write(chunk: unknown, callback?: (error?: Error | null) => void): boolean;
    write(chunk: unknown, encoding: string, callback?: (error?: Error | null) => void): boolean;
    end(callback?: (error?: Error | null) => void): this;
    end(chunk: unknown, callback?: (error?: Error | null) => void): this;
    destroy(error?: Error): this;
    readonly destroyed: boolean;
    readonly writableFinished: boolean;
    readonly writableEnded: boolean;
    readonly writableLength: number;
  }
  export class Duplex extends Readable {
    constructor(options?: { highWaterMark?: number; allowHalfOpen?: boolean; autoDestroy?: boolean;
      read?(size: number): void;
      write?(chunk: unknown, encoding: string, callback: (error?: Error | null) => void): void;
      final?(callback: (error?: Error | null) => void): void;
      destroy?(error: Error | null, callback: (error?: Error | null) => void): void });
    write: Writable["write"];
    end: Writable["end"];
    readonly writableFinished: boolean;
    readonly writableEnded: boolean;
    readonly writableLength: number;
  }
  export class Transform extends Duplex {
    constructor(options?: { highWaterMark?: number; objectMode?: boolean;
      flush?(callback: (error?: Error | null) => void): void;
      transform?(chunk: unknown, encoding: string, callback: (error?: Error | null, output?: unknown) => void): void });
  }
  export class PassThrough extends Transform {}
}

/** Private scheduler shared with the pinned readable-stream implementation. */
declare module "process/" {
  const process: { nextTick: (callback: (...args: unknown[]) => void, ...args: unknown[]) => void };
  export default process;
}

/** The pinned parser validates its application-supplied configuration itself. */
declare module "@pkgjs/parseargs" {
  export function parseArgs(options?: unknown): unknown;
}

/** The consumed dependency namespace enters as unknown; node-util validates
 * its callable exports before admitting them into the process builtin table. */
declare module "node-inspect-extracted" {
  const inspection: unknown;
  export default inspection;
}

/** Pinned CommonJS package; runtime validates its callable namespace. */
declare module "assert/" {
  const assertions: unknown;
  export default assertions;
}
