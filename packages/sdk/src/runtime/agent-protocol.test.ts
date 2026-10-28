import { describe, expect, it } from "vitest";

import {
  AGENT_PROTOCOL_VERSION,
  AGENT_RESPONSE_BIT,
  AgentCapability,
  AgentFrameDecoder,
  AgentKind,
  AgentPayloadReader,
  AgentPayloadWriter,
  type AgentFrame,
  decodeAgentProcessList,
  decodeAgentWorkspaceManifest,
  encodeAgentFrame,
  encodeAgentReseed,
  encodeAgentSetTime,
} from "./agent-protocol.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import { AgentFragmentSender } from "./agent-fragments.js";
import { VMError } from "./errors.js";

describe("guest agent binary protocol", () => {
  it("bounds payload accumulation before retaining another chunk", () => {
    const writer = new AgentPayloadWriter(8).u64(1n);
    expect(() => writer.u8(0)).toThrow();
    expect(writer.finish()).toHaveLength(8);
    expect(() => new AgentPayloadWriter(-1)).toThrow();
  });
  it("uses the v7 dialect and preserves exact metadata integers", () => {
    expect(AGENT_PROTOCOL_VERSION).toBe(7);
    expect(PROTOCOL_VERSION).toBe(175);
    const payload = new AgentPayloadWriter()
      .u64(0xffff_ffff_ffff_fffen)
      .i64(-1n)
      .finish();
    const reader = new AgentPayloadReader(payload);
    expect(reader.u64()).toBe(0xffff_ffff_ffff_fffen);
    expect(reader.i64()).toBe(-1n);
    reader.finish();
  });

  it("retains the exact v3 dialect and decoded readiness version before negotiation", () => {
    const legacy = Uint8Array.from([79,88,71,65,3,0,3,1,0,0,0,0,0,0,0,0,0,0,0,0]);
    const ready = new AgentFrameDecoder().push(legacy)[0];
    expect(ready).toMatchObject({ version: 3, kind: AgentKind.ready, requestId: 0 });
    const hello = encodeAgentFrame({ version: 3, kind: AgentKind.hello, requestId: 1, status: 0, payload: new Uint8Array() });
    expect(Array.from(hello)).toEqual([79,88,71,65,3,0,1,0,1,0,0,0,0,0,0,0,0,0,0,0]);
    const unsupported = legacy.slice(); unsupported[4] = 8;
    expect(() => new AgentFrameDecoder().push(unsupported)).toThrow();
  });

  it("round-trips fragmented frames and typed payloads", () => {
    const payload = new AgentPayloadWriter()
      .string("/app/page.tsx")
      .u32(7)
      .finish();
    const encoded = encodeAgentFrame({
      kind: AgentKind.writeFile | AGENT_RESPONSE_BIT,
      requestId: 42,
      status: 0,
      payload,
    });
    const decoder = new AgentFrameDecoder();
    expect(decoder.push(encoded.subarray(0, 7))).toEqual([]);
    const frames = decoder.push(encoded.subarray(7));
    expect(frames).toHaveLength(1);
    const frame = frames[0];
    expect(frame).toMatchObject({
      kind: AgentKind.writeFile | AGENT_RESPONSE_BIT,
      requestId: 42,
      status: 0,
    });
    if (frame === undefined) throw new Error("frame was not decoded");
    const reader = new AgentPayloadReader(frame.payload);
    expect(reader.string()).toBe("/app/page.tsx");
    expect(reader.u32()).toBe(7);
    reader.finish();
    decoder.finish();
  });

  it("fails closed on malformed and incomplete frames", () => {
    const valid = encodeAgentFrame({
      kind: AgentKind.hello,
      requestId: 1,
      status: 0,
      payload: new Uint8Array(),
    });
    const malformed = valid.slice();
    malformed[0] = 0;
    expect(() => new AgentFrameDecoder().push(malformed)).toThrow(VMError);

    const decoder = new AgentFrameDecoder();
    decoder.push(valid.subarray(0, valid.byteLength - 1));
    expect(() => decoder.finish()).toThrow(VMError);

    const reader = new AgentPayloadReader(new Uint8Array([1, 0, 0, 0]));
    expect(() => reader.bytes()).toThrow(VMError);
  });

  it("decodes a sorted recursive workspace manifest with exact identities", () => {
    const payload = new AgentPayloadWriter()
      .u32(3)
      .u8(1).u32(0o755).u64(0n).i64(11n).i64(12n).u64(8n).u64(9n).string("/workspace/app")
      .u8(2).u32(0o644).u64(4n).i64(13n).i64(14n).u64(8n).u64(10n).string("/workspace/app/a.ts")
      .u8(3).u32(0o777).u64(0n).i64(15n).i64(16n).u64(8n).u64(11n).string("/workspace/link").string("app/a.ts")
      .finish();
    expect(decodeAgentWorkspaceManifest(payload)).toEqual([
      { kind: "directory", mode: 0o755, size: 0n, mtimeNs: 11n, ctimeNs: 12n, device: 8n, inode: 9n, path: "/workspace/app" },
      { kind: "file", mode: 0o644, size: 4n, mtimeNs: 13n, ctimeNs: 14n, device: 8n, inode: 10n, path: "/workspace/app/a.ts" },
      { kind: "symlink", mode: 0o777, size: 0n, mtimeNs: 15n, ctimeNs: 16n, device: 8n, inode: 11n, path: "/workspace/link", target: "app/a.ts" },
    ]);
  });

  it("rejects duplicate or escaping workspace manifest paths", () => {
    const duplicate = new AgentPayloadWriter()
      .u32(2)
      .u8(1).u32(0o755).u64(0n).i64(0n).i64(0n).u64(1n).u64(1n).string("/workspace/a")
      .u8(1).u32(0o755).u64(0n).i64(0n).i64(0n).u64(1n).u64(2n).string("/workspace/a")
      .finish();
    expect(() => decodeAgentWorkspaceManifest(duplicate)).toThrow(VMError);
    const escaping = new AgentPayloadWriter()
      .u32(1)
      .u8(2).u32(0o600).u64(1n).i64(0n).i64(0n).u64(1n).u64(1n).string("/workspace/../secret")
      .finish();
    expect(() => decodeAgentWorkspaceManifest(escaping)).toThrow(VMError);
  });

  it("continues a frame split across a snapshot cut by replaying the bytes since the decoder was idle", () => {
    const whole: AgentFrame = { version: 7, kind: AgentKind.stdout, requestId: 3, status: 0, payload: new Uint8Array(14).fill(1) };
    const split: AgentFrame = { version: 7, kind: AgentKind.stdout, requestId: 3, status: 0, payload: new Uint8Array(16 * 1024 + 4).fill(2) };
    const parts = [whole, ...new AgentFragmentSender().frames(split)].map((frame) => encodeAgentFrame(frame));
    const wire = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
    parts.reduce((offset, part) => (wire.set(part, offset), offset + part.byteLength), 0);
    const cut = (parts[0]?.byteLength ?? 0) + 6000;
    const decoder = new AgentFrameDecoder();
    expect(decoder.push(wire.subarray(0, cut))).toEqual([whole]);

    const replay = decoder.resumeInbound();
    if (replay === undefined) throw new Error("the decoder kept no replay");
    const resumed = AgentFrameDecoder.resume(replay.bytes, replay.skip);

    expect(replay.skip).toBe(1);
    expect(resumed.push(wire.subarray(cut))).toEqual([split]);
    resumed.finish();
  });

  describe("resume operations", () => {
    function processList(entries: readonly [number, number, number][], count = entries.length): Uint8Array {
      const bytes = new Uint8Array(4 + entries.length * 9);
      const view = new DataView(bytes.buffer);
      view.setUint32(0, count, true);
      entries.forEach(([pid, requestId, flags], index) => {
        view.setUint32(4 + index * 9, pid, true);
        view.setUint32(8 + index * 9, requestId, true);
        view.setUint8(12 + index * 9, flags);
      });
      return bytes;
    }

    it("numbers the resume kinds and capability as the guest agent does", () => {
      expect([AgentKind.setTime, AgentKind.reseedEntropy, AgentKind.listProcesses]).toEqual([22, 23, 24]);
      expect(AgentCapability.resume).toBe(32);
    });

    it("numbers the listener kinds and capability as the guest agent does", () => {
      expect([AgentKind.watchListeners, AgentKind.listeners]).toEqual([25, 0x106]);
      expect(AgentCapability.listeners).toBe(64);
    });

    it("encodes the host wall clock as Unix seconds and nanoseconds", () => {
      const payload = encodeAgentSetTime(1_790_000_000_123);
      const view = new DataView(payload.buffer);

      expect(payload.byteLength).toBe(12);
      expect(view.getBigInt64(0, true)).toBe(1_790_000_000n);
      expect(view.getUint32(8, true)).toBe(123_000_000);
      expect(() => encodeAgentSetTime(-1)).toThrow(VMError);
      expect(() => encodeAgentSetTime(1.5)).toThrow(VMError);
    });

    it("reseeds with exactly sixty-four bytes", () => {
      const bytes = new Uint8Array(64).fill(7);

      expect(encodeAgentReseed(bytes)).toEqual(bytes);
      expect(() => encodeAgentReseed(new Uint8Array(63))).toThrow(VMError);
      expect(() => encodeAgentReseed(new Uint8Array(65))).toThrow(VMError);
    });

    it("decodes the guest's processes in pid order and rejects malformed lists", () => {
      expect(decodeAgentProcessList(processList([[41, 7, 0], [52, 9, 3]]))).toEqual([
        { pid: 41, requestId: 7, terminal: false, stdinOpen: false },
        { pid: 52, requestId: 9, terminal: true, stdinOpen: true },
      ]);
      expect(decodeAgentProcessList(processList([]))).toEqual([]);
      for (const malformed of [
        new Uint8Array(3),
        processList([[41, 7, 0]], 2),
        processList([[52, 9, 0], [41, 7, 0]]),
        processList([[41, 7, 4]]),
        processList([[0, 7, 0]]),
      ]) {
        expect(() => decodeAgentProcessList(malformed)).toThrow(VMError);
      }
    });
  });
});
