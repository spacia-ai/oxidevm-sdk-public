// Maintainer subprocess capture only; this never executes guest workloads on the host.
import { spawn } from "node:child_process";

export interface QualificationCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly failure: "timeout" | "output-limit" | "spawn" | null;
}
export interface QualificationCommandOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly onOutput?: (text: string, stream: "stdout" | "stderr") => void;
}

export function qualificationCommand(command: string, args: readonly string[], options: QualificationCommandOptions): Promise<QualificationCommandResult> {
  const timeoutMs = options.timeoutMs ?? 30 * 60_000;
  const maxOutputBytes = options.maxOutputBytes ?? 16 * 1024 ** 2;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new Error("Invalid qualification subprocess bounds");
  const env = options.env ?? process.env;
  const secrets = Object.entries(env).filter(([key, value]) => /(?:TOKEN|PASSWORD|SECRET|PRIVATE_KEY)$/iu.test(key) && value !== undefined && value.length > 3).flatMap(([, value]) => value === undefined ? [] : [value]);
  const redact = (input: string) => {
    let output = secrets.reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), input);
    for (const secret of secrets) {
      for (let length = Math.min(secret.length - 1, output.length); length >= 4; length--) {
        if (output.endsWith(secret.slice(0, length))) { output = `${output.slice(0, -length)}[REDACTED]`; break; }
      }
    }
    return output;
  };
  return new Promise(resolveResult => {
    const child = spawn(command, [...args], { cwd: options.cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    const emitted = { stdout: 0, stderr: 0 };
    let bytes = 0; let failure: QualificationCommandResult["failure"] = null;
    function terminate(): void {
      try {
        if (process.platform === "win32" || child.pid === undefined) child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch (error: unknown) {
        if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ESRCH") throw error;
      }
    }
    function emit(target: Buffer[], stream: "stdout" | "stderr", final = false): void {
      if (options.onOutput === undefined) return;
      const raw = Buffer.concat(target).toString("utf8");
      let end = raw.length;
      if (!final) {
        // Hold any unfinished credential prefix and UTF-8 character across chunks.
        if (raw.endsWith("\uFFFD")) end--;
        for (const secret of secrets) {
          for (let length = Math.min(secret.length - 1, raw.length); length > 0; length--) {
            if (raw.endsWith(secret.slice(0, length))) { end = Math.min(end, raw.length - length); break; }
          }
          for (let index = raw.indexOf(secret); index >= 0; index = raw.indexOf(secret, index + 1)) {
            if (index < end && index + secret.length > end) end = index;
          }
        }
      }
      if (end > emitted[stream]) {
        options.onOutput(redact(raw.slice(emitted[stream], end)), stream); emitted[stream] = end;
      }
    }
    function capture(target: Buffer[], chunk: Buffer, stream: "stdout" | "stderr"): void {
      const available = Math.max(0, maxOutputBytes - bytes);
      if (available > 0) target.push(chunk.subarray(0, available));
      bytes += chunk.byteLength;
      if (bytes > maxOutputBytes) { failure = "output-limit"; terminate(); }
      emit(target, stream);
    }
    child.stdout.on("data", (chunk: Buffer) => { capture(stdout, chunk, "stdout"); });
    child.stderr.on("data", (chunk: Buffer) => { capture(stderr, chunk, "stderr"); });
    child.on("error", error => { failure = "spawn"; capture(stderr, Buffer.from(error.message), "stderr"); });
    // A completed leader must not leave descendants or inherited pipes alive.
    child.on("exit", terminate);
    const timeout = setTimeout(() => { failure = "timeout"; terminate(); }, timeoutMs);
    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      emit(stdout, "stdout", true); emit(stderr, "stderr", true);
      resolveResult({ stdout: redact(Buffer.concat(stdout).toString("utf8")), stderr: redact(Buffer.concat(stderr).toString("utf8")), exitCode, signal, failure });
    });
  });
}
