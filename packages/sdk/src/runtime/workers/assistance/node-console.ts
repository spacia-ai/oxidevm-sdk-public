/** The process's `console`: Node's method surface over the two output
 * streams. Formatting is the runtime's `util.format`; grouping indents the
 * lines that follow; labels back `count` and `time`. A missing method here
 * ends any application that binds it at load, as Next's edge console does. */
export type ConsoleStream = "stdout" | "stderr";
export type ConsoleWrite = (stream: ConsoleStream, text: string) => void;
export type ConsoleFormat = (...values: unknown[]) => string;

export interface NodeConsole {
  readonly log: (...values: unknown[]) => void;
  readonly info: (...values: unknown[]) => void;
  readonly debug: (...values: unknown[]) => void;
  readonly warn: (...values: unknown[]) => void;
  readonly error: (...values: unknown[]) => void;
  readonly trace: (...values: unknown[]) => void;
  readonly assert: (condition: unknown, ...values: unknown[]) => void;
  readonly dir: (value: unknown, options?: unknown) => void;
  readonly dirxml: (...values: unknown[]) => void;
  readonly table: (data: unknown, columns?: unknown) => void;
  readonly count: (label?: unknown) => void;
  readonly countReset: (label?: unknown) => void;
  readonly time: (label?: unknown) => void;
  readonly timeEnd: (label?: unknown) => void;
  readonly timeLog: (label?: unknown, ...values: unknown[]) => void;
  readonly group: (...values: unknown[]) => void;
  readonly groupCollapsed: (...values: unknown[]) => void;
  readonly groupEnd: () => void;
  readonly timeStamp: (label?: unknown) => void;
  readonly profile: (label?: unknown) => void;
  readonly profileEnd: (label?: unknown) => void;
  readonly clear: () => void;
}

const GROUP_INDENT = "  ";

/** Node's `console.time` duration text: milliseconds below a second, seconds
 * (three decimals) at or above it; no trailing zeros in the millisecond form. */
function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(3)}s`;
  return `${Number(ms.toFixed(3))}ms`;
}

export function createNodeConsole(write: ConsoleWrite, format: ConsoleFormat, now: () => number = () => performance.now()): NodeConsole {
  let indent = "";
  const counts = new Map<string, number>();
  const timers = new Map<string, number>();
  const emit = (stream: ConsoleStream, text: string): void => {
    write(stream, indent === "" ? text : text.split("\n").map(line => indent + line).join("\n"));
  };
  const out = (...values: unknown[]): void => { emit("stdout", format(...values)); };
  const err = (...values: unknown[]): void => { emit("stderr", format(...values)); };
  const labelOf = (label: unknown): string => label === undefined ? "default" : typeof label === "string" ? label : format(label);
  const console: NodeConsole = {
    log: out, info: out, debug: out, dirxml: out,
    warn: err, error: err,
    trace: (...values: unknown[]) => {
      const detail = values.length === 0 ? "" : `: ${format(...values)}`;
      const frames = (new Error().stack ?? "").split("\n").slice(2).join("\n");
      emit("stderr", frames === "" ? `Trace${detail}` : `Trace${detail}\n${frames}`);
    },
    assert: (condition: unknown, ...values: unknown[]) => {
      const passed = Boolean(condition);
      if (passed) return;
      emit("stderr", values.length === 0 ? "Assertion failed" : `Assertion failed: ${format(...values)}`);
    },
    dir: (value: unknown) => { emit("stdout", format(value)); },
    table: (data: unknown) => { emit("stdout", format(data)); },
    count: (label?: unknown) => {
      const name = labelOf(label);
      const next = (counts.get(name) ?? 0) + 1;
      counts.set(name, next);
      emit("stdout", `${name}: ${next}`);
    },
    countReset: (label?: unknown) => {
      const name = labelOf(label);
      if (counts.has(name)) counts.set(name, 0);
      else emit("stderr", `Warning: Count for '${name}' does not exist`);
    },
    time: (label?: unknown) => {
      const name = labelOf(label);
      if (timers.has(name)) { emit("stderr", `Warning: Label '${name}' already exists for console.time()`); return; }
      timers.set(name, now());
    },
    timeEnd: (label?: unknown) => {
      const name = labelOf(label);
      const started = timers.get(name);
      if (started === undefined) { emit("stderr", `Warning: No such label '${name}' for console.timeEnd()`); return; }
      timers.delete(name);
      emit("stdout", `${name}: ${formatDuration(now() - started)}`);
    },
    timeLog: (label?: unknown, ...values: unknown[]) => {
      const name = labelOf(label);
      const started = timers.get(name);
      if (started === undefined) { emit("stderr", `Warning: No such label '${name}' for console.timeLog()`); return; }
      const detail = values.length === 0 ? "" : ` ${format(...values)}`;
      emit("stdout", `${name}: ${formatDuration(now() - started)}${detail}`);
    },
    group: (...values: unknown[]) => { if (values.length !== 0) out(...values); indent += GROUP_INDENT; },
    groupCollapsed: (...values: unknown[]) => { if (values.length !== 0) out(...values); indent += GROUP_INDENT; },
    groupEnd: () => { indent = indent.slice(0, Math.max(0, indent.length - GROUP_INDENT.length)); },
    timeStamp: () => {},
    profile: () => {},
    profileEnd: () => {},
    clear: () => {},
  };
  return console;
}

interface WritableLike { write(text: string): unknown }

function writable(value: unknown, name: string): WritableLike {
  const write: unknown = typeof value === "object" && value !== null ? Reflect.get(value, "write") : undefined;
  if (typeof write !== "function") throw Object.assign(new TypeError(`Console expects a writable ${name} stream`), { code: "ERR_CONSOLE_WRITABLE_STREAM" });
  return { write: (text: string): unknown => Reflect.apply(write, value, [text]) };
}

/** `console.Console`: a console bound to the given streams; `stderr` defaults
 * to `stdout` as in Node. Every method delegates to a console built for those
 * streams so the class stays a real, typed console. */
export class Console {
  readonly #console: NodeConsole;
  constructor(options: unknown, format: ConsoleFormat, now?: () => number) {
    const record = typeof options === "object" && options !== null ? options : {};
    const stdout = writable(Reflect.get(record, "stdout"), "stdout");
    const stderrOption: unknown = Reflect.get(record, "stderr");
    const stderr = stderrOption === undefined ? stdout : writable(stderrOption, "stderr");
    this.#console = createNodeConsole((stream, text) => { (stream === "stdout" ? stdout : stderr).write(`${text}\n`); }, format, now);
  }
  log(...args: unknown[]): void { this.#console.log(...args); }
  info(...args: unknown[]): void { this.#console.info(...args); }
  debug(...args: unknown[]): void { this.#console.debug(...args); }
  warn(...args: unknown[]): void { this.#console.warn(...args); }
  error(...args: unknown[]): void { this.#console.error(...args); }
  trace(...args: unknown[]): void { this.#console.trace(...args); }
  dir(item: unknown, options?: unknown): void { this.#console.dir(item, options); }
  dirxml(...args: unknown[]): void { this.#console.dirxml(...args); }
  assert(condition: unknown, ...args: unknown[]): void { this.#console.assert(condition, ...args); }
  count(label?: unknown): void { this.#console.count(label); }
  countReset(label?: unknown): void { this.#console.countReset(label); }
  time(label?: unknown): void { this.#console.time(label); }
  timeEnd(label?: unknown): void { this.#console.timeEnd(label); }
  timeLog(label?: unknown, ...args: unknown[]): void { this.#console.timeLog(label, ...args); }
  group(...args: unknown[]): void { this.#console.group(...args); }
  groupCollapsed(...args: unknown[]): void { this.#console.groupCollapsed(...args); }
  groupEnd(): void { this.#console.groupEnd(); }
  table(data: unknown, columns?: unknown): void { this.#console.table(data, columns); }
  timeStamp(label?: unknown): void { this.#console.timeStamp(label); }
  profile(label?: unknown): void { this.#console.profile(label); }
  profileEnd(label?: unknown): void { this.#console.profileEnd(label); }
  clear(): void { this.#console.clear(); }
}
