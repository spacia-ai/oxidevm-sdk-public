import { expect, it } from "vitest";
import { SystemConsole } from "./system-console.js";
import { recordingCore } from "./core.test-support.js";

it("updates console geometry through the core without injecting terminal input", () => {
  const { core, calls } = recordingCore();
  new SystemConsole().resize(core, { columns: 120, rows: 36 });
  expect(calls).toEqual([{ name: "oxidevm_system_console_resize", args: [120, 36] }]);
});

it("retains bounded diagnostic output after boot delivery and transferred live output", () => {
  const console = new SystemConsole();
  const boot = new TextEncoder().encode("boot\n");
  console.record(boot); console.queueBoot(boot);
  expect(console.takeBoot()).toEqual(boot);
  expect(console.takeBoot()).toEqual(new Uint8Array());
  expect(console.tail()).toBe("boot\n");
  const live = new TextEncoder().encode("helper failure\n");
  console.record(live);
  structuredClone(live, { transfer: [live.buffer] });
  expect(console.tail()).toBe("boot\nhelper failure\n");
  console.record(new Uint8Array(128 * 1024).fill(65));
  expect(console.tail()).toBe("A".repeat(64 * 1024));
  console.record(new TextEncoder().encode("end"));
  expect(console.tail()).toBe("A".repeat(64 * 1024 - 3) + "end");
  console.queueBoot(new Uint8Array(2 * 1024 * 1024).fill(66));
  // A byte check instead of a deep comparison, which takes seconds per MiB.
  const retained = console.takeBoot();
  expect(retained.byteLength).toBe(1024 * 1024);
  expect(retained.every((byte) => byte === 66)).toBe(true);
  console.record(new Uint8Array(64 * 1024).fill(255));
  expect(new TextEncoder().encode(console.tail()).byteLength).toBeLessThanOrEqual(64 * 1024);
  console.reset();
  expect(console.tail()).toBe("");
  expect(console.takeBoot()).toEqual(new Uint8Array());
});

it("keeps the newest console bytes as written for a snapshot's resume state", () => {
  const console = new SystemConsole();
  console.record(new Uint8Array([0x1b, 0x5b, 0x33, 0x32, 0x6d]));
  console.record(new Uint8Array(64 * 1024).fill(0x41));

  const tail = console.tailBytes();

  expect(tail.byteLength).toBe(64 * 1024);
  expect(tail.every((byte) => byte === 0x41)).toBe(true);
});
