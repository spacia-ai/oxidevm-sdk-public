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
void [context, pipe, terminal, descriptor, invalidSystemKey];
