import { spawn } from "node:child_process";
import { VMError } from "@oxidevm/sdk";
import type { CLIEnvironment } from "./run.js";

export async function startApplication(directory: string, manager: "npm" | "bun", io: CLIEnvironment): Promise<void> {
  async function run(args: readonly string[]): Promise<void> {
    if (io.signal.aborted) throw new VMError("ABORTED", "Starter startup canceled");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(manager, [...args], { cwd: directory, env: { ...io.environment }, detached: process.platform !== "win32", stdio: ["inherit", "pipe", "pipe"] });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const kill = (signal: NodeJS.Signals) => {
        if (child.pid === undefined) return;
        try { if (process.platform === "win32") child.kill(signal); else process.kill(-child.pid, signal); } catch { /* The child can finish before cancellation arrives. */ }
      };
      const abort = () => { kill("SIGTERM"); timeout = setTimeout(() => { kill("SIGKILL"); }, 3000); timeout.unref(); };
      io.signal.addEventListener("abort", abort, { once: true });
      if (io.signal.aborted) abort();
      child.stdout.on("data", (bytes: Buffer) => { io.stdout(bytes.toString("utf8")); });
      child.stderr.on("data", (bytes: Buffer) => { io.stderr(bytes.toString("utf8")); });
      child.once("error", () => { cleanup(); reject(new VMError("INVALID_ARGUMENT", `Install ${manager} and try the starter command again`)); });
      child.once("close", code => { cleanup(); if (io.signal.aborted) reject(new VMError("ABORTED", "Starter stopped")); else if (code !== 0) reject(new VMError("INVALID_ARGUMENT", `${manager} failed. The generated project remains at ${directory}`)); else resolve(); });
      function cleanup(): void { io.signal.removeEventListener("abort", abort); if (timeout !== undefined) clearTimeout(timeout); }
    });
  }
  io.stdout(`Installing starter dependencies with ${manager}…\n`);
  await run(manager === "npm" ? ["install", "--ignore-scripts", "--no-audit", "--no-fund"] : ["install", "--ignore-scripts"]);
  io.stdout("Starting your local OxideVM demo…\n");
  await run(["run", "dev", "--", "--host", "127.0.0.1"]);
}
