import type { Stdio, Terminals } from "../../define.js";
import { WASI, type WasiErrno } from "./errno.js";
import { LINUX, type WasiHost } from "./host.js";
import { LIMITS } from "./limits.js";
import type { GuestMemory } from "./memory.js";
import { WasiContext } from "./context.js";
import { DescriptorTable } from "./descriptors.js";
import { directoryFunctions } from "./directories.js";
import { descriptorFunctions } from "./fd.js";
import { PREVIEW1_IMPORTS, type Preview1Name } from "./imports.js";
import { launchFunctions, type Launch } from "./launch.js";
import { pathFunctions } from "./paths.js";
import { ALL_RIGHTS, MUTATING_RIGHTS, RIGHT } from "./rights.js";
import { filetypeOf, streamRights } from "./stat.js";
import { streams } from "./streams.js";
import { timeFunctions } from "./time.js";

export { encodeLaunch, LaunchError, ProcExit, type Launch } from "./launch.js";

/** A directory the program is given: `guest` is the name it sees, `host` the VM path. */
export interface Preopen { readonly guest: string; readonly host: string; readonly readOnly: boolean }
/**
 * The default grant: the VM's whole tree, under the process's own Linux credentials, exactly what a native program
 * of the caller has. Only a preopen other than `/` is confined (RESOLVE_BENEATH).
 */
export const ROOT_PREOPEN: Preopen = Object.freeze({ guest: "/", host: "/", readOnly: false });

type ImportFunction = (...args: never[]) => number;

/** What each Preview1 function not served by a module returns: the disposition table's explicit error. */
const PENDING: Readonly<Partial<Record<Preview1Name, WasiErrno>>> = {
  sock_accept: WASI.badf, sock_recv: WASI.badf, sock_send: WASI.badf, sock_shutdown: WASI.badf,
};

/** Directory rights a preopen carries itself; it hands everything (minus mutation when read-only) to what it opens. */
const DIRECTORY_RIGHTS = ALL_RIGHTS & ~(RIGHT.fdRead | RIGHT.fdWrite | RIGHT.fdSeek | RIGHT.fdTell | RIGHT.fdAdvise | RIGHT.fdAllocate | RIGHT.sockShutdown);

export interface Run {
  readonly imports: Readonly<Record<string, ImportFunction>>;
  readonly table: DescriptorTable;
  readonly context: WasiContext;
}

/**
 * The wasi_snapshot_preview1 import object for one run, with its descriptor table: the three standard streams at 0-2
 * (rights from Linux: a terminal, pipe or socket cannot seek), then the preopens at 3 onward as held O_PATH directory
 * descriptors.
 */
export function preview1(host: WasiHost, memory: () => GuestMemory, stdio: Stdio, launch: Launch, terminals: Terminals, preopens: readonly Preopen[] = [ROOT_PREOPEN]): Run {
  const table = new DescriptorTable(LIMITS.descriptors, fd => { host.fs.close(fd); });
  const context = new WasiContext(host, memory, table);
  const streamsOf = [[stdio.stdin, terminals.stdin], [stdio.stdout, terminals.stdout], [stdio.stderr, terminals.stderr]] as const;
  streamsOf.forEach(([fd, terminal], index) => {
    let type = 0;
    try { type = filetypeOf(host.fs.fstat(fd).mode); } catch { /* a closed stream keeps the rights of a pipe */ }
    const rights = streamRights(type, terminal);
    table.place(index, { kind: "stream", host: fd, terminal, base: rights, inheriting: 0n, owned: false, confined: false });
  });
  const at = host.at;
  if (at !== undefined) {
    preopens.forEach((preopen, index) => {
      const fd = at.openat(at.cwd, preopen.host, LINUX.O_PATH | LINUX.O_DIRECTORY | LINUX.O_CLOEXEC, 0);
      const mask = preopen.readOnly ? ~MUTATING_RIGHTS : ALL_RIGHTS;
      table.place(3 + index, {
        kind: "preopen", host: fd, name: new TextEncoder().encode(preopen.guest), base: DIRECTORY_RIGHTS & mask, inheriting: ALL_RIGHTS & mask,
        owned: true, confined: preopen.host !== "/", readOnly: preopen.readOnly,
      });
    });
  }
  const served: Readonly<Record<string, ImportFunction>> = {
    ...launchFunctions(memory, launch, body => context.guarded(body)),
    ...streams(context), ...descriptorFunctions(context), ...pathFunctions(context), ...directoryFunctions(context), ...timeFunctions(context),
  };
  return { imports: Object.fromEntries(PREVIEW1_IMPORTS.map(name => [name, served[name] ?? (() => PENDING[name] ?? WASI.nosys)])), table, context };
}
