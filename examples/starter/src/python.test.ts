import { expect, it, vi } from "vitest";
import { verifyPython } from "./python.js";
it("requires an actual little-endian Linux x86-64 ELF", () => {
  const bytes = new Uint8Array(64); bytes.set([127, 69, 76, 70, 2, 1, 1]); bytes[18] = 62;
  expect(() => verifyPython(bytes)).not.toThrow();
  for (const value of [bytes.slice(0, 63), new Uint8Array(64), Uint8Array.from(bytes, (byte, index) => index === 18 ? 183 : byte)]) expect(() => verifyPython(value)).toThrow();
});

import { PythonSession } from "./python.js";
import type { PipeSpawnSpec, ProcessExit, Workspace } from "@oxidevm/sdk";

function fixture() {
  const frame = { schemaVersion: 1, columns: [{ name: "value", dtype: "int64" }], rows: [[7]], index: ["0"], rowCount: 1, csvAvailable: true, versions: { python: "3.12.15", pandas: "2.3.3", numpy: "2.2.6" } };
  const requests: unknown[] = [], killed: number[] = [], files = new Map<string, string>();
  const exits: ReturnType<typeof Promise.withResolvers<ProcessExit>>[] = [];
  let starts = 0, mode: "ok" | "error" | "wait" | "invalid" = "ok";
  const host = {
    workspace: {
      writeText: (path: string, text: string) => { files.set(path, text); return Promise.resolve(); },
      read: () => Promise.resolve({ entry: { kind: "file", link: null, name: "result.json", path: "result.json", size: 1, version: "1" }, data: new TextEncoder().encode(JSON.stringify(frame)) }),
      remove: (path: string) => { files.delete(path); return Promise.resolve(); },
    } satisfies Pick<Workspace, "writeText" | "read" | "remove">,
    spawn: (_spec: PipeSpawnSpec) => {
      expect(_spec.command).toBe("/usr/bin/python3");
      const pid = ++starts, exit = Promise.withResolvers<ProcessExit>(); exits.push(exit);
      let output: ReadableStreamDefaultController<Uint8Array> | undefined;
      const stdout = new ReadableStream<Uint8Array>({ start(controller) { output = controller; } });
      const stderr = new ReadableStream<Uint8Array>();
      return Promise.resolve({ kind: "process" as const, pid, stdout, stderr, exit: exit.promise,
        stdin: new WritableStream<Uint8Array>({ write(bytes) {
          const request: unknown = JSON.parse(new TextDecoder().decode(bytes)); requests.push(request);
          if (typeof request !== "object" || request === null || !("id" in request) || typeof request.id !== "string") throw new Error("Invalid request");
          if (mode === "wait") return;
          output?.enqueue(new TextEncoder().encode(mode === "invalid" ? '{"bad":true}\n' : JSON.stringify({ id: request.id, ok: mode === "ok", stdout: "printed", stderr: mode === "error" ? "directed-error" : "" }) + "\n"));
        } }),
        kill: () => { killed.push(pid); output?.close(); exit.resolve({ kind: "signaled", signal: "SIGKILL", signalNumber: 9 }); return Promise.resolve(); },
      });
    },
  };
  return { host, requests, killed, exits, files, starts: () => starts, mode: (value: typeof mode) => { mode = value; } };
}
it("reuses Python across successful runs and recoverable script errors", async () => {
  const f = fixture(), session = new PythonSession(f.host), signal = new AbortController().signal;
  expect((await session.run("result = first", signal)).frame.rows).toEqual([[7]]);
  f.mode("error"); await expect(session.run("raise ValueError()", signal)).rejects.toThrow("directed-error");
  f.mode("ok"); await session.run("result = next", signal);
  expect(f.starts()).toBe(1); expect(f.requests).toHaveLength(3);
  expect(f.files.get("analysis.py")).toBe("result = next");
  await session.dispose(); expect(f.killed).toEqual([1]);
});
it("kills a cancelled run and starts a fresh interpreter on the next run", async () => {
  const f = fixture(), session = new PythonSession(f.host), abort = new AbortController(); f.mode("wait");
  const running = session.run("while True: pass", abort.signal);
  await vi.waitFor(() => expect(f.requests).toHaveLength(1));
  abort.abort(new Error("directed cancellation")); await expect(running).rejects.toThrow("directed cancellation");
  f.mode("ok"); await session.run("result = next", new AbortController().signal);
  expect(f.starts()).toBe(2); expect(f.killed).toContain(1); await session.dispose();
});
it("rejects malformed completion messages and concurrent runs", async () => {
  const f = fixture(), session = new PythonSession(f.host); f.mode("wait");
  const running = session.run("result = first", new AbortController().signal);
  await vi.waitFor(() => expect(f.requests).toHaveLength(1));
  await expect(session.run("result = concurrent", new AbortController().signal)).rejects.toThrow("already running");
  await session.dispose(); await expect(running).rejects.toThrow();
  f.mode("invalid"); await expect(session.run("result = invalid", new AbortController().signal)).rejects.toThrow("completion");
  await session.dispose();
});
it("rejects an unexpected process exit and validates input before spawning", async () => {
  const f = fixture(), session = new PythonSession(f.host), cancelled = new AbortController(); cancelled.abort();
  await expect(session.run("result = first", cancelled.signal)).rejects.toThrow();
  await expect(session.run("x".repeat(65537), new AbortController().signal)).rejects.toThrow("64 KiB");
  expect(f.starts()).toBe(0); f.mode("wait");
  const running = session.run("result = first", new AbortController().signal);
  const rejected = expect(running).rejects.toThrow("Python exited");
  await vi.waitFor(() => expect(f.requests).toHaveLength(1));
  f.exits[0]?.resolve({ kind: "exited", code: 1 }); await rejected;
  f.mode("ok"); await session.run("result = next", new AbortController().signal);
  expect(f.starts()).toBe(2); await session.dispose();
});
