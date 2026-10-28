import { expect, it } from "vitest";
import { decodeUserspaceRegistrationFailure, USERSPACE_REGISTRATION_FAILURE_VERSION } from "./userspace-registration-failure.ts";
import { putSource, record } from "./userspace-registration-failure.fixtures.ts";

function missingWriter(): Uint8Array<ArrayBuffer> {
  const bytes = record(), view = new DataView(bytes.buffer);
  view.setUint16(4, 6, true); putSource(view, 8, 426n, 7);
  bytes[112] = 16; bytes[113] = 22; bytes[115] = 0;
  view.setInt32(116, 0, true); view.setBigUint64(224, 17n, true);
  return bytes;
}

it("decodes an admitted enter's lost CQ writer without inventing a guest errno", () => {
  expect(decodeUserspaceRegistrationFailure(missingWriter())).toMatchObject({
    source: { pid: 7, tid: 7, number: 426n }, phase: "enter-body", reason: "cq-writer-missing",
    openFile: 17n, errno: undefined, peer: undefined, guestTicks: 51n,
  });
});

it.each([[22, "cq-writer-missing"], [23, "cq-writer-changed"], [24, "cq-position-changed"]] as const)(
  "keeps publication invariant %s separate from a Linux errno", (code, reason) => {
    const bytes = missingWriter(); bytes[113] = code;
    expect(decodeUserspaceRegistrationFailure(bytes)).toMatchObject({ phase: "enter-body", reason, errno: undefined });
  },
);

it.each([[7, "caller-context"], [25, "cq-memory"], [26, "cq-overflow"], [27, "cq-commit"], [28, "enter-state"], [29, "io-request-retention"]] as const)(
  "retains the concrete errno for enter failure %s", (code, reason) => {
    const bytes = missingWriter(), view = new DataView(bytes.buffer);
    bytes[113] = code; bytes[115] = 1; view.setInt32(116, 12, true);
    expect(decodeUserspaceRegistrationFailure(bytes)).toMatchObject({ phase: "enter-body", reason, errno: 12 });
    bytes[115] = 0; view.setInt32(116, 0, true);
    expect(() => decodeUserspaceRegistrationFailure(bytes)).toThrow();
  },
);

it("retains the actual conflicting writer's complete source", () => {
  const bytes = missingWriter(), view = new DataView(bytes.buffer);
  bytes[113] = 23; bytes[114] = 1; putSource(view, 128, 426n, 9);
  expect(decodeUserspaceRegistrationFailure(bytes)).toMatchObject({ reason: "cq-writer-changed", peer: { number: 426n, tid: 9 } });
  view.setBigUint64(144, 427n, true);
  expect(() => decodeUserspaceRegistrationFailure(bytes)).toThrow();
});

it("rejects older meanings, a foreign syscall, mismatched causes and padding", () => {
  const changes: readonly ((view: DataView) => void)[] = [
    view => view.setUint16(4, 5, true), view => view.setUint16(4, USERSPACE_REGISTRATION_FAILURE_VERSION + 1, true),
    view => view.setBigUint64(24, 427n, true), view => view.setUint8(112, 2),
    view => view.setUint8(113, 30), view => view.setInt32(116, 5, true),
    view => { view.setUint8(115, 1); view.setInt32(116, 5, true); }, view => view.setUint8(232, 1),
  ];
  for (const change of changes) {
    const bytes = missingWriter(); change(new DataView(bytes.buffer));
    expect(() => decodeUserspaceRegistrationFailure(bytes)).toThrow();
  }
});
