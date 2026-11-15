import { describe, expect, it } from "vitest";
import { decodeForkReply, decodeForkReplyBytes, decodeForkRequest, decodeForkRequestBytes, encodeForkReply, encodeForkRequest } from "./assistance-fork.ts";

const request = { entry: "/workspace/node_modules/next/dist/server/lib/start-server.js", args: ["--port", "3000"],
  execArgv: ["--enable-source-maps"], cwd: "/workspace", env: { NODE_ENV: "development", PATH: "/usr/bin" }, silent: false };

describe("fork request codec", () => {
  it("round-trips a resolved fork request through the mailbox encoding", () => {
    expect(decodeForkRequest(request)).toEqual(request);
    const bytes = encodeForkRequest(request);
    expect(decodeForkRequestBytes(bytes)).toEqual(request);
    expect(decodeForkRequestBytes(encodeForkRequest({ ...request, args: [], execArgv: [], silent: true }))).toEqual({ ...request, args: [], execArgv: [], silent: true });
    // A child inherits the implemented execution options (ADR 0026, 1.11), repeated or not.
    const options = ["-r", "dotenv/config", "--conditions=development", "--no-warnings", "--enable-source-maps", "--enable-source-maps"];
    expect(decodeForkRequestBytes(encodeForkRequest({ ...request, execArgv: options }))).toEqual({ ...request, execArgv: options });
  });
  it("rejects unresolved paths, unsupported execArgv, extra authority and malformed bytes", () => {
    expect(() => decodeForkRequest({ ...request, entry: "server.js" })).toThrow();
    expect(() => decodeForkRequest({ ...request, cwd: "app" })).toThrow();
    expect(() => decodeForkRequest({ ...request, execArgv: ["--inspect"] })).toThrow();
    // Only options: an execution argument list ends with its last option.
    for (const execArgv of [["--import", "tsx"], ["-r"], ["-r", "x", "script.js"], [1], Array.from({ length: 65 }, () => "--no-warnings")]) {
      expect(() => decodeForkRequest({ ...request, execArgv }), JSON.stringify(execArgv)).toThrow();
    }
    expect(() => decodeForkRequest({ ...request, silent: "yes" })).toThrow();
    expect(() => decodeForkRequest({ ...request, uid: 0 })).toThrow();
    expect(() => decodeForkRequest({ ...request, env: { "1BAD": "x" } })).toThrow();
    const bytes = encodeForkRequest(request);
    expect(() => decodeForkRequestBytes(bytes.subarray(0, bytes.length - 1))).toThrow();
    expect(() => decodeForkRequestBytes(new Uint8Array([...bytes, 0]))).toThrow();
    const wrongTag = bytes.slice(); wrongTag[0] = 2;
    expect(() => decodeForkRequestBytes(wrongTag)).toThrow();
  });
});

describe("fork reply codec", () => {
  it("round-trips spawned and error outcomes", () => {
    for (const reply of [{ kind: "spawned", process: 2, pid: 41 }, { kind: "error", errno: 11, code: "EAGAIN" }] as const) {
      expect(decodeForkReply(reply)).toEqual(reply);
      expect(decodeForkReplyBytes(encodeForkReply(reply))).toEqual(reply);
    }
  });
  it("rejects invalid identities, errno ranges, codes and stale bytes", () => {
    expect(() => decodeForkReply({ kind: "spawned", process: 0, pid: 41 })).toThrow();
    expect(() => decodeForkReply({ kind: "spawned", process: 2, pid: 1 })).toThrow();
    expect(() => decodeForkReply({ kind: "spawned", process: 2, pid: 41, helper: 3 })).toThrow();
    expect(() => decodeForkReply({ kind: "error", errno: 0, code: "EAGAIN" })).toThrow();
    expect(() => decodeForkReply({ kind: "error", errno: 4096, code: "EAGAIN" })).toThrow();
    expect(() => decodeForkReply({ kind: "error", errno: 11, code: "again" })).toThrow();
    expect(() => decodeForkReply({ kind: "retired" })).toThrow();
    expect(() => decodeForkReplyBytes(encodeForkRequest(request))).toThrow();
    expect(() => decodeForkReplyBytes(new Uint8Array([...encodeForkReply({ kind: "spawned", process: 2, pid: 41 }), 0]))).toThrow();
  });
});
