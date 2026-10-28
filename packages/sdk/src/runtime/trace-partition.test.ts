import { describe, expect, it } from "vitest";

import {
  applicationTraceTailCapacity,
  sampleApplicationTrace,
  tracePartition,
  tracePartitionCapacity,
} from "./trace-partition.js";

describe("system trace partitioning", () => {
  it("keeps kernel, application, and shared-library evidence independently", () => {
    expect(tracePartition(0, 0xffff_ffff_8100_0000n)).toBe("system");
    expect(tracePartition(3, 0x0000_0055_0000_0000n)).toBe("application");
    expect(tracePartition(3, 0x0000_7fff_f7f0_0000n)).toBe("shared-library");
  });

  it("reserves two bounded quarters without increasing the trace budget", () => {
    expect(tracePartitionCapacity(4_096)).toBe(1_024);
    expect(tracePartitionCapacity(32_768)).toBe(8_192);
    expect(tracePartitionCapacity(3)).toBe(0);
    expect(applicationTraceTailCapacity(8_192)).toBe(1_024);
    expect(sampleApplicationTrace(16)).toBe(true);
    expect(sampleApplicationTrace(17)).toBe(false);
  });
});
