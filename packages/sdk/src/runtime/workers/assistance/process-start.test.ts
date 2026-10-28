import { expect, it } from "vitest";
import { decodeProcessStart } from "./process-start.js";
import { createMailbox } from "./mailbox.js";

it("admits only the bound startup and exact local mailbox/compiler artifacts", () => {
  const input = { kind: "start", identity: { session: "11111111-2222-4333-8444-555555555555", generation: 1, process: 1, sequence: 1 },
    entry: "/workspace/main.cjs", cwd: "/workspace", args: ["value"], env: { TEST: "yes" },
    buffer: createMailbox(), httpParserModule: new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0)), nextCompilerModule: new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0)), compilerModule: new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0)) };
  expect(decodeProcessStart(input)).toEqual(input);
  const dependencies = { generation: "a".repeat(64), inputsSha256: "b".repeat(64) };
  expect(decodeProcessStart({ ...input, dependencies })).toEqual({ ...input, dependencies });
  for (const invalid of [{ ...dependencies, generation: "A".repeat(64) }, { generation: dependencies.generation }, { ...dependencies, root: "/" }]) {
    expect(() => decodeProcessStart({ ...input, dependencies: invalid })).toThrow();
  }
  expect(() => decodeProcessStart({ ...input, buffer: new SharedArrayBuffer(16) })).toThrow();
  expect(() => decodeProcessStart({ ...input, compilerModule: {} })).toThrow();
  expect(() => decodeProcessStart({ ...input, nextCompilerModule: {} })).toThrow();
  expect(() => decodeProcessStart({ ...input, httpParserModule: {} })).toThrow();
  expect(() => decodeProcessStart({ ...input, httpParserModule: undefined })).toThrow();
  expect(() => decodeProcessStart({ ...input, source: "forged" })).toThrow();
});

it("validates the broker-reserved process transport window", () => {
  const input = { kind: "start", identity: { session: "11111111-2222-4333-8444-555555555555", generation: 1, process: 1, sequence: 2 },
    entry: "/workspace/a.cjs", cwd: "/workspace", args: [], env: {}, trafficBytes: 512 * 1024,
    buffer: createMailbox(), httpParserModule: new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0)), nextCompilerModule: new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0)), compilerModule: new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0)) };
  expect(decodeProcessStart(input)).toEqual(input);
  for (const trafficBytes of [0, -1, 1.5, 1024 * 1024 + 1]) expect(() => decodeProcessStart({ ...input, trafficBytes })).toThrow();
});

it("admits a fork child only with its parent and private IPC port together", () => {
  const input = { kind: "start", identity: { session: "11111111-2222-4333-8444-555555555555", generation: 1, process: 2, sequence: 2 },
    entry: "/workspace/child.cjs", cwd: "/workspace", args: [], env: {},
    buffer: createMailbox(), httpParserModule: new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0)), nextCompilerModule: new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0)), compilerModule: new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0)) };
  const { port1 } = new MessageChannel();
  try {
    const child = { ...input, parent: 1, silent: true, ipc: port1 };
    expect(decodeProcessStart(child)).toEqual(child);
    // Next forks its start-server with NODE_OPTIONS-derived execArgv; the bootstrap carries it to the child runtime.
    const sourceMapped = { ...child, execArgv: ["--enable-source-maps"] };
    expect(decodeProcessStart(sourceMapped)).toEqual(sourceMapped);
    expect(() => decodeProcessStart({ ...input, execArgv: ["--enable-source-maps"] })).toThrow();
    expect(() => decodeProcessStart({ ...child, execArgv: ["--inspect"] })).toThrow();
    expect(() => decodeProcessStart({ ...input, parent: 1 })).toThrow();
    expect(() => decodeProcessStart({ ...input, ipc: port1 })).toThrow();
    expect(() => decodeProcessStart({ ...input, parent: 2, ipc: port1 })).toThrow();
    expect(() => decodeProcessStart({ ...input, parent: 1, ipc: {} })).toThrow();
  } finally { port1.close(); }
});
