import { describe, expect, it } from "vitest";
import { AgentFragments, AgentFragmentSender } from "./agent-fragments.js";
import type { AgentFrame } from "./agent-protocol.js";
import { AgentFrameDecoder, encodeAgentFrame } from "./agent-protocol.js";
import { readFileSync } from "node:fs";

function frame(length = 65536): AgentFrame {
  return { version: 4, kind: 14, requestId: 7, status: 0,
    payload: Uint8Array.from({ length }, (_, index) => index % 251) };
}
function first(frames: readonly AgentFrame[]): AgentFrame {
  const value = frames[0];
  if (value === undefined) throw new Error("missing fragment");
  return value;
}

describe("assisted bulk fragments", () => {
  it.each([{ kind: 20, limit: 53 + 65_536 }, { kind: 21 | 0x8000, limit: 65_536 }])("v7 transfer $kind uses bounded legacy fragments without admitting oversized allocations or v6 traffic", ({ kind, limit }) => {
    const message: AgentFrame = { version: 7, kind, requestId: 1, status: 0, payload: new Uint8Array(limit) };
    const frames = [...new AgentFragmentSender().frames(message)];
    const receiver = new AgentFrameDecoder();
    expect(frames.flatMap(frame => receiver.push(encodeAgentFrame(frame)))).toEqual([message]);
    receiver.finish();
    const oversized = { ...first(frames), payload: first(frames).payload.slice() };
    new DataView(oversized.payload.buffer).setUint32(12, limit + 1, true);
    expect(() => new AgentFragments().accept(oversized)).toThrow();
    expect(() => new AgentFragments().accept({ ...first(frames), version: 6 })).toThrow();
  });
  it.each([22, 23, 24])("v7 resume reply %s reassembles on the legacy lane and is refused below v7", kind => {
    const reply: AgentFrame = { version: 7, kind: kind | 0x8000, requestId: 3, status: 0, payload: new Uint8Array(3 * 4096 + 5).fill(9) };
    const frames = [...new AgentFragmentSender().frames(reply)];
    expect(frames).toHaveLength(4);
    const receiver = new AgentFrameDecoder();
    expect(frames.flatMap(part => receiver.push(encodeAgentFrame(part)))).toEqual([reply]);
    receiver.finish();
    expect(() => new AgentFragments().accept({ ...first(frames), version: 6 })).toThrow();
  });
  it.each([5, 6, 7] as const)("v%s keeps legacy and assisted reassembly independent with bounded wire frames", version => {
    const sender = new AgentFragmentSender();
    const legacy: AgentFrame = { ...frame(16384), version, kind: 3 };
    const assisted: AgentFrame = { ...frame(8192), version };
    const bulk = [...sender.frames(legacy)];
    const task = [...sender.frames(assisted)];
    expect(bulk).toHaveLength(4);
    expect(task).toHaveLength(2);
    const receiver = new AgentFrameDecoder();
    expect(receiver.push(encodeAgentFrame(first(bulk)))).toEqual([]);
    const completed = task.flatMap(part => receiver.push(encodeAgentFrame(part)));
    expect(completed).toEqual([assisted]);
    expect(bulk.slice(1).flatMap(part => receiver.push(encodeAgentFrame(part)))).toEqual([legacy]);
    receiver.finish();
    expect(() => encodeAgentFrame(legacy)).toThrow("large");
    const sameLane = new AgentFragments();
    sameLane.accept(first(bulk));
    const later = [...sender.frames({ ...legacy, requestId: 8 })];
    expect(() => sameLane.accept(first(later))).toThrow();
    const mixed = new AgentFragments();
    const older = [...new AgentFragmentSender().frames(frame())];
    mixed.accept(first(older));
    expect(() => mixed.accept(first(later))).toThrow();
    for (const version of [3, 4] as const) {
      const old = { ...legacy, version };
      expect([...sender.frames(old)]).toEqual([old]);
    }
  });
  it.each([4, 5, 6] as const)("decodes shared v%s Rust wire fixtures through the production frame reader", version => {
    const decoder = new AgentFrameDecoder();
    const fixture = readFileSync(new URL(`../../../../tests/fixtures/assistance/fragments-v${version}.hex`, import.meta.url), "utf8");
    const output: AgentFrame[] = [];
    for (const line of fixture.trim().split("\n")) {
      const hex = line.split(" ")[1];
      if (hex === undefined) throw new Error("invalid fixture");
      const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
      // Exercise fragmentation of the outer frame as well as the envelope.
      for (const byte of bytes) output.push(...decoder.push(Uint8Array.of(byte)));
    }
    decoder.finish();
    expect(output).toEqual(version === 4 ? [{ ...frame(0), payload: Uint8Array.of(65, 66, 67, 68) }] : [
      { version, kind: 14, requestId: 9, status: 0, payload: Uint8Array.of(87, 88) },
      { version, kind: 3, requestId: 8, status: 0, payload: Uint8Array.of(65, 66, 67, 68) },
    ]);
  });
  it("reassembles a full encoded envelope while allowing independent control progress", () => {
    const input = frame(128 * 1024);
    const parts = [...new AgentFragmentSender().frames(input)];
    expect(parts).toHaveLength(32);
    const receiver = new AgentFragments();
    expect(receiver.accept(first(parts))).toBeUndefined();
    const control = { ...frame(0), kind: 1 };
    expect(receiver.accept(control)).toBe(control);
    const completed = parts.slice(1).flatMap(part => receiver.accept(part) ?? []);
    expect(completed).toEqual([input]);
    receiver.finish();
    expect(() => receiver.accept(first(parts))).toThrow();
  });

  it("reassembles a 75,020-byte listener event on the legacy lane", () => {
    const event: AgentFrame = { version: 7, kind: 0x106, requestId: 9, status: 0,
      payload: Uint8Array.from({ length: 75_020 }, (_, index) => index % 253) };
    const frames = [...new AgentFragmentSender().frames(event)];
    expect(frames.length).toBeGreaterThan(1);
    const fragments = new AgentFragments();
    const delivered = frames.map((part) => fragments.accept(part)).filter((part) => part !== undefined);
    expect(delivered).toEqual([event]);
    const reply: AgentFrame = { version: 7, kind: 25 | 0x8000, requestId: 9, status: 0, payload: new Uint8Array(5_000) };
    expect([...new AgentFragmentSender().frames(reply)].length).toBeGreaterThan(1);
    const older: AgentFrame = { ...event, version: 6 };
    expect([...new AgentFragmentSender().frames(older)]).toEqual([older]);
  });

  it("leaves legacy frames byte-for-byte unchanged", () => {
    const input: AgentFrame = { ...frame(), version: 3 };
    expect([...new AgentFragmentSender().frames(input)]).toEqual([input]);
    expect(new AgentFragments().accept(input)).toBe(input);
  });

  it("rejects missing, duplicated, oversized, and mutated fragments", () => {
    const parts = [...new AgentFragmentSender().frames(frame())];
    const part = first(parts);
    const receiver = new AgentFragments();
    receiver.accept(part);
    expect(() => receiver.finish()).toThrow();
    expect(() => receiver.accept(part)).toThrow();
    for (const [offset, value] of [[2, 1], [12, 128 * 1024 + 1], [16, 1]] as const) {
      const payload = part.payload.slice();
      new DataView(payload.buffer).setUint32(offset, value, true);
      expect(() => new AgentFragments().accept({ ...part, payload })).toThrow();
    }
    expect(() => [...new AgentFragmentSender().frames(frame(128 * 1024 + 1))]).toThrow();
  });
});

it.each([18, 19, 0x8012, 0x8013, 0x105])("fragments installation kind %s only in guest v6 and v7", kind => {
  for (const version of [6, 7] as const) {
    const input: AgentFrame = { ...frame(65536), version, kind, requestId: kind === 0x105 ? 0 : 7 };
    const parts = [...new AgentFragmentSender().frames(input)];
    expect(parts).toHaveLength(16);
    const decoder = new AgentFragments();
    expect(parts.flatMap(part => decoder.accept(part) ?? [])).toEqual([input]);
    decoder.finish();
    for (const version of [4, 5] as const) {
      const legacy = { ...first(parts), version };
      expect(() => new AgentFragments().accept(legacy)).toThrow();
    }
  }
});
