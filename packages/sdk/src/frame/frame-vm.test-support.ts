import { vi } from "vitest";
import type {
  SystemSnapshots, SystemStart, SystemVM, ListeningPort, PipeSpawnSpec, ProcessExit, ProcessHandle, SnapshotInfo, TerminalHandle, TerminalSpawnSpec, VM, VMNetwork,
  Workspace, WorkspaceChange, WorkspaceFileEntry, WorkspaceWatch,
} from "../contracts.js";
import { VMError } from "../runtime/errors.js";
import { decodeSHA256, decodeProcessId } from "../values.js";
import { decodePublicVMOptions } from "../vm-options.js";
import { connectFrameVM } from "./client/frame-vm.js";
import { decodeFrameOptions } from "./protocol/options.js";
import { serveFrame } from "./host/server.js";

// A fake frame VM and an in-memory page/frame connection for the runtime frame tests.

export const PAGE = "https://app.example.test/editor/";
export const snapshot: SnapshotInfo = {
  mode: "system", ref: { id: "3f1b5f7e-6a1d-4c2b-9e5f-2a7f0d9c1b3e", createdAt: "2026-10-09T10:00:00.000Z" }, kind: "named", label: "before", capturedAtUnixMs: 1, profile: null, bytes: { ram: 1, disk: 2, unique: 3 }, resumable: true };
const channels: MessageChannel[] = [];

/** Closes every channel a test connected; call it from `afterEach`. */
export function closeChannels(): void {
  for (const channel of channels.splice(0)) { channel.port1.close(); channel.port2.close(); }
}

/** A guest process whose output comes from `chunks` (pulled lazily) and whose stdin is echoed into `received`. */
export function fakeProcess(chunks: readonly Uint8Array[], terminal: boolean, pulls: { count: number }, received: Uint8Array[] = []): ProcessHandle | TerminalHandle {
  let index = 0;
  const exit = Promise.withResolvers<ProcessExit>();
  const output = new ReadableStream<Uint8Array>({
    pull: controller => {
      const next = chunks[index++];
      if (next === undefined) { controller.close(); exit.resolve({ kind: "exited", code: 0 }); return; }
      pulls.count += next.byteLength;
      controller.enqueue(next);
    },
  }, { highWaterMark: 0 });
  const stdin = new WritableStream<Uint8Array>({ write: chunk => { received.push(chunk); } });
  const common = { pid: decodeProcessId(42), stdin, exit: exit.promise, kill: vi.fn(() => Promise.resolve()) };
  if (terminal) return { ...common, kind: "terminal", output, resize: vi.fn(() => Promise.resolve()), interrupt: vi.fn(() => Promise.resolve()) };
  return { ...common, kind: "process", stdout: output, stderr: new ReadableStream<Uint8Array>({ start: controller => controller.close() }) };
}

/** A watch the fake workspace holds: tests emit changes to it, read its directories, or fail it. */
export interface FakeWatch {
  readonly directories: (readonly string[])[];
  emit(changes: readonly WorkspaceChange[]): void;
  fail(error: Error): void;
  readonly ended: Promise<void>;
}

/**
 * An in-memory workspace with versioned files and directories. `/slow` never answers until its
 * request is aborted; each write bumps the file's version.
 */
export function fakeWorkspace() {
  const files = new Map<string, { readonly data: Uint8Array; readonly version: string }>();
  const directories = new Set<string>(["/"]);
  const watches: FakeWatch[] = [];
  let versions = 0;
  const notFound = () => new VMError("STORAGE_NOT_FOUND", "no such file");
  const slow = <T>(signal: AbortSignal | undefined) => new Promise<T>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new VMError("ABORTED", "aborted")), { once: true });
  });
  const name = (path: string) => path.split("/").at(-1) ?? "";
  const parent = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
  const entry = (path: string): WorkspaceFileEntry => {
    const file = files.get(path);
    if (file !== undefined) return { kind: "file", link: null, name: name(path), path, size: file.data.byteLength, version: file.version };
    if (directories.has(path)) return { kind: "directory", link: null, name: path === "/" ? "" : name(path), path, size: 0, version: "f".repeat(48) };
    throw notFound();
  };
  const workspace = {
    id: "ws", persistence: { kind: "persistent", backend: "opfs", browserRetention: "best-effort" },
    readFile: (path: string, signal?: AbortSignal) => {
      if (path === "/slow") return slow<Uint8Array>(signal);
      const file = files.get(path); return file === undefined ? Promise.reject(notFound()) : Promise.resolve(file.data);
    },
    readText: (path: string) => { const file = files.get(path); return file === undefined ? Promise.reject(notFound()) : Promise.resolve(new TextDecoder().decode(file.data)); },
    writeFile: async (path: string, data: Uint8Array) => { await workspace.write(path, data); },
    writeText: async (path: string, data: string) => { await workspace.write(path, new TextEncoder().encode(data)); },
    list: () => Promise.resolve([...files.keys()].map(path => ({ kind: "file" as const, name: name(path), path }))),
    remove: (path: string) => { files.delete(path); return Promise.resolve(); },
    entries: (path = "/") => Promise.resolve([...directories, ...files.keys()].filter(child => child !== "/" && parent(child) === path).sort().map(entry)),
    stat: (path: string, signal?: AbortSignal) => path === "/slow" ? slow<WorkspaceFileEntry>(signal) : Promise.resolve().then(() => entry(path)),
    read: async (path: string, options: { readonly maxBytes?: number; readonly signal?: AbortSignal } = {}) => {
      if (path === "/slow") return slow<{ entry: WorkspaceFileEntry; data: Uint8Array }>(options.signal);
      const found = entry(path);
      const file = files.get(path);
      if (file === undefined) throw new VMError("STORAGE_ERROR", "not a file", { reason: "not-a-file" });
      if (file.data.byteLength > (options.maxBytes ?? 16 * 1024 ** 2)) throw new VMError("STORAGE_ERROR", "File exceeds the read limit", { reason: "too-large", size: file.data.byteLength });
      return { entry: { ...found, cachedByFake: true }, data: file.data };
    },
    write: (path: string, data: Uint8Array, options: { readonly ifVersion?: string | null; readonly signal?: AbortSignal } = {}) => {
      const current = files.get(path);
      if (options.ifVersion === null && current !== undefined) return Promise.reject(new VMError("STORAGE_ERROR", "File exists", { reason: "exists" }));
      if (typeof options.ifVersion === "string" && current?.version !== options.ifVersion) return Promise.reject(new VMError("STORAGE_ERROR", "File changed", { reason: "version-mismatch" }));
      files.set(path, { data, version: (++versions).toString(16).padStart(48, "0") });
      return Promise.resolve(entry(path));
    },
    createDirectory: (path: string) => { directories.add(path); return Promise.resolve(); },
    rename: (from: string, to: string) => {
      const file = files.get(from);
      if (file === undefined) return Promise.reject(notFound());
      files.delete(from); files.set(to, file); return Promise.resolve();
    },
    watch: (onChange: (changes: readonly WorkspaceChange[]) => void, options: { readonly signal: AbortSignal }): WorkspaceWatch => {
      const done = Promise.withResolvers<undefined>();
      let active = true;
      const end = (error?: Error) => { if (!active) return; active = false; if (error === undefined) done.resolve(undefined); else done.reject(error); };
      const watched: (readonly string[])[] = [];
      watches.push({ directories: watched, emit: changes => { if (active) onChange(changes); }, fail: error => end(error), ended: done.promise.catch(() => undefined) });
      if (options.signal.aborted) end(); else options.signal.addEventListener("abort", () => end(), { once: true });
      return {
        done: done.promise,
        setDirectories: paths => {
          if (!active) return Promise.reject(new VMError("ABORTED", "workspace watch has ended"));
          if (paths.length > 256) return Promise.reject(new VMError("INVALID_ARGUMENT", "at most 256 directories may be watched per VM"));
          watched.push([...paths]); return Promise.resolve();
        },
      };
    },
  } satisfies Workspace;
  return { workspace, files, watches };
}

export function fakeVM(overrides: { readonly start?: SystemStart; readonly spawn?: (spec: { readonly terminal?: unknown; readonly signal?: AbortSignal }) => ProcessHandle | TerminalHandle; readonly snapshots?: Partial<SystemSnapshots> } = {}) {
  const { workspace, files, watches } = fakeWorkspace();
  const network: VMNetwork = { state: { kind: "off" }, connect: vi.fn(() => Promise.resolve()), disconnect: vi.fn(() => Promise.resolve()), watch: (_onChange, options) => new Promise(resolve => { options.signal.addEventListener("abort", () => resolve(), { once: true }); }) };
  const snapshots: SystemSnapshots = {
    list: vi.fn(() => Promise.resolve([snapshot])), capture: vi.fn(() => Promise.resolve(snapshot)), rename: vi.fn(() => Promise.resolve(snapshot)), delete: vi.fn(() => Promise.resolve()),
    restore: vi.fn(() => Promise.reject(new VMError("SNAPSHOT_VERSION", "older format"))), usage: vi.fn(() => Promise.resolve({ referencedBytes: 1, reclaimableBytes: 0, estimate: null, persisted: null })),
    setAppData: vi.fn(() => Promise.resolve()), observe: vi.fn(), autoSave: { configure: vi.fn(() => Promise.resolve()), hint: vi.fn() },
    export: vi.fn(() => Promise.resolve({ kind: "written" as const, bytes: 0 })), inspect: vi.fn(() => Promise.reject(new VMError("INVALID_ARGUMENT", "not a backup"))), import: vi.fn(() => Promise.resolve(snapshot)),
    ...overrides.snapshots,
  };
  const pulls = { count: 0 };
  function spawn(spec: TerminalSpawnSpec): Promise<TerminalHandle>;
  function spawn(spec: PipeSpawnSpec): Promise<ProcessHandle>;
  function spawn(spec: TerminalSpawnSpec | PipeSpawnSpec): Promise<ProcessHandle | TerminalHandle> {
    return Promise.resolve(overrides.spawn?.(spec) ?? fakeProcess([new TextEncoder().encode("hello\n")], spec.terminal !== undefined, pulls));
  }
  const vm = {
    mode: "system", image: { id: "full", version: "1", mode: "system", manifestSHA256: decodeSHA256("a".repeat(64), "manifest"), cpuProfile: "x86-64-v3", signatureVerified: true, keyId: "k" },
    start: overrides.start ?? { kind: "booted", reason: "first-start" },
    workspace,
    network,
    capabilities: { previews: { available: false, reason: "not-configured" }, snapshots: { available: true }, maximumVcpus: 1, commandAcceleration: { available: true }, crossOriginIsolated: true },
    license: { tier: "licensed", licenseId: "09".repeat(16), licensee: "Learning lab", commercial: false, validity: "grace", expiresAt: 1_800_000_000, validUntil: 1_800_604_800, selfHost: false, telemetry: true },
    exec: () => Promise.reject(new VMError("PROTOCOL_ERROR", "the frame never runs exec itself")),
    spawn,
    exposePort: () => Promise.reject(new VMError("FEATURE_NOT_AVAILABLE", "previews are not configured", { reason: "not-configured" })),
    listeningPorts: () => Promise.resolve([]),
    watchListeningPorts: (listener: (ports: readonly ListeningPort[]) => void, options: { readonly signal: AbortSignal }) => {
      listener([{ port: 3000, address: "0.0.0.0", program: "node", previewable: true }]);
      return new Promise<void>(resolve => { options.signal.addEventListener("abort", () => resolve(), { once: true }); });
    },
    allowWorkspaceHandoff:vi.fn<VM["allowWorkspaceHandoff"]>((_listener,{signal})=>new Promise(resolve=>{if(signal.aborted)resolve();else signal.addEventListener("abort",()=>resolve(),{once:true});})),
    dispose: vi.fn(() => Promise.resolve()),
    snapshots,
    checkForUpdate: vi.fn(() => Promise.resolve(null)),
    prepareImage: vi.fn(() => Promise.resolve()),
    suspend: vi.fn(() => Promise.resolve(snapshot)),
  } satisfies SystemVM;
  return { vm, files, pulls, watches };
}

export async function connect(vm: VM, onProgress?: (phase: string) => void) {
  const channel = new MessageChannel();
  channels.push(channel);
  const created: unknown[] = [];
  const disposed = vi.fn();
  serveFrame(channel.port2, {
    embedderOrigin: new URL(PAGE).origin,
    eraseLocalData: () => Promise.resolve(),
    create: (options, _signal, progress) => {
      created.push(decodeFrameOptions(options, "/oxidevm/runtime/"));
      progress({ phase: "validate" });
      return Promise.resolve(vm);
    },
    onDisposed: disposed,
  });
  const release = vi.fn();
  const options = decodePublicVMOptions({ mode: vm.mode, workspaceId: "ws", runtime: { hosting: "frame" }, ...(onProgress === undefined ? {} : { onProgress: (progress: { readonly phase: string }) => onProgress(progress.phase) }) });
  const client = await connectFrameVM(channel.port1, options, PAGE, release);
  return { client, created, release, disposed, channel };
}

export async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  let text = "";
  const decoder = new TextDecoder();
  for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
  return text;
}

export async function rejection(promise: Promise<unknown>): Promise<VMError> {
  try { await promise; } catch (error) { if (error instanceof VMError) return error; throw error; }
  throw new Error("expected a rejection");
}
