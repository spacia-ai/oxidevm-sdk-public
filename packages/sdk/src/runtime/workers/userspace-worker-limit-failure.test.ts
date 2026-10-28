import { expect, it } from "vitest";
import { decodeUserspaceRegistrationFailure } from "./userspace-registration-failure.js";
import { record } from "./userspace-registration-failure.fixtures.js";

function poolFailure(): Uint8Array<ArrayBuffer> {
  const bytes = record(), view = new DataView(bytes.buffer);
  view.setUint16(4, 7, true);
  bytes[112] = 17; bytes[113] = 32;
  view.setBigUint64(40, 19n, true);
  view.setBigUint64(56, 2n, true);
  view.setBigUint64(224, 99n, true);
  view.setBigUint64(232, 101n, true);
  view.setBigUint64(240, 7n, true);
  return bytes;
}

it("preserves the original poisoned pool and its allocation account in OXRF7", () => {
  const bytes = poolFailure();
  expect(decodeUserspaceRegistrationFailure(bytes)).toMatchObject({
    phase: "worker-limits", reason: "worker-pool-poisoned", openFile: 99n,
    workerPool: 101n, workerPoolCgroup: 7n, errno: 5,
    source: { number: 427n, arguments: [3n, 19n, 5n, 2n, 7n, 8n] },
  });
});

it("keeps a retiring caller distinct from a poisoned pool or a retiring ring", () => {
  const bytes = poolFailure(); bytes[113] = 33; bytes[115] = 0; bytes.fill(0, 116, 120);
  expect(decodeUserspaceRegistrationFailure(bytes)).toMatchObject({
    phase: "worker-limits", reason: "worker-pool-retiring", workerPool: 101n, workerPoolCgroup: 7n,
  });
});

it("rejects legacy reinterpretation and unrelated, missing or fabricated pool owners", () => {
  for (const [offset, value] of [[4, 6n], [40, 27n], [56, 1n], [232, 0n], [240, 0n]] as const) {
    const bytes = poolFailure(), view = new DataView(bytes.buffer);
    if (offset === 4) view.setUint16(offset, Number(value), true);
    else view.setBigUint64(offset, value, true);
    expect(() => decodeUserspaceRegistrationFailure(bytes)).toThrow(/malformed/u);
  }
  for (const [offset, value] of [[112, 10], [113, 30], [114, 1], [115, 0], [248, 1]] as const) {
    const bytes = poolFailure(); bytes[offset] = value;
    expect(() => decodeUserspaceRegistrationFailure(bytes)).toThrow(/malformed/u);
  }
});
