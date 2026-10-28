import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runTool } from "./tools.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it("bounds a tool's execution time and retires its owned descendants", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oxidevm-tool-")); directories.push(directory);
  const marker = join(directory, "orphan-output");
  const child = join(directory, "child.mjs");
  await writeFile(child, `import {writeFileSync} from 'node:fs'; setTimeout(()=>writeFileSync(${JSON.stringify(marker)},'orphan'),500);`);
  const parent = join(directory, "parent.mjs");
  await writeFile(parent, `import {spawn} from 'node:child_process'; spawn(process.execPath,[${JSON.stringify(child)}],{stdio:'inherit'}); setInterval(()=>{},1000);`);
  await expect(runTool(process.execPath, [parent], { timeoutMs: 150, signal: AbortSignal.timeout(1500) })).rejects.toMatchObject({ code: "STORAGE_ERROR", detail: { reason: "tool-timeout" } });
  await new Promise(resolve => setTimeout(resolve, 600));
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
});

it("bounds combined output and rejects without retaining private tool text", async () => {
  const script = "process.stderr.write('test-private-canary'); process.stdout.write('x'.repeat(8192)); setInterval(()=>{},1000)";
  await expect(runTool(process.execPath, ["-e", script], { maxOutputBytes: 4096, signal: AbortSignal.timeout(1500) })).rejects.toMatchObject({ code: "STORAGE_ERROR", detail: { reason: "tool-output-limit" } });
});

it("reports tool failures without stdout, stderr, arguments or environment values", async () => {
  await expect(runTool(process.execPath, ["-e", "console.error('test-private-canary');process.exit(7)"])).rejects.toMatchObject({ code: "STORAGE_ERROR", message: `${process.execPath} failed; check the build inputs`, detail: { tool: process.execPath, exitCode: 7 } });
});

it("preserves successful stdout and rejects an already canceled operation before execution", async () => {
  expect(await runTool(process.execPath, ["-e", "console.log('actual stdout')"])).toBe("actual stdout");
  await expect(runTool(process.execPath, ["-e", "process.exit(0)"], { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "ABORTED" });
});

it("distinguishes a missing executable from a running tool that is canceled", async () => {
  await expect(runTool("oxidevm-not-installed-7a11", [])).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE" });
  await expect(runTool(process.execPath, ["-e", "setInterval(()=>{},1000)"], { signal: AbortSignal.timeout(100) })).rejects.toMatchObject({ code: "ABORTED" });
});
