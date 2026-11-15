import { expect, it } from "vitest";
import { Writer } from "./codec.js";
import { decodeAccelerationBackgroundPending, encodeAccelerationBackgroundPoll, decodeAccelerationKnowledgeChanged, encodeAccelerationKnowledgeChanged, decodeRuntimeProbeRequest, encodeRuntimeProbeReport, encodeRuntimeProbeTake, parseRuntimeProbeOutput } from "./runtime-probe.js";

const SHA = "b".repeat(64), NVM = "/home/user/.nvm/versions/node/v24.11.0/bin/node";
const CONFIG = '{"target_defaults":{},"variables":{"node_module_version":137}}';
const command = (operation: number, payload: Uint8Array) => new Writer().u32(1).u8(operation).u64(0n).u64(0n).raw(payload).finish();
const text = (value: string) => new TextEncoder().encode(value);
const output = (lines: readonly string[]) => text(lines.map(line => `${line}\n`).join(""));

it("polls Rust's bounded background trials with monotonic host time and an exact pending flag", () => {
  expect(encodeAccelerationBackgroundPoll(500n)).toEqual(command(14, new Writer().u64(500n).finish()));
  expect(decodeAccelerationBackgroundPending(Uint8Array.of(0))).toBe(false);
  expect(decodeAccelerationBackgroundPending(Uint8Array.of(1))).toBe(true);
  expect(decodeAccelerationBackgroundPending(Uint8Array.of(2))).toBe("disabled");
  for (const value of [-1n, 1n << 64n]) expect(() => encodeAccelerationBackgroundPoll(value)).toThrow();
  for (const bytes of [new Uint8Array(), Uint8Array.of(3), Uint8Array.of(0, 0)]) expect(() => decodeAccelerationBackgroundPending(bytes)).toThrow();
});

it("takes Rust's knowledge-change notification through operation 13 with an exact boolean result", () => {
  expect(encodeAccelerationKnowledgeChanged()).toEqual(command(13, new Uint8Array()));
  expect(decodeAccelerationKnowledgeChanged(Uint8Array.of(0))).toBe(false);
  expect(decodeAccelerationKnowledgeChanged(Uint8Array.of(1))).toBe(true);
  for (const bytes of [new Uint8Array(), Uint8Array.of(2), Uint8Array.of(1, 0)]) {
    expect(() => decodeAccelerationKnowledgeChanged(bytes)).toThrow();
  }
});

it("takes the next probe through command operation 11 and decodes Rust's request exactly", () => {
  expect(encodeRuntimeProbeTake()).toEqual(command(11, new Uint8Array()));
  expect(decodeRuntimeProbeRequest(new Uint8Array())).toBeUndefined();
  expect(decodeRuntimeProbeRequest(text(SHA + NVM))).toEqual({ sha256: SHA, path: NVM });
  for (const bytes of [text(SHA), text("B".repeat(64) + NVM), text("b".repeat(63) + NVM), text(SHA + "relative/node"), text(SHA + "/opt/../node"), text(SHA + "/opt/node\n"), Uint8Array.of(...text(SHA), 0x2f, 0xff), text(SHA + "/" + "x".repeat(4095))]) {
    expect(() => decodeRuntimeProbeRequest(bytes)).toThrow();
  }
});


it("reports a build in Rust's layout, how a probe failed, or that a save ended it", () => {
  const build = { version: "v24.11.0", node: "24.11.0", uv: "1.51.0", napi: "10", bun: "", config: CONFIG };
  const layout = new Writer().u8(0);
  for (const field of [build.version, build.node, build.uv, build.napi, build.bun]) layout.raw(Uint8Array.of(field.length, 0)).raw(text(field));
  layout.u32(text(CONFIG).byteLength).raw(text(CONFIG));
  expect(encodeRuntimeProbeReport(SHA, { kind: "build", build })).toEqual(command(12, Uint8Array.of(...text(SHA), ...layout.finish())));
  expect(encodeRuntimeProbeReport(SHA, { kind: "failed", detail: "exit 1" })).toEqual(command(12, Uint8Array.of(...text(SHA), 1, 6, ...text("exit 1"))));
  expect(encodeRuntimeProbeReport(SHA, { kind: "cancelled" })).toEqual(command(12, Uint8Array.of(...text(SHA), 2)));
  expect(() => encodeRuntimeProbeReport("x", { kind: "cancelled" })).toThrow();
});

it("reads the probe's six lines and names every other ending", () => {
  const exited = { kind: "exit", code: 0 } as const;
  expect(parseRuntimeProbeOutput(output(["v24.11.0", "24.11.0", "1.51.0", "10", "", CONFIG]), exited)).toEqual({ kind: "build", build: { version: "v24.11.0", node: "24.11.0", uv: "1.51.0", napi: "10", bun: "", config: CONFIG } });
  expect(parseRuntimeProbeOutput(output(["v24.3.0", "24.3.0", "1.48.0", "10", "1.3.2", CONFIG]), exited)).toMatchObject({ kind: "build", build: { bun: "1.3.2" } });
  expect(parseRuntimeProbeOutput(output([]), { kind: "exit", code: 1 })).toEqual({ kind: "failed", detail: "exit 1" });
  expect(parseRuntimeProbeOutput(output([]), { kind: "signal", signal: 11 })).toEqual({ kind: "failed", detail: "signal 11" });
  expect(parseRuntimeProbeOutput(output([]), "timeout")).toEqual({ kind: "failed", detail: "timeout" });
  expect(parseRuntimeProbeOutput(output([]), "overflow")).toEqual({ kind: "failed", detail: "output too large" });
  for (const lines of [["v24.11.0", "24.11.0", "1.51.0", "10", ""], ["v24.11.0", "24.11.0", "1.51.0", "10", "", CONFIG, "extra"], ["v24.11.0", "24.11.0", "1.51.0", "10", "", "[1]"],
    ["v24.11.0", "24.11.0", "1.51.0", "10", "", "{nope"], ["v24.11.0", "x".repeat(65), "1.51.0", "10", "", CONFIG], ["v24.11.0\t", "24.11.0", "1.51.0", "10", "", CONFIG]]) {
    expect(parseRuntimeProbeOutput(output(lines), exited), JSON.stringify(lines)).toEqual({ kind: "failed", detail: "invalid output" });
  }
  expect(parseRuntimeProbeOutput(text("v24.11.0\n24.11.0\n1.51.0\n10\n\n" + CONFIG), exited)).toEqual({ kind: "failed", detail: "invalid output" });
  expect(parseRuntimeProbeOutput(Uint8Array.of(0xff, 0x0a), exited)).toEqual({ kind: "failed", detail: "invalid output" });
});
