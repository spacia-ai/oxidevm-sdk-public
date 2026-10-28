import { EventEmitter } from "./node-streams.ts";

interface ReadableLike { on(event: string, listener: (...args: unknown[]) => void): unknown; pause?(): unknown; resume?(): unknown }
interface WritableLike { write(chunk: unknown): unknown }

function isReadable(value: unknown): value is ReadableLike {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "on") === "function";
}
function isWritable(value: unknown): value is WritableLike {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "write") === "function";
}
function text(value: unknown): string {
  return typeof value === "string" ? value : value instanceof Uint8Array ? new TextDecoder().decode(value) : "";
}

/** `readline.createInterface` over the runtime's streams: input chunks are
 * split at `\n`, `\r\n` and `\r`; `line`, `close`, `pause` and `resume` events,
 * `question`, `prompt`, `setPrompt`, `write` and `close` follow Node. The
 * interface is never a terminal in the assisted process. */
/** The public shape of a readline interface: the runtime's EventEmitter plus
 * Node's methods. Declared explicitly so the exported factory's class keeps
 * its private state out of the emitted declarations. */
export type ReadlineInterface = InstanceType<typeof EventEmitter> & {
  readonly terminal: boolean;
  line: string;
  readonly closed: boolean;
  setPrompt(prompt: unknown): void;
  getPrompt(): string;
  prompt(): void;
  question(query: unknown, options?: unknown, callback?: unknown): void;
  write(data: unknown): void;
  pause(): ReadlineInterface;
  resume(): ReadlineInterface;
  close(): void;
  [Symbol.asyncIterator](): AsyncIterator<string, undefined>;
};
export interface NodeReadline {
  readonly Interface: new (options: unknown) => ReadlineInterface;
  readonly createInterface: (options: unknown) => ReadlineInterface;
  readonly promises: { readonly createInterface: (options: unknown) => ReadlineInterface };
}

export function createNodeReadline(): NodeReadline {
  class Interface extends EventEmitter {
    readonly terminal = false;
    #buffer = "";
    #prompt: string;
    readonly #input: ReadableLike;
    readonly #output: WritableLike | undefined;
    #closed = false;
    #paused = false;
    #question: ((answer: string) => void) | undefined;
    line = "";
    constructor(options: unknown) {
      super();
      const record = typeof options === "object" && options !== null ? options : {};
      const input: unknown = Reflect.get(record, "input");
      if (!isReadable(input)) throw Object.assign(new TypeError("The \"input\" argument must be a readable stream"), { code: "ERR_INVALID_ARG_TYPE" });
      this.#input = input;
      const output: unknown = Reflect.get(record, "output");
      this.#output = isWritable(output) ? output : undefined;
      const prompt: unknown = Reflect.get(record, "prompt");
      this.#prompt = typeof prompt === "string" ? prompt : "> ";
      input.on("data", (chunk: unknown) => { this.#feed(text(chunk)); });
      input.on("end", () => { if (this.#buffer !== "") { const last = this.#buffer; this.#buffer = ""; this.#emitLine(last); } this.close(); });
      input.on("error", (error: unknown) => { this.emit("error", error); });
    }
    #feed(text: string): void {
      this.#buffer += text;
      for (;;) {
        const match = /\r\n|\n|\r/u.exec(this.#buffer);
        if (match === null) break;
        const line = this.#buffer.slice(0, match.index);
        this.#buffer = this.#buffer.slice(match.index + match[0].length);
        this.#emitLine(line);
      }
    }
    #emitLine(line: string): void {
      if (this.#closed) return;
      const question = this.#question;
      if (question !== undefined) { this.#question = undefined; question(line); return; }
      this.emit("line", line);
    }
    setPrompt(prompt: unknown): void { this.#prompt = text(prompt); }
    getPrompt(): string { return this.#prompt; }
    prompt(): void { this.#output?.write(this.#prompt); }
    question(query: unknown, options?: unknown, callback?: unknown): void {
      if (typeof options === "function") callback = options;
      if (typeof callback !== "function") throw Object.assign(new TypeError("The \"callback\" argument must be of type function"), { code: "ERR_INVALID_ARG_TYPE" });
      if (this.#closed) throw Object.assign(new Error("readline was closed"), { code: "ERR_USE_AFTER_CLOSE" });
      this.#output?.write(text(query));
      const answer = callback;
      this.#question = value => { Reflect.apply(answer, undefined, [value]); };
    }
    write(data: unknown): void { this.#feed(text(data)); }
    pause(): this { if (!this.#paused) { this.#paused = true; this.#input.pause?.(); this.emit("pause"); } return this; }
    resume(): this { if (this.#paused) { this.#paused = false; this.#input.resume?.(); this.emit("resume"); } return this; }
    close(): void { if (this.#closed) return; this.#closed = true; this.#question = undefined; this.emit("close"); }
    get closed(): boolean { return this.#closed; }
    [Symbol.asyncIterator](): AsyncIterator<string, undefined> {
      const queue: string[] = []; let waiting: ((result: IteratorResult<string, undefined>) => void) | undefined; let done = false;
      const settle = (result: IteratorResult<string, undefined>): void => { const wake = waiting; waiting = undefined; wake?.(result); };
      this.on("line", (line: unknown) => { if (typeof line !== "string") return; if (waiting !== undefined) settle({ value: line, done: false }); else queue.push(line); });
      this.on("close", () => { done = true; settle({ value: undefined, done: true }); });
      return { next: () => {
        const line = queue.shift();
        if (line !== undefined) return Promise.resolve({ value: line, done: false });
        if (done) return Promise.resolve({ value: undefined, done: true });
        return new Promise(resolve => { waiting = resolve; });
      } };
    }
  }
  return Object.freeze({ Interface, createInterface: (options: unknown): ReadlineInterface => new Interface(options), promises: Object.freeze({ createInterface: (options: unknown): ReadlineInterface => new Interface(options) }) });
}
