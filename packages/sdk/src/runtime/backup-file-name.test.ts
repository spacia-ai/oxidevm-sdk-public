import { describe, expect, it } from "vitest";

import { backupFileName } from "./backup-file-name.js";

describe("backup file name", () => {
  it("names a backup after its restore point and capture time", () => {
    const capturedAtUnixMs = Date.parse("2026-10-02T10:00:02.000Z");

    expect(backupFileName({ label: "bun dev · 14:32", capturedAtUnixMs }, "UTC")).toBe("oxidevm-bun-dev-14-32-2026-10-02-1000.oxvm");
    expect(backupFileName({ capturedAtUnixMs }, "UTC")).toBe("oxidevm-restore-point-2026-10-02-1000.oxvm");
    expect(backupFileName({ label: "Zażółć ✨ ".repeat(10), capturedAtUnixMs }, "UTC")).toMatch(/^oxidevm-[a-z0-9-]{1,40}-2026-10-02-1000\.oxvm$/u);
  });
});
