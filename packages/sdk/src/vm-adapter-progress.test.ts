import { expect, it } from "vitest";
import { toBootProgress } from "./vm-adapter.js";

it("maps a cold boot only from the runtime's actual cold-boot decision", () => {
  expect(toBootProgress("userspace", { step: "boot" })).toEqual({ phase: "boot", mode: "userspace" });
  expect(toBootProgress("system", { step: "boot" })).toEqual({ phase: "boot", mode: "system" });
  expect(toBootProgress("userspace", { step: "open", completedBytes: 64, totalBytes: 128 }))
    .toEqual({ phase: "restore", step: "open", completedBytes: 64, totalBytes: 128 });
});

it("does not call cached native preparation a download", () => {
  expect(toBootProgress("userspace", { step: "prepare", completedBytes: 1, totalBytes: 2 }))
    .toEqual({ phase: "prepare-image", stage: "verify", completedBytes: 1, totalBytes: 2 });
  expect(toBootProgress("userspace", { step: "download", completedBytes: 1, totalBytes: 2 }))
    .toEqual({ phase: "download", asset: "restore-point", completedBytes: 1, totalBytes: 2 });
});
