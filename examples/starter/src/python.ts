import type { PipeSpawnSpec, ProcessHandle, VM } from "@oxidevm/sdk";
import { decodeDataframe } from "./dataframe.js";
import { pythonRunner } from "./analysis.js";

export function verifyPython(bytes: Uint8Array): void {
  if (bytes.length < 64 || bytes[0] !== 127 || bytes[1] !== 69 || bytes[2] !== 76 || bytes[3] !== 70 || bytes[4] !== 2 || bytes[5] !== 1 || bytes[18] !== 62 || bytes[19] !== 0) throw new Error("The starter requires a real Linux x86-64 Python executable.");
}
type PythonProcess = Pick<ProcessHandle, "stdin" | "stdout" | "stderr" | "exit" | "kill">;
interface PythonHost {
  readonly workspace: Pick<VM["workspace"], "writeText" | "read" | "remove">;
  spawn(spec: PipeSpawnSpec): Promise<PythonProcess>;
}
interface Reply { readonly id: string; readonly ok: boolean; readonly stdout: string; readonly stderr: string }
interface Session {
  readonly process: PythonProcess;
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  pending?: { readonly id: string; readonly resolve: (reply: Reply) => void; readonly reject: (error: Error) => void };
  stderr: string;
}
function decodeReply(line: string): Reply {
  const value: unknown = JSON.parse(line);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid Python completion");
  const record = Object.fromEntries(Object.entries(value));
  if (Object.keys(record).length !== 4 || typeof record["id"] !== "string" || typeof record["ok"] !== "boolean" || typeof record["stdout"] !== "string" || typeof record["stderr"] !== "string") throw new Error("Invalid Python completion");
  const encoder = new TextEncoder();
  if (encoder.encode(record["stdout"]).length > 65536 || encoder.encode(record["stderr"]).length > 65536) throw new Error("Python completion exceeds output limits");
  return { id: record["id"], ok: record["ok"], stdout: record["stdout"], stderr: record["stderr"] };
}
function failure(value: unknown): Error { return value instanceof Error ? value : new Error("Python execution stopped."); }

export class PythonSession {
  private session: Session | undefined;
  private busy = false;
  constructor(private readonly host: PythonHost) {}

  private async stop(session: Session, error: Error): Promise<void> {
    if (this.session === session) this.session = undefined;
    const pending = session.pending; delete session.pending;
    await session.process.kill("SIGKILL", { scope: "process-group" }).catch(() => undefined);
    pending?.reject(error);
    await session.writer.abort().catch(() => undefined);
  }
  async dispose(): Promise<void> {
    const session = this.session;
    if (session !== undefined) await this.stop(session, new Error("Python session closed."));
  }
  private async receive(session: Session): Promise<void> {
    const reader = session.process.stdout.getReader(), decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 1024 * 1024) throw new Error("Python completion exceeds its limit");
        let end: number;
        while ((end = buffer.indexOf("\n")) !== -1) {
          const reply = decodeReply(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          const pending = session.pending;
          if (pending === undefined || pending.id !== reply.id) throw new Error("Unexpected Python completion");
          delete session.pending; pending.resolve(reply);
        }
      }
      if (buffer !== "" || session.pending !== undefined) throw new Error(session.stderr.trim() || "Python exited before completing the run.");
    } catch (error) { await this.stop(session, failure(error)); }
    finally { reader.releaseLock(); }
  }
  private async receiveErrors(session: Session): Promise<void> {
    const reader = session.process.stderr.getReader(), decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        session.stderr += decoder.decode(value, { stream: true });
        if (session.stderr.length > 65536) throw new Error("Python startup output exceeds its limit");
      }
    } catch (error) { await this.stop(session, failure(error)); }
    finally { reader.releaseLock(); }
  }
  private async open(signal: AbortSignal): Promise<Session> {
    if (this.session !== undefined) return this.session;
    await this.host.workspace.writeText("_oxidevm/run.py", pythonRunner, signal);
    const process = await this.host.spawn({ command: "/usr/bin/python3", args: ["-u", "/workspace/_oxidevm/run.py"], cwd: "/workspace", env: { OPENBLAS_NUM_THREADS: "1", OMP_NUM_THREADS: "1" }, signal });
    const session: Session = { process, writer: process.stdin.getWriter(), stderr: "" };
    this.session = session;
    void this.receive(session); void this.receiveErrors(session);
    void process.exit.then(() => {
      if (this.session === session) void this.stop(session, new Error(session.stderr.trim() || "Python exited before completing the run."));
    }).catch((error: unknown) => this.stop(session, failure(error)));
    return session;
  }
  async run(code: string, signal: AbortSignal) {
    if (this.busy) throw new Error("Python is already running.");
    if (new TextEncoder().encode(code).length > 64 * 1024) throw new Error("Keep analysis.py below 64 KiB.");
    signal.throwIfAborted(); this.busy = true;
    const id = crypto.randomUUID(), jsonPath = `_oxidevm/${id}.json`, csvPath = `_oxidevm/${id}.csv`;
    let retained = false;
    try {
      await this.host.workspace.writeText("analysis.py", code, signal);
      const session = await this.open(signal);
      const completion = Promise.withResolvers<Reply>();
      session.pending = { id, ...completion };
      const abort = () => { void this.stop(session, failure(signal.reason)); };
      signal.addEventListener("abort", abort, { once: true });
      try {
        if (signal.aborted) abort();
        else void session.writer.write(new TextEncoder().encode(JSON.stringify({ id }) + "\n")).catch((error: unknown) => this.stop(session, failure(error)));
        const reply = await completion.promise;
        if (!reply.ok) throw new Error(reply.stderr.trim() || "Python failed.");
        const file = await this.host.workspace.read(jsonPath, { maxBytes: 2 * 1024 ** 2, signal });
        const value: unknown = JSON.parse(new TextDecoder().decode(file.data)), frame = decodeDataframe(value);
        retained = frame.csvAvailable;
        return { frame, csvPath, stdout: reply.stdout, stderr: reply.stderr };
      } finally { signal.removeEventListener("abort", abort); }
    } finally {
      await this.host.workspace.remove(jsonPath).catch(() => undefined);
      if (!retained) await this.host.workspace.remove(csvPath).catch(() => undefined);
      this.busy = false;
    }
  }
}
