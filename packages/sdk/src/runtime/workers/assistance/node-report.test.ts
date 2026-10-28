import { expect, it } from "vitest";
import { createNodeReport } from "./node-report.js";
it("reports loaded Linux libraries for addon selection and refuses unsupported report data", () => {
  const report = createNodeReport({ readFileSync: () => "7f0000-7f1000 r-xp 00000000 00:01 1 /lib/ld-musl-x86_64.so.1\n7f2000-7f3000 rw-p 00000000 00:00 0 [heap]\n" }, "24.18.1");
  expect(report.getReport()).toMatchObject({ header: { nodejsVersion: "v24.18.1", arch: "x64", platform: "linux" }, sharedObjects: ["/lib/ld-musl-x86_64.so.1"] });
  expect(() => report.writeReport()).toThrow(/unavailable/u);
  expect(() => Reflect.get(report.getReport(), "javascriptHeap")).toThrow(/unavailable/u);
});
