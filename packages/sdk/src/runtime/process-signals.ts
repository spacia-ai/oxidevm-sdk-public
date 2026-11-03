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

/** A real-time signal by number: SIGRTMIN (35, after musl's reserved 32 to 34) to SIGRTMAX (64). */
export type RealtimeSignalNumber =
  | 35 | 36 | 37 | 38 | 39 | 40 | 41 | 42 | 43 | 44 | 45 | 46 | 47 | 48 | 49
  | 50 | 51 | 52 | 53 | 54 | 55 | 56 | 57 | 58 | 59 | 60 | 61 | 62 | 63 | 64;
/** Offsets a real-time signal name may add to SIGRTMIN or take from SIGRTMAX: SIGRTMIN (35) + 29 is SIGRTMAX (64). */
export type RealtimeOffset = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29;
/** A real-time signal by name, as glibc and musl spell them; SIGRTMIN is 35, after musl's reserved 32 to 34. */
export type RealtimeSignalName = "SIGRTMIN" | `SIGRTMIN+${RealtimeOffset}` | `SIGRTMAX-${RealtimeOffset}` | "SIGRTMAX";
/** Any named Linux signal: a standard one or a real-time one. */
export type SignalName = LinuxSignal | RealtimeSignalName;
const RTMIN = 35, RTMAX = 64;

/** The number of a real-time signal name, or null for any other value. */
export function realtimeSignalNumber(value: unknown): number | null {
  if (value === "SIGRTMIN") return RTMIN;
  if (value === "SIGRTMAX") return RTMAX;
  if (typeof value !== "string") return null;
  const match = /^SIGRT(MIN\+|MAX-)([1-9]\d?)$/u.exec(value), offset = Number(match?.[2]);
  if (match === null || offset > RTMAX - RTMIN) return null;
  return match[1] === "MIN+" ? RTMIN + offset : RTMAX - offset;
}

/** The canonical name of real-time signal `number` (35 to 64): SIGRTMIN+n up to 50, SIGRTMAX-n above it, as `kill -l` lists them. */
export function realtimeSignalName(number: number): RealtimeSignalName | null {
  if (!Number.isInteger(number) || number < RTMIN || number > RTMAX) return null;
  if (number === RTMIN) return "SIGRTMIN";
  if (number === RTMAX) return "SIGRTMAX";
  const name = number - RTMIN <= 15 ? `SIGRTMIN+${String(number - RTMIN)}` : `SIGRTMAX-${String(RTMAX - number)}`;
  return isRealtimeName(name) ? name : null;
}
function isRealtimeName(value: string): value is RealtimeSignalName { return realtimeSignalNumber(value) !== null; }

/** The name of signal `number`, or null for 0, musl's reserved 32 to 34 and anything above 64. */
export function signalName(number: number): SignalName | null { return knownLinuxSignal(number) ?? realtimeSignalName(number); }
/** The number a signal name or real-time number names, or null. */
export function signalNumber(value: unknown): number | null {
  if (isLinuxSignal(value)) return linuxSignalNumber(value);
  if (typeof value === "number") return realtimeSignalName(value) === null ? null : value;
  return realtimeSignalNumber(value);
}

/**
 * A standard signal a Node process may listen for, without its `SIG` prefix: 1-31 but SIGKILL and SIGSTOP, which can
 * never be caught, and the synchronous faults SIGILL, SIGTRAP, SIGBUS, SIGFPE and SIGSEGV, which Node refuses.
 */
export type ListenableSignal = "HUP" | "INT" | "QUIT" | "ABRT" | "USR1" | "USR2" | "PIPE" | "ALRM" | "TERM" | "STKFLT" | "CHLD" | "CONT" | "TSTP" | "TTIN" | "TTOU" | "URG" | "XCPU" | "XFSZ" | "VTALRM" | "PROF" | "WINCH" | "IO" | "PWR" | "SYS";
const LISTENABLE: readonly ListenableSignal[] = ["HUP", "INT", "QUIT", "ABRT", "USR1", "USR2", "PIPE", "ALRM", "TERM", "STKFLT", "CHLD", "CONT", "TSTP", "TTIN", "TTOU", "URG", "XCPU", "XFSZ", "VTALRM", "PROF", "WINCH", "IO", "PWR", "SYS"];
/** The listenable signal `number` names, or null. */
export function listenableSignal(number: number): ListenableSignal | null {
  const name = knownLinuxSignal(number)?.slice(3);
  return LISTENABLE.find(candidate => candidate === name) ?? null;
}
/** The listenable signal a Node event name (`"SIGUSR1"`) names, or null for any other event. */
export function listenableEvent(event: unknown): ListenableSignal | null {
  return typeof event === "string" && event.startsWith("SIG") ? LISTENABLE.find(candidate => candidate === event.slice(3)) ?? null : null;
}
export function listenableNumber(signal: ListenableSignal): number { return linuxSignalNumber(`SIG${signal}`); }
