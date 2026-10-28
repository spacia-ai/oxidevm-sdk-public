import { expect, it } from "vitest";
import { AgentPayloadWriter } from "./agent-protocol.js";
import { decodeUserspaceFileRecord, decodeUserspaceFileRequest, decodeUserspaceFileChanges, encodeUserspaceFileRequest } from "./userspace-files.js";
import { VMError } from "./errors.js";

it("decodes file errors and rejects malformed, truncated and trailing records", () => {
  const bytes = new AgentPayloadWriter().u32(1).u8(2).u8(1).u32(2).finish();
  expect(() => decodeUserspaceFileRecord(bytes, { operation: "stat", path: "/x" })).toThrowError("Workspace entry is missing");
  expect(() => decodeUserspaceFileRecord(bytes.subarray(0, -1), { operation: "stat", path: "/x" })).toThrowError();
  expect(() => decodeUserspaceFileRecord(Uint8Array.from([...bytes, 0]), { operation: "stat", path: "/x" })).toThrowError();
  expect(() => encodeUserspaceFileRequest({ operation: "read", path: "/x", maxBytes: 16 * 1024 * 1024 + 1 })).toThrow();
});
it("decodes change cursors without number conversion and validates ordering", () => {
  const record = new AgentPayloadWriter().u32(1).u64(0x1_0000_0000n).u8(0).u32(1).string("/app").string("page.tsx").finish();
  expect(decodeUserspaceFileChanges(record)).toEqual({ cursor: 0x1_0000_0000n, changes: [{ kind: "changed", directory: "/app", name: "page.tsx" }] });
  expect(() => decodeUserspaceFileChanges(record.subarray(0, -1))).toThrow();
});

it("rejects untrusted paths, versions, ordering and random bytes with protocol errors", () => {
  const path = new AgentPayloadWriter().u32(1).u8(2).string("/../outside").finish();
  expect(() => decodeUserspaceFileRequest(path)).toThrowError(VMError);
  let seed = 7;
  for (let i = 0; i < 1_000; i++) {
    const bytes = Uint8Array.from({ length: i % 64 }, () => { seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0; return seed >>> 24; });
    for (const decode of [decodeUserspaceFileChanges, decodeUserspaceFileRequest]) {
      try { decode(bytes); } catch (error) { expect(error).toBeInstanceOf(VMError); expect(error).toMatchObject({ code: "PROTOCOL_ERROR" }); }
    }
  }
  const unordered = new AgentPayloadWriter().u32(1).u64(1n).u8(0).u32(2).string("/").string("z").string("/").string("a").finish();
  expect(() => decodeUserspaceFileChanges(unordered)).toThrowError(VMError);
});

it("rejects the retired compiler-only realpath transport", () => {
  const bytes = new AgentPayloadWriter().u32(1).u8(9).string("/alias/index.d.ts").finish();
  expect(() => decodeUserspaceFileRequest(bytes)).toThrowError(VMError);
});
