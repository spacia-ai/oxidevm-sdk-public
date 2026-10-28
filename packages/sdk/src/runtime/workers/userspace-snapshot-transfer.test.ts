import { expect, it } from "vitest";
import { VMError } from "../errors.js";
import type { SnapshotStorageClient } from "./snapshot-channel.js";
import { transferNativeCheckpoint, type NativeCheckpointTransferRuntime } from "./userspace-snapshot-transfer.js";

function fixture(failure?: "source" | "seal") {
  const events: string[] = []; let round = 0;
  const runtime: NativeCheckpointTransferRuntime = {
    freeze: () => { events.push("freeze"); return Promise.resolve(); },
    beginCapture: () => ({ transfer: async sink => { events.push("frozen"); await sink("graph", 0, new Uint8Array([1])); await sink("payloads", 0, new Uint8Array([2])); return { graphBytes: 1, payloadBytes: 1 }; },
      finish: () => { events.push("finish"); }, abort: () => { events.push("raw-abort"); } }),
    beginPrecopy: () => ({ transferRound: async sink => {
      events.push(`round:${String(round)}`);
      if (failure === "source") throw new VMError("STORAGE_ERROR", "source vanished", { reason: "checkpoint-precopy-failed", discardRounds: true });
      await sink(0, new Uint8Array([1])); return { round: round++, payloadBytes: 1 };
    }, commitRound: () => { events.push("ack-round"); }, finalize: async (sink, live) => {
      events.push("final"); await sink("graph", 0, new Uint8Array([2])); await sink("payloads", 0, new Uint8Array([3])); await live(0, new Uint8Array([4]));
      return { round, graphBytes: 1, payloadBytes: 1, liveIndexBytes: 1 };
    }, finish: () => { events.push("finish"); }, abort: () => { events.push("raw-abort"); } }),
  };
  const storage: Pick<SnapshotStorageClient, "request"> = { request: (request, _transfer, signal) => {
    events.push(request.type);
    if (request.type === "abort") expect(signal).toBeUndefined();
    if (failure === "seal" && request.type === "native-payload-round-seal") return Promise.reject(new VMError("QUOTA_EXCEEDED", "quota"));
    return Promise.resolve(request.type === "native-payload-consolidate" ? 37 : undefined);
  } };
  return { runtime, storage, events };
}
it("durably seals running rounds before epoch acknowledgement and holds the final frozen capture for manifest commit", async () => {
  const f = fixture(), result = await transferNativeCheckpoint(f.runtime, f.storage, { kind: "precopy" });
  expect(result).toMatchObject({ graphBytes: 1, payloadBytes: 37 });
  expect(result.pauseStartedAt).toBeLessThanOrEqual(performance.now());
  expect(f.events.filter(event => event === "ack-round")).toHaveLength(3);
  expect(f.events.indexOf("native-payload-round-seal")).toBeLessThan(f.events.indexOf("ack-round"));
  expect(f.events.indexOf("round:2")).toBeLessThan(f.events.indexOf("freeze"));
  expect(f.events.indexOf("freeze")).toBeLessThan(f.events.indexOf("final"));
  expect(f.events.at(-1)).toBe("native-payload-consolidate");
  expect(f.events).not.toContain("finish"); result.capture.finish(true); expect(f.events.at(-1)).toBe("finish");
});
it("uses the existing frozen stream path for a held recovery cut", async () => {
  const f = fixture(), result = await transferNativeCheckpoint(f.runtime, f.storage, { kind: "frozen", alreadyFrozen: true });
  expect(result).toMatchObject({ graphBytes: 1, payloadBytes: 1 });
  expect(f.events).toEqual(["frozen", "put-native-chunk", "put-native-chunk"]);
});
it("aborts the entire raw and storage capture after a failed speculative source", async () => {
  const f = fixture("source");
  await expect(transferNativeCheckpoint(f.runtime, f.storage, { kind: "precopy" })).rejects.toMatchObject({ detail: { discardRounds: true } });
  expect(f.events.slice(-2)).toEqual(["raw-abort", "abort"]);
  expect(f.events).not.toContain("ack-round"); expect(f.events).not.toContain("frozen");
});
it("does not acknowledge an unsealed round when storage fails", async () => {
  const f = fixture("seal");
  await expect(transferNativeCheckpoint(f.runtime, f.storage, { kind: "precopy" })).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  expect(f.events.slice(-2)).toEqual(["raw-abort", "abort"]); expect(f.events).not.toContain("ack-round");
});
