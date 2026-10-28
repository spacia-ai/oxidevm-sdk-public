import { describe, expect, it } from "vitest";
import { decodeUserspaceSyscallTrace, USERSPACE_SYSCALL_TRACE_VERSION } from "./userspace-abi.ts";
import { FILTER_PHASES } from "./userspace-filter-retirement.fixtures.ts";
import { taskFilterTrace } from "./userspace-task-filter-finalization-trace.fixtures.ts";

describe("original task filter trace50", () => {
  it.each(FILTER_PHASES)("retains original lineage and exit source at phase %s", phase => {
    expect(decodeUserspaceSyscallTrace(taskFilterTrace(phase))).toMatchObject({version:50,events:[{
      kind:"io-uring-task-filter-finalization",pid:1,tid:2,number:60n,finalization:{
        rootBackingId:1n << 48n,ownerPid:1,ownerTid:2,cpuCgroupId:41n,guestTicks:99n,
        source:{kind:"syscall",admittedGuestTicks:50n},done:phase === 35,progress:{kind:"filters"},
      },
    }]});
  });

  it("admits fatal signals and preserves the original actor of group cleanup", () => {
    const bytes = taskFilterTrace(33), view = new DataView(bytes.buffer), at = 24;
    view.setUint32(at + 28,3,true);
    expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    view.setBigUint64(at + 56,231n,true);bytes.fill(0,at + 152,at + 192);
    bytes.set(new TextEncoder().encode("exit_group"),at + 152);bytes[at + 121] = 10;
    expect(decodeUserspaceSyscallTrace(bytes).events[0]).toMatchObject({tid:3,finalization:{ownerTid:2}});
    bytes[at + 236] = 2;bytes[at + 237] = 9;view.setBigUint64(at + 240,0x1000n,true);
    bytes.fill(0,at + 40,at + 56);bytes.fill(0,at + 64,at + 112);bytes.fill(0,at + 152,at + 192);
    bytes[at + 121] = 0;view.setBigUint64(at + 56,0xffff_ffff_ffff_ffffn,true);
    expect(decodeUserspaceSyscallTrace(bytes).events[0]).toMatchObject({finalization:{source:{kind:"signal",signal:9,instructionRip:0x1000n}}});
  });

  it("rejects foreign owners, invented resource steps and reserved fields", () => {
    for (const version of [1,43,47,48,49,USERSPACE_SYSCALL_TRACE_VERSION + 1]) {
      const bytes = taskFilterTrace(33);new DataView(bytes.buffer).setUint16(4,version,true);
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
    for (const offset of [128,144,238,252,264,288,440,511,560,624,991]) {
      const bytes = taskFilterTrace(33);bytes[24 + offset] = 1;
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
    for (const [offset,value] of [[192,0n],[192,(1n << 48n) + 1n],[200,0n],[200,0x8000_0000n],[224,0n],[208,49n]] as const) {
      const bytes = taskFilterTrace(33);new DataView(bytes.buffer).setBigUint64(24 + offset,value,true);
      expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
    }
    const bytes = taskFilterTrace(33);bytes[24 + 235] = 1;bytes[24 + 120] = 4;
    expect(() => decodeUserspaceSyscallTrace(bytes)).toThrow();
  });
});
