import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMAND_DECLARATION, buildRelease, type Release } from "./fixtures.test-support.js";
import { launch, records } from "./harness.test-support.js";

const wasm = Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0);
const script = new TextEncoder().encode("print('hello from the module')\n");
const TARGET = "/workspace/_oxidevm/py/client.py";
const TEMPORARY = new RegExp(`^${TARGET.replaceAll(".", "\\.")}\\.[0-9a-f]{32}\\.tmp$`, "u");

function release(guestFiles: readonly { readonly artifact: string; readonly to: string; readonly mode?: number }[] = [{ artifact: "client.py", to: TARGET, mode: 0o640 }]): Promise<Release> {
  return buildRelease({ adapter: "export default () => ({ main: () => 0 });", artifacts: { "tool.wasm": wasm, "client.py": script }, declaration: { ...COMMAND_DECLARATION, guestFiles } });
}
const changes = (operations: readonly string[]): string[] => operations.filter(operation => !operation.startsWith("mkdir"));

afterEach(() => { vi.unstubAllGlobals(); });

describe("guest files", () => {
  it("writes them in an opaque-origin module worker, which has crypto.getRandomValues but no randomUUID or subtle", async () => {
    const built = await release();
    // Chromium's workers of an opaque origin are not secure contexts (engine ADR 0028, WebCrypto).
    const random = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: (array: Uint8Array<ArrayBuffer>) => random.getRandomValues(array) });
    const running = launch({ release: built });
    await expect(running.done).resolves.toBe(0);
    expect(running.linux.written.get(TARGET)).toMatchObject({ bytes: script, mode: 0o640 });
  });

  it("writes each declared artifact to its place with its mode, creating the directories above it", async () => {
    const running = launch({ release: await release() });
    await expect(running.done).resolves.toBe(0);
    expect(running.linux.written.get(TARGET)).toMatchObject({ bytes: script, mode: 0o640 });
    expect(running.linux.operations.filter(operation => operation.startsWith("mkdir"))).toEqual(["mkdir /workspace/_oxidevm", "mkdir /workspace/_oxidevm/py"]);
  });

  it("uses mode 0644 when none is declared", async () => {
    const running = launch({ release: await release([{ artifact: "client.py", to: TARGET }]) });
    await expect(running.done).resolves.toBe(0);
    expect(running.linux.written.get(TARGET)?.mode).toBe(0o644);
  });

  it("replaces a file atomically: a temporary sibling is written, given its mode, then renamed over the target", async () => {
    const running = launch({ release: await release() });
    await expect(running.done).resolves.toBe(0);
    const [write, chmod, rename] = changes(running.linux.operations);
    expect(changes(running.linux.operations)).toHaveLength(3);
    expect(write?.replace(/^write /u, "")).toMatch(TEMPORARY);
    const temporary = write?.replace(/^write /u, "") ?? "";
    expect(chmod).toBe(`chmod ${temporary} 640`);
    expect(rename).toBe(`rename ${temporary} -> ${TARGET}`);
    expect([...running.linux.written.keys()]).toEqual([TARGET]);
  });

  it("leaves a file alone that already holds the same bytes with the same mode", async () => {
    const running = launch({ release: await release(), existingFiles: { [TARGET]: { bytes: script, mode: 0o640 } } });
    await expect(running.done).resolves.toBe(0);
    expect(changes(running.linux.operations)).toEqual([]);
  });

  it("replaces a file whose bytes or mode differ", async () => {
    // A shorter file, a file of the same length with one byte changed, and the right bytes with the wrong mode.
    const flipped = Uint8Array.from(script);
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    for (const existing of [{ bytes: new TextEncoder().encode("old"), mode: 0o640 }, { bytes: flipped, mode: 0o640 }, { bytes: script, mode: 0o600 }]) {
      const running = launch({ release: await release(), existingFiles: { [TARGET]: existing } });
      await expect(running.done).resolves.toBe(0);
      expect(running.linux.written.get(TARGET)).toMatchObject({ bytes: script, mode: 0o640 });
      expect(changes(running.linux.operations)).toHaveLength(3);
    }
  });

  it("stops the start with a launch failure, before any module code runs, when the target is not a regular file", async () => {
    const running = launch({ release: await release(), paths: { [TARGET]: 0o040755 } });
    await expect(running.done).resolves.toBe(120);
    expect(running.imports.count).toBe(0);
    expect(running.linux.written.size).toBe(0);
    expect(records(running.linux.stderrLines)[0]).toMatchObject({ kind: "launch" });
    expect(JSON.stringify(records(running.linux.stderrLines))).toContain("not a regular file");
  });

  it("stops the start with a launch failure that names the file when the write fails", async () => {
    const running = launch({ release: await release(), writeFailure: 28 });
    await expect(running.done).resolves.toBe(120);
    expect(running.imports.count).toBe(0);
    expect(JSON.stringify(records(running.linux.stderrLines))).toContain(TARGET);
  });

  it("does nothing for a module that declares none", async () => {
    const running = launch({ release: await release([]) });
    await expect(running.done).resolves.toBe(0);
    expect(running.linux.operations).toEqual([]);
  });
});
