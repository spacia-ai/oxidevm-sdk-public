import { describe, expect, it, vi, afterEach } from "vitest";
import { UserspaceWorkspaceFiles } from "./userspace-workspace-files.js";
import { AgentPayloadWriter } from "./agent-protocol.js";
import { decodeUserspaceFileRequest, encodeResidentFileRecord } from "./userspace-files.js";
import { writeAgentFileEntry } from "./protocol/agent-files.js";
import type { PreparedUserspaceRootfs } from "./protocol.js";
import type { WorkspaceFileEntry } from "./workspace-files.js";

const rootfs: PreparedUserspaceRootfs = { id: "test", version: "1", cpuProfile: "x86-64-v2", rootTreeSha256: "a".repeat(64), metadata: new Uint8Array(4), fileCount: 0, totalBytes: 0, runtimes: { supportingFiles: [] } };
const entry: WorkspaceFileEntry = { kind: "file", name: "a.ts", path: "/a.ts", size: 1, version: "0".repeat(48), link: null };
const ok = (operation: number) => new AgentPayloadWriter().u32(1).u8(operation).u8(0);
function backend() {
  return {
    files: vi.fn<(bytes: Uint8Array, mount?: unknown) => Promise<Uint8Array>>((bytes) => {
      const request = decodeUserspaceFileRequest(bytes);
      if (request.operation === "read" || request.operation === "legacy-read") return Promise.resolve(encodeResidentFileRecord(request, entry, new Uint8Array([65])));
      if (request.operation === "stat" || request.operation === "write") {
        const writer = ok(request.operation === "stat" ? 2 : 4);
        writeAgentFileEntry(writer, request.path === "/" ? { ...entry, path: "/", name: "", kind: "directory", size: 0 } : entry);
        return Promise.resolve(writer.finish());
      }
      return Promise.resolve(ok(7).finish());
    }),
    fileChanges: vi.fn((cursor: bigint) => Promise.resolve(new AgentPayloadWriter().u32(1).u64(cursor === 0n ? 1n : 2n).u8(0).u32(cursor === 0n ? 0 : 1).bytesRaw(cursor === 0n ? new Uint8Array() : new AgentPayloadWriter().string("/").string("a.ts").finish()).finish())),
  };
}
afterEach(() => vi.useRealTimers());
describe("Userspace native workspace client", () => {
  it("mounts once without spawning and uses the same service for legacy reads", async () => {
    const native = backend(); const files = new UserspaceWorkspaceFiles(native, () => rootfs, new AbortController().signal);
    const [left, right] = await Promise.all([files.read("/a.ts"), files.readFile("/a.ts")]);
    expect(left.data).toEqual(right); expect(native.files.mock.calls).toHaveLength(3);
    expect(native.files.mock.calls.filter(call => call.length > 1 && call[1] !== undefined)).toHaveLength(1);
    const first = native.files.mock.calls[0]; if (first === undefined) throw new Error("missing mount");
    expect(decodeUserspaceFileRequest(first[0])).toEqual({ operation: "stat", path: "/" });
  });
  it("requires a rootfs, shares one polling subscription and ends it on abort", async () => {
    const native = backend(); const lifetime = new AbortController();
    await expect(new UserspaceWorkspaceFiles(native, () => undefined, lifetime.signal).read("/a.ts")).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE", detail: { reason: "no-root-filesystem" } });
    vi.useFakeTimers();
    const files = new UserspaceWorkspaceFiles(native, () => rootfs, lifetime.signal);
    const abort = new AbortController(); const changes = vi.fn();
    const watch = files.watch(changes, { signal: abort.signal });
    await watch.setDirectories(["/"]); await vi.advanceTimersByTimeAsync(500);
    expect(native.fileChanges).toHaveBeenCalledTimes(2);
    expect(changes).toHaveBeenCalledWith([{ kind: "changed", directory: "/", name: "a.ts" }]);
    abort.abort(); await watch.done; await vi.advanceTimersByTimeAsync(1_000);
    expect(native.fileChanges).toHaveBeenCalledTimes(2);
  });
  it("rescans watchers and resets their journal cursor after native restore", async () => {
    vi.useFakeTimers();
    const native = backend(), abort = new AbortController(), changes = vi.fn();
    const files = new UserspaceWorkspaceFiles(native, () => rootfs, new AbortController().signal);
    const watch = files.watch(changes, { signal: abort.signal });
    await watch.setDirectories(["/"]); await vi.advanceTimersByTimeAsync(500);
    changes.mockClear(); native.fileChanges.mockClear();
    files.restored(); await vi.advanceTimersByTimeAsync(500);
    expect(changes).toHaveBeenCalledWith([{ kind: "rescan" }]);
    expect(native.fileChanges).toHaveBeenCalledWith(0n, expect.any(AbortSignal));
    abort.abort(); await watch.done;
  });
});

it("maps the native journal back to every watched directory alias", async () => {
  vi.useFakeTimers(); const native = backend(), original = native.files.getMockImplementation();
  native.files.mockImplementation(bytes => {
    const call = decodeUserspaceFileRequest(bytes);
    if (call.operation === "stat" && call.path !== "/") {
      const directory: WorkspaceFileEntry = { ...entry, name: call.path.slice(1), path: call.path, size: call.path === "/alias" ? 4 : 0, kind: call.path === "/alias" ? "symlink" : "directory", link: call.path === "/alias" ? {kind:"directory",path:"/real"} : null };
      const writer = ok(2); writeAgentFileEntry(writer, directory); return Promise.resolve(writer.finish());
    }
    if (original === undefined) throw new Error("missing backend"); return original(bytes);
  });
  native.fileChanges.mockImplementation(cursor => Promise.resolve(new AgentPayloadWriter().u32(1).u64(cursor === 0n ? 1n : 2n).u8(0).u32(cursor === 0n ? 0 : 1).bytesRaw(cursor === 0n ? new Uint8Array() : new AgentPayloadWriter().string("/real").string("child").finish()).finish()));
  const lifetime = new AbortController(), changes = vi.fn(), files = new UserspaceWorkspaceFiles(native,()=>rootfs,lifetime.signal), watch = files.watch(changes,{signal:lifetime.signal});
  await watch.setDirectories(["/real","/alias"]); await vi.advanceTimersByTimeAsync(500);
  expect(changes).toHaveBeenCalledWith(expect.arrayContaining([{kind:"changed",directory:"/real",name:"child"},{kind:"changed",directory:"/alias",name:"child"}]));
  lifetime.abort(); await expect(watch.done).rejects.toMatchObject({code:"ABORTED"});
});
