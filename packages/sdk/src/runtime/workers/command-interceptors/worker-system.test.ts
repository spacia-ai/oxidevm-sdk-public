import { expect, it } from "vitest";
import { TYPESCRIPT } from "../../command-interceptor-identity.js";
import { resolveCompilerEntry } from "./worker-system.js";

const bun = "/workspace/node_modules/.bun/typescript@6.0.2/node_modules/typescript/bin/tsc";
const pnpm = "/workspace/node_modules/.pnpm/typescript@6.0.2/node_modules/typescript/bin/tsc";
const commandLine = (entry: string, flag = "--noEmit") => new TextEncoder().encode(`/usr/bin/node\0${entry}\0${flag}\0`);

it("admits exactly the managed Bun and pnpm compiler placements", () => {
  expect(TYPESCRIPT.entries).toEqual([bun, pnpm]);
  for (const entry of [bun, pnpm]) {
    expect(resolveCompilerEntry(commandLine(entry), path => path)).toBe(entry);
  }
});

it("uses the process command line and resolves its actual compiler symlink", () => {
  expect(resolveCompilerEntry(commandLine("/workspace/node_modules/typescript/bin/tsc"), path => {
    expect(path).toBe("/workspace/node_modules/typescript/bin/tsc");
    return pnpm;
  })).toBe(pnpm);
});

it("rejects unrelated compilers, versions, arguments and malformed command lines", () => {
  for (const bytes of [commandLine("/tmp/tsc"), commandLine(pnpm.replace("6.0.2", "6.0.3")), commandLine(pnpm, "--version"), commandLine(pnpm).subarray(0, -1), new Uint8Array()]) {
    expect(() => resolveCompilerEntry(bytes, path => path)).toThrow();
  }
});
