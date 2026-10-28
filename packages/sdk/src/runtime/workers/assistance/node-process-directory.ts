import type { AssistanceOperation } from "../../protocol/assistance.js";
import type { AssistanceResult } from "../../protocol/assistance-reply.js";
import { VMError } from "../../errors.js";
import { nodeResult } from "./node-file-operations.js";

/** Node caches getcwd until a successful chdir. Linux owns the actual directory,
 * permission checks and relative I/O, including renamed or unlinked directories. */
export function createProcessDirectory(call: (operation: AssistanceOperation) => AssistanceResult, initial: string, isMainThread = true) {
  let cached: string | undefined = initial;
  return {
    cwd: (): string => {
      if (isMainThread && cached !== undefined) return cached;
      const result = nodeResult(call({ kind: "getcwd" }));
      if (result.kind !== "path" || !result.path.startsWith("/")) throw new VMError("PROTOCOL_ERROR", "Invalid Linux cwd response");
      cached = result.path;
      return cached;
    },
    chdir: (path: unknown): void => {
      if (!isMainThread) throw Object.assign(new TypeError("process.chdir() is not supported in workers"), { code: "ERR_WORKER_UNSUPPORTED_OPERATION" });
      if (typeof path !== "string" || path.includes("\0")) throw Object.assign(new TypeError("Invalid process.chdir directory"), { code: "ERR_INVALID_ARG_TYPE" });
      const result = nodeResult(call({ kind: "chdir", path }));
      if (result.kind !== "unit") throw new VMError("PROTOCOL_ERROR", "Invalid Linux chdir response");
      cached = undefined;
    },
  };
}
