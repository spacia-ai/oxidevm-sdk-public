import type { FileDescriptor, LinuxFileStat } from "../../js-process-types.js";
import { VMError } from "../../runtime/errors.js";
import type { Connection } from "../define.js";
import { linuxErrno } from "../kit/errno.js";
import type { EndpointDecl } from "../manifest-types.js";
import type { ServiceRun } from "./hooks.js";
import type { LinuxParts } from "./host.js";
import { ModuleFailure, settledWithin, withDeadline } from "./failure.js";

export const DEFAULT_CLIENTS = 4;
/** How long handlers may finish after a stop request, and how long after they are cancelled. */
export const DRAIN_MS = 5000;
export const FORCE_MS = 1000;
/** How long the adapter's `close` hook may run. */
export const CLOSE_MS = 10_000;
const ENOENT = 2, EADDRINUSE = 98, ECONNREFUSED = 111;
const S_IFMT = 0o170000, S_IFSOCK = 0o140000;
/**
 * Accept failures that concern one connection or a moment, not the listener: the connection was aborted, the call was
 * interrupted, or the process or system is short of descriptors or memory. The service logs them and goes on.
 */
const TRANSIENT_ACCEPT = new Set([4, 11, 12, 23, 24, 71, 103, 105]);
const ACCEPT_RETRY_MS = 100;
const SOCKET_DIRECTORY = "/workspace/_oxidevm";

export interface ServiceInputs {
  readonly linux: LinuxParts;
  readonly endpoints: Readonly<Record<string, EndpointDecl>>;
  readonly maxClients: number;
  readonly run: ServiceRun;
  /** Aborted when the stop request arrives, before connections drain. */
  readonly lifecycle: AbortController;
  readonly log: (line: string) => void;
  /** Called once every endpoint is listening; the ready line goes out here. */
  readonly ready: (info: Readonly<Record<string, string | number | boolean>>) => Promise<void>;
}

function isInfo(value: unknown): value is Readonly<Record<string, string | number | boolean>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.values(value).every(entry => typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean");
}

/** One listening endpoint. A Unix socket also records which file it bound, to recognise it again at stop. */
interface Listener {
  readonly fd: FileDescriptor;
  readonly path?: string;
  readonly identity?: { readonly device: bigint; readonly inode: bigint };
}

async function lstatOrAbsent(linux: LinuxParts, path: string): Promise<LinuxFileStat | undefined> {
  try { return await linux.files.lstat(path); } catch (error: unknown) {
    if (linuxErrno(error) === ENOENT) return undefined;
    throw error;
  }
}

/** Whether some process still accepts connections on the Unix socket at `path`: a file may outlive the process that bound it. */
async function acceptsConnections(sockets: LinuxParts["sockets"], path: string): Promise<boolean> {
  const fd = await sockets.socket("unix");
  try {
    await sockets.connect(fd, { family: "unix", path });
    return true;
  } catch (error: unknown) {
    const errno = linuxErrno(error);
    if (errno === ECONNREFUSED || errno === ENOENT) return false;
    throw error;
  } finally { await sockets.close(fd).catch(() => undefined); }
}

/**
 * Binds and listens on one endpoint. A Unix socket file left by an earlier run (nothing accepts on it) is replaced; a file
 * that is not a socket, or a socket somebody still listens on, is never touched.
 */
async function listen(linux: LinuxParts, name: string, endpoint: EndpointDecl, backlog: number): Promise<Listener> {
  const { sockets, files, filesSync } = linux;
  if (endpoint.kind === "unix") {
    if (endpoint.path.startsWith(`${SOCKET_DIRECTORY}/`)) {
      try { filesSync.mkdir(SOCKET_DIRECTORY, 0o755); } catch (error: unknown) { if (linuxErrno(error) !== 17) throw error; }
    }
    const existing = await lstatOrAbsent(linux, endpoint.path);
    if (existing !== undefined) {
      if ((existing.mode & S_IFMT) !== S_IFSOCK) throw new ModuleFailure("launch", `${endpoint.path} exists and is not a socket, so the module will not replace it`);
      if (await acceptsConnections(sockets, endpoint.path)) throw new ModuleFailure("busy", `Endpoint ${name} is already in use`);
      try { await files.unlink(endpoint.path); } catch (error: unknown) { if (linuxErrno(error) !== ENOENT) throw error; }
    }
  }
  const fd = await sockets.socket(endpoint.kind === "unix" ? "unix" : "ipv4");
  try {
    await sockets.bind(fd, endpoint.kind === "unix" ? { family: "unix", path: endpoint.path } : { family: "ipv4", address: "127.0.0.1", port: endpoint.port });
    await sockets.listen(fd, backlog);
  } catch (error: unknown) {
    await sockets.close(fd).catch(() => undefined);
    if (linuxErrno(error) === EADDRINUSE) throw new ModuleFailure("busy", `Endpoint ${name} is already in use`);
    throw error;
  }
  if (endpoint.kind !== "unix") return { fd };
  const made = await lstatOrAbsent(linux, endpoint.path);
  return made === undefined ? { fd, path: endpoint.path } : { fd, path: endpoint.path, identity: { device: made.device, inode: made.inode } };
}

/** Removes the socket file this process bound, and only that file: another process may have put its own at the same path. */
async function removeOwnSocket(linux: LinuxParts, listener: Listener): Promise<void> {
  if (listener.path === undefined || listener.identity === undefined) return;
  const current = await lstatOrAbsent(linux, listener.path);
  if (current === undefined || (current.mode & S_IFMT) !== S_IFSOCK || current.device !== listener.identity.device || current.inode !== listener.identity.inode) return;
  await linux.files.unlink(listener.path);
}

/** Waits `milliseconds`, or less if the signal aborts first. */
function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Runs a service until its standard input ends: listens on every declared endpoint, serves up to
 * `maxClients` connections at once (extra connections are closed at once). On stop it closes the
 * listeners and every connection that is only waiting for its peer, gives working connections a few
 * seconds, cancels the rest and closes the adapter.
 */
export async function runService(inputs: ServiceInputs): Promise<void> {
  const { linux, run, lifecycle } = inputs;
  const { sockets, files } = linux;
  /** Each live connection: its cancellation, whether its handler is waiting for the peer, and the task serving it. */
  const clients = new Map<AbortController, { readonly task: Promise<void>; readonly idle: () => boolean }>();
  const listeners: Listener[] = [];
  const failure = Promise.withResolvers<never>();
  failure.promise.catch(() => undefined);
  const loops: Promise<void>[] = [];
  let stopping = false;

  function serve(fd: FileDescriptor, handler: (connection: Connection) => Promise<void>): void {
    const controller = new AbortController();
    let waiting = false;
    const connection: Connection = {
      fd,
      signal: controller.signal,
      read: async maxBytes => {
        // Once the module is stopping, a handler that goes back to waiting for its peer is idle: end it now.
        if (stopping) throw new VMError("ABORTED", "The module is stopping");
        waiting = true;
        try { return await sockets.read(fd, maxBytes, { signal: controller.signal }); } finally { waiting = false; }
      },
      // A client that hangs up mid-reply must be an EPIPE error for this handler, not a SIGPIPE that ends the whole module.
      write: bytes => files.writeAll(fd, bytes, { signal: controller.signal, noSignal: true }),
    };
    async function drive(): Promise<void> {
      try { await handler(connection); }
      catch (error: unknown) { if (!stopping) inputs.log(`connection handler failed: ${error instanceof Error ? error.message : "unknown error"}`); }
      finally { controller.abort(); clients.delete(controller); await sockets.close(fd).catch(() => undefined); }
    }
    clients.set(controller, { task: drive(), idle: () => waiting });
  }

  async function acceptLoop(listener: FileDescriptor, handler: (connection: Connection) => Promise<void>): Promise<void> {
    for (;;) {
      let fd: FileDescriptor;
      try { fd = await sockets.accept(listener, { signal: lifecycle.signal }); }
      catch (error: unknown) {
        if (stopping) return;
        const errno = linuxErrno(error);
        if (errno === undefined || !TRANSIENT_ACCEPT.has(errno)) throw error;
        inputs.log(`accept failed (errno ${String(errno)}); trying again`);
        await pause(ACCEPT_RETRY_MS, lifecycle.signal);
        continue;
      }
      if (clients.size >= inputs.maxClients) { await sockets.close(fd).catch(() => undefined); continue; }
      serve(fd, handler);
    }
  }

  async function waitForStop(): Promise<void> {
    for (;;) {
      const bytes = await files.read(linux.stdin, 4096, { signal: lifecycle.signal });
      if (bytes.length === 0) return;
    }
  }

  try {
    for (const [name, endpoint] of Object.entries(inputs.endpoints)) {
      const handler = run.handlers.get(name);
      if (handler === undefined) throw new ModuleFailure("adapter", `The adapter has no handler for ${name}`);
      listeners.push(await listen(linux, name, endpoint, inputs.maxClients));
      const listener = listeners[listeners.length - 1];
      if (listener !== undefined) loops.push(acceptLoop(listener.fd, handler).catch((error: unknown) => { failure.reject(error); }));
    }
    const info = await run.info();
    if (info !== undefined && !isInfo(info)) throw new ModuleFailure("adapter", "adapter.info must return an object of strings, numbers and booleans");
    await inputs.ready(info ?? {});
    await Promise.race([waitForStop(), failure.promise]);
  } finally {
    stopping = true;
    lifecycle.abort();
    await Promise.allSettled(listeners.map(async listener => sockets.close(listener.fd)));
    await Promise.allSettled(listeners.map(listener => removeOwnSocket(linux, listener)));
    await Promise.allSettled(loops);
    const tasks = () => Promise.allSettled([...clients.values()].map(client => client.task));
    // Connections waiting for their peer have no request to finish; the others get a few seconds.
    for (const [controller, client] of clients) if (client.idle()) controller.abort(new VMError("ABORTED", "The module is stopping"));
    await settledWithin(tasks(), DRAIN_MS);
    for (const controller of clients.keys()) controller.abort(new VMError("ABORTED", "The module is stopping"));
    await settledWithin(tasks(), FORCE_MS);
    try { await withDeadline(run.close(), CLOSE_MS, "adapter.close"); } catch (error: unknown) { inputs.log(`adapter.close failed: ${error instanceof Error ? error.message : "unknown error"}`); }
  }
}
