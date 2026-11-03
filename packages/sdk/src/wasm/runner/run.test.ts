import { describe, expect, it } from "vitest";
import { COMMAND_DECLARATION, buildRelease, type Release } from "./fixtures.test-support.js";
import { launch, records } from "./harness.test-support.js";

const wasm = Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0);
const commandRelease = (adapter: string): Promise<Release> => buildRelease({ adapter, artifacts: { "tool.wasm": wasm }, declaration: COMMAND_DECLARATION });

describe("the runner's files (ADR 0028)", () => {
  it("an application's start fetches nothing: its launch carries the VM's verified copies", async () => {
    const release = await commandRelease(`export default async host => {
      const module = await host.artifacts.compile("tool.wasm"), bytes = await host.artifacts.bytes("tool.wasm");
      host.log(JSON.stringify({ module: module instanceof WebAssembly.Module, bytes: bytes.length, url: host.artifacts.url("tool.wasm").startsWith("blob:") }));
      return { main: () => 0 };
    };`);
    // Every fetch other than of a copy's blob: URL is recorded and fails: nothing the runner does may reach a server.
    const running = launch({ release, args: [] });
    expect(running.fetched).toEqual([]);
    await expect(running.done).resolves.toBe(0);
    expect(running.fetched).toEqual([]);
    expect(running.linux.stderrLines).toEqual(['{"module":true,"bytes":8,"url":true}']);
  });

  it("refuses a start whose copies are not the description's files, before any module code runs", async () => {
    const release = await commandRelease("export default () => ({ main: () => 0 });");
    const short: Release = { ...release, served: new Map([...release.served].map(([url, bytes]) => [url, url.endsWith("tool.wasm") ? bytes.slice(0, 4) : bytes])) };
    const running = launch({ release: short });
    await expect(running.done).resolves.toBe(120);
    expect(records(running.linux.stderrLines)).toEqual([{ oxidevm: "error", v: 1, kind: "launch", message: "The verified copies of the module's files do not match its launch description" }]);
    expect([running.imports.count, running.fetched]).toEqual([0, []]);
  });

  it("refuses a start without its launch", async () => {
    const release = await commandRelease("export default () => ({ main: () => 0 });");
    const running = launch({ release, argument: null });
    await expect(running.done).resolves.toBe(120);
    expect(records(running.linux.stderrLines)[0]).toMatchObject({ kind: "launch", message: "The module runner started without its launch" });
  });
});
