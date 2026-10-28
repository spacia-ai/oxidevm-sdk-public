import { describe, expect, it } from "vitest";
import { FILTER_PHASES } from "../userspace-filter-retirement.fixtures.ts";
import { decodeUserspaceFinalizationFailure, finalizationFailureDetail } from "./userspace-finalization-failure.ts";
import { taskFilterFailure } from "./userspace-task-filter-finalization-failure.fixtures.ts";

describe("canonical task filter OXFF10 failure", () => {
  it.each(FILTER_PHASES)("retains original ownership at phase %s", phase => {
    const decoded = decodeUserspaceFinalizationFailure(taskFilterFailure(phase));
    expect(decoded).toMatchObject({kind:"task-filters",errno:5,guestTicks:99n,
      stage:phase === 35 ? "ownership" : "resource",identity:{rootBackingId:1n << 48n,ownerPid:1,ownerTid:2,cpuCgroupId:41n,
        source:{kind:"syscall",pid:1,tid:2,number:60n}},progress:{kind:"filters"}});
    expect(() => JSON.stringify(finalizationFailureDetail(decoded))).not.toThrow();
  });

  it("retains a selection failure without inventing a committed phase", () => {
    const bytes = taskFilterFailure(33);bytes[16] = 8;bytes.fill(0,184,187);bytes.fill(0,208,256);
    expect(decodeUserspaceFinalizationFailure(bytes)).toMatchObject({kind:"task-filters",stage:"selection"});
    bytes[16] = 9;expect(() => decodeUserspaceFinalizationFailure(bytes)).toThrow();
  });

  it("rejects unsupported versions, foreign actors and noncanonical fields", () => {
    for (const version of [1,7,8,9,11]) {
      const bytes = taskFilterFailure(33);new DataView(bytes.buffer).setUint16(4,version,true);
      expect(() => decodeUserspaceFinalizationFailure(bytes)).toThrow();
    }
    for (const offset of [19,187,192,199,200,207,244,247,256,272,280,319]) {
      const bytes = taskFilterFailure(33);bytes[offset] = 1;expect(() => decodeUserspaceFinalizationFailure(bytes)).toThrow();
    }
    const bytes = taskFilterFailure(33),view = new DataView(bytes.buffer);
    view.setUint32(56,3,true);expect(() => decodeUserspaceFinalizationFailure(bytes)).toThrow();
    view.setBigUint64(88,231n,true);
    expect(decodeUserspaceFinalizationFailure(bytes)).toMatchObject({identity:{ownerTid:2,source:{tid:3,number:231n}}});
    bytes[16] = 11;expect(() => decodeUserspaceFinalizationFailure(bytes)).toThrow();
  });
});
