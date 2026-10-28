import { expect, it } from "vitest";
import { fixture } from "./userspace-checkpoint.test-support.js";
import { encodeCheckpointDeclaration } from "./userspace-checkpoint.js";

function precopyFixture(failRead = false) {
  const f = fixture(); let ordinal = 1;
  f.exports["oxidevm_userspace_checkpoint_precopy_begin"] = () => { f.events.push("precopy"); return 10n; };
  f.exports["oxidevm_userspace_checkpoint_precopy_round"] = () => ++ordinal;
  f.exports["oxidevm_userspace_checkpoint_precopy_commit_round"] = (_token: bigint, round: number) => { f.events.push(`round:${String(round)}`); return 0; };
  f.exports["oxidevm_userspace_checkpoint_precopy_finalize"] = () => { ordinal++; f.events.push("frozen"); return 0; };
  f.exports["oxidevm_userspace_checkpoint_precopy_round_declarations"] = (_token: bigint, round: number, after: bigint) => f.frame(round === 1 && after === 0n
    ? encodeCheckpointDeclaration({ reference: 3n, kind: 0n, length: BigInt(f.payload.length) }) : new Uint8Array());
  f.exports["oxidevm_userspace_checkpoint_precopy_payload_read"] = (_token: bigint, _round: number, _ref: bigint, offset: bigint) => failRead ? 1 : f.frame(f.payload.subarray(Number(offset), Number(offset) + 65536));
  return f;
}
it("streams bounded dirty rounds while running and emits the complete live index only at final freeze", async () => {
  const { bridge, events, payload } = precopyFixture();
  const capture = bridge.beginPrecopy(new Uint8Array(32));
  const sizes: number[] = [];
  const first = await capture.transferRound((_index, bytes) => { sizes.push(bytes.length); return Promise.resolve(); });
  expect(first).toEqual({ round: 0, payloadBytes: 40 + payload.length });
  expect(events).not.toContain("frozen");
  expect(() => capture.commitRound()).not.toThrow();
  expect((await capture.transferRound(() => Promise.resolve())).payloadBytes).toBe(16); capture.commitRound();
  expect((await capture.transferRound(() => Promise.resolve())).payloadBytes).toBe(16); capture.commitRound();
  await expect(capture.transferRound(() => Promise.resolve())).rejects.toThrow();
  const live: Uint8Array[] = [];
  const final = await capture.finalize(() => Promise.resolve(), (_index, bytes) => { live.push(bytes); return Promise.resolve(); });
  expect(final).toMatchObject({ round: 3, payloadBytes: 16, liveIndexBytes: 40 });
  expect(new TextDecoder().decode(live[0]?.subarray(0, 4))).toBe("OXUD");
  expect(events).toEqual(["precopy", "round:1", "round:2", "round:3", "frozen"]);
  expect(sizes.every(length => length <= 1024 * 1024)).toBe(true);
  capture.finish(true); expect(events.at(-1)).toBe("finish:1");
});
it("requires abort and a fresh frozen capture after a speculative source disappears", async () => {
  const { bridge, events } = precopyFixture(true), capture = bridge.beginPrecopy(new Uint8Array(32));
  await expect(capture.transferRound(() => Promise.resolve())).rejects.toMatchObject({ detail: { reason: "checkpoint-precopy-failed", discardRounds: true } });
  expect(() => capture.commitRound()).toThrow();
  await expect(capture.finalize(() => Promise.resolve(), () => Promise.resolve())).rejects.toThrow();
  capture.abort();
  const frozen = bridge.beginCapture(new Uint8Array(32)); await frozen.transfer(() => Promise.resolve()); frozen.finish(false);
  expect(events).toEqual(["precopy", "abort", "capture", "finish:0"]);
});
