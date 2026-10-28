import { describe, expect, it } from "vitest";

import { VMError } from "../../errors.js";
import { recordingCore } from "./core.test-support.js";
import { finishRestorePaused, validateRestoreRecord } from "./snapshot.js";

const SHAPE = { memoryMiB: 1536, vcpus: 1, profile: 2 } as const;

function validationFailure(core: ReturnType<typeof recordingCore>["core"]): unknown {
  try {
    validateRestoreRecord(core, new Uint8Array(32), SHAPE);
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("restore validation", () => {
  it("passes the VM's shape to the core with the staged machine record", () => {
    const { core, calls } = recordingCore(0);

    validateRestoreRecord(core, new Uint8Array(32), SHAPE);

    expect(calls.filter(call => call.name.startsWith("oxidevm_system_"))).toEqual([
      { name: "oxidevm_system_restore_validate", args: [32, 1536, 1, 2] },
    ]);
  });

  it("reports another machine shape or format as a typed incompatibility before restoring", () => {
    const { core, calls } = recordingCore(5);

    const failure = validationFailure(core);

    expect(failure).toBeInstanceOf(VMError);
    expect(failure).toMatchObject({ code: "SNAPSHOT_VERSION", detail: { reason: "snapshot-incompatible" } });
    expect(calls.some(call => call.name === "oxidevm_system_restore_begin")).toBe(false);
  });

  it("reports a malformed machine record as damaged", () => {
    const { core } = recordingCore(2);

    const failure = validationFailure(core);

    expect(failure).toBeInstanceOf(VMError);
    expect(failure).toMatchObject({ code: "STORAGE_ERROR", detail: { reason: "snapshot-damaged" } });
  });
});

describe("restore clock policy", () => {
  it("finishes with guest time paused and the RTC at the host's wall clock", () => {
    const { core, calls } = recordingCore(0);

    finishRestorePaused(core, 1_790_000_000_999);

    expect(calls.filter(call => call.name === "oxidevm_system_restore_finish")).toEqual([
      { name: "oxidevm_system_restore_finish", args: [0, 1_790_000_000, 0] },
    ]);
  });
});
