import { spawn } from "node:child_process";
import { VMError } from "../runtime/errors.js";

export function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    if(signal.reason instanceof VMError)throw signal.reason;
    throw new VMError("ABORTED", "operation was aborted");
  }
}

/** No shell and no raw tool output in errors: builds may contain author-supplied secrets. */
export async function runTool(command: string, args: readonly string[], options: {
  readonly cwd?: string; readonly signal?: AbortSignal; readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number; readonly maxOutputBytes?: number;
} = {}): Promise<string> {
  abortIfRequested(options.signal);
  if (process.platform === "win32") throw new VMError("FEATURE_NOT_AVAILABLE", "image tools require a POSIX host for owned process-group cleanup");
  const timeoutMs = options.timeoutMs ?? 30 * 60_000;
  const maximum = options.maxOutputBytes ?? 64 * 1024 ** 2;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60_000
    || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 64 * 1024 ** 2) throw new VMError("INVALID_ARGUMENT", "tool execution limits are invalid");
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd: options.cwd, env: options.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = []; let total = 0; let failure: VMError | undefined; let settled = false;
    function retire(): void {
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* The owned group has already exited. */ }
      }
    }
    function fail(error: VMError): void { failure ??= error; retire(); }
    const abort = () => fail(new VMError("ABORTED", "operation was aborted"));
    const timer = setTimeout(() => fail(new VMError("STORAGE_ERROR", `${command} exceeded its execution deadline`, { tool: command, reason: "tool-timeout" })), timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted === true) abort();
    function finish(code: number | null): void {
      if (settled) return;
      settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort); retire();
      if (failure !== undefined) reject(failure);
      else if (code === 0) resolve(Buffer.concat(stdout).toString("utf8").trim());
      else reject(new VMError("STORAGE_ERROR", `${command} failed; check the build inputs`, {
        tool: command, ...(code !== null && Number.isSafeInteger(code) ? { exitCode: code } : {}),
      }));
    }
    function accept(value: unknown, retain: boolean): void {
      if (failure !== undefined || settled) return;
      if (!(value instanceof Buffer)) { fail(new VMError("PROTOCOL_ERROR", "tool output is not a byte stream")); return; }
      total += value.length;
      if (total > maximum) { fail(new VMError("STORAGE_ERROR", `${command} exceeded its output limit`, { tool: command, reason: "tool-output-limit" })); return; }
      if (retain) stdout.push(value);
    }
    child.stdout.on("data", (value: unknown) => accept(value, true));
    child.stderr.on("data", (value: unknown) => accept(value, false));
    child.once("error", (error: unknown) => {
      const code: unknown = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (code === "ENOENT") failure ??= new VMError("FEATURE_NOT_AVAILABLE", `${command} is not installed or executable`, { tool: command });
      else failure ??= new VMError("STORAGE_ERROR", `${command} could not be started`, { tool: command });
      finish(null);
    });
    child.once("close", (code: number | null) => finish(code));
  });
}
