import { serveProcess, type LinuxProcessContext, type FileDescriptor } from "@oxidevm/sdk/js-process";
import type { UserspaceVM, SystemVM, ProcessHandle, TerminalHandle } from "@oxidevm/sdk";

serveProcess(() => {});
serveProcess(async () => {});
function namedProgram(): void {}
async function namedAsyncProgram(): Promise<void> { await Promise.resolve(); }
serveProcess(namedProgram);
serveProcess(namedAsyncProgram);
serveProcess(async context => {
  await context.files.writeFile("/workspace/example", new Uint8Array());
  return 0;
});
declare const vm: UserspaceVM;
declare const context: LinuxProcessContext;
const pipe: Promise<ProcessHandle> = vm.spawnJS({ worker: new URL("https://example.test/worker.js") });
const terminal: Promise<TerminalHandle> = vm.spawnJS({ worker: new URL("https://example.test/worker.js"), terminal: { columns: 80, rows: 24 } });
// @ts-expect-error Only Userspace admits this experimental process surface.
const invalidSystemKey: keyof SystemVM = "spawnJS";
// @ts-expect-error Descriptor identities cannot come from unchecked numbers.
const descriptor: FileDescriptor = 3;
const changed: Promise<void> = context.files.chmod("/workspace/example", 0o640);
const resized: Promise<void> = context.files.truncate("/workspace/example", 1n);
const linked: Promise<void> = context.files.symlink("example", "/workspace/example.link");
const target: string = context.filesSync.readlink("/workspace/example.link");
// @ts-expect-error A raw number is not a descriptor; open or dup one instead.
context.filesSync.fchmod(3, 0o600);
void [context, pipe, terminal, descriptor, invalidSystemKey, changed, resized, linked, target];
