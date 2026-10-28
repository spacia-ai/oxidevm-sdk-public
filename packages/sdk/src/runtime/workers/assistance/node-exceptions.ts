import { VMError } from "../../errors.js";
import type { NodeProcess } from "./node-process.js";

export type ExceptionOrigin = "uncaughtException" | "unhandledRejection" | "rejectionHandled";

/** Application exceptions can reach Node listeners. Failed transport cannot. */
export function deliverProcessException(process: NodeProcess, error: unknown, origin: ExceptionOrigin, print: (error: unknown) => void, unhandled?: (error: unknown) => void, promise?: Promise<unknown>): boolean {
  if (error instanceof VMError && (error.code === "PROTOCOL_ERROR" || error.code === "VM_FAULT" || error.code === "ABORTED")) return false;
  if (origin === "rejectionHandled") {
    if (promise === undefined) throw new VMError("PROTOCOL_ERROR", "Handled rejection has no Promise identity");
    try { process.emit("rejectionHandled", promise); return true; }
    catch (failure) { return deliverProcessException(process, failure, "uncaughtException", print, unhandled); }
  }
  function finish(failure: unknown, code: 1 | 7): never {
    if (unhandled === undefined) print(failure); else unhandled(failure);
    return process.exit(code);
  }
  if (origin === "unhandledRejection") {
    try { if (process.emit("unhandledRejection", error, promise)) return true; }
    catch (failure) { return deliverProcessException(process, failure, "uncaughtException", print, unhandled); }
  }
  try {
    process.emit("uncaughtExceptionMonitor", error, origin);
    if (process.listenerCount("uncaughtException") !== 0) { process.emit("uncaughtException", error, origin); return true; }
  } catch (failure) { return finish(failure, 7); }
  return finish(error, 1);
}
