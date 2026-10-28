import { VMError } from "./errors.js";

/** Linux x86-64 signal names, owned with the guest process transport. */
const names = ["SIGHUP", "SIGINT", "SIGQUIT", "SIGILL", "SIGTRAP", "SIGABRT", "SIGBUS", "SIGFPE", "SIGKILL", "SIGUSR1", "SIGSEGV", "SIGUSR2", "SIGPIPE", "SIGALRM", "SIGTERM", "SIGSTKFLT", "SIGCHLD", "SIGCONT", "SIGSTOP", "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGURG", "SIGXCPU", "SIGXFSZ", "SIGVTALRM", "SIGPROF", "SIGWINCH", "SIGIO", "SIGPWR", "SIGSYS"] as const;
export type LinuxSignal = typeof names[number];
export type SignalScope = "process" | "process-group";
export function knownLinuxSignal(number: number): LinuxSignal | null { return names[number - 1] ?? null; }
export function linuxSignalNumber(name: LinuxSignal): number { return names.indexOf(name) + 1; }
/** Node exposes Linux's historical aliases alongside the transport's canonical names. */
export function linuxSignalConstants(): Record<string, number> {
  const signals: Record<string, number> = {};
  for (const [index, name] of names.entries()) {
    signals[name] = index + 1;
    if (name === "SIGABRT") signals["SIGIOT"] = index + 1;
    if (name === "SIGIO") signals["SIGPOLL"] = index + 1;
    if (name === "SIGSYS") signals["SIGUNUSED"] = index + 1;
  }
  return signals;
}
export function decodeLinuxSignal(value: unknown): LinuxSignal {
  if (!isLinuxSignal(value)) throw new VMError("INVALID_ARGUMENT", "unsupported Linux signal");
  return value;
}
export function decodeSignalScope(value: unknown): SignalScope {
  if (value !== "process" && value !== "process-group") throw new VMError("INVALID_ARGUMENT", "unsupported signal scope");
  return value;
}
function isLinuxSignal(value: unknown): value is LinuxSignal { return names.some(name => name === value); }
