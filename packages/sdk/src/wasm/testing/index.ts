import { VMError } from "../../runtime/errors.js";
import type { RunnerCopies, RunnerLaunch } from "../../runtime/js-process/launch.js";
import { signalName, type SignalName } from "../../runtime/process-signals.js";
import type { Module, Terminals } from "../define.js";
import { decodeResolvedManifest } from "../manifest.js";
import type { ModuleDecl } from "../manifest-types.js";
import { dnsAnswerer } from "../net/dns-server.js";
import { handlerServer } from "../net/memory-http.js";
import { MemoryNetwork, PASS_THROUGH_TLS, VM_ADDRESS, type MemoryConnection, type MemoryServer } from "../net/memory-network.js";
import { moduleReach } from "../reach.js";
import { BROWSER_NETWORK_GLOBALS } from "../net/surface.js";
import { encodeLaunchArgument, type LaunchDescriptor } from "../runner/descriptor.js";
import type { SyncBlobReader } from "../runner/artifacts.js";
import { runModule, type RunnerContext } from "../runner/run.js";
import { fakeLinux } from "./memory-linux.js";
import { fakeSignals } from "./memory-signals.js";

/**
 * `testHost` (engine ADR 0029, N-9): runs a module definition through the SDK's real runner (`runModule`, `buildHost`)
 * against an in-memory Linux process and an in-memory VM network, so a module's unit tests exercise exactly the host,
 * option resolution, capability narrowing, errors and network reach the browser gives it. Nothing is fetched and no
 * engine runs; the network is local-only unless `net.connected` is set, and its servers are request handlers. While a
 * run lasts, the global `fetch` and `WebSocket` are the module's (as in its worker) and are restored afterwards, so runs
 * of modules that use them must not overlap.
 */
export interface TestNet {
  /** Whether the VM is connected to the internet (`vm.network.connect`); local-only by default. */
  readonly connected?: boolean;
  /**
   * Internet services by origin (`https://api.example.com`, `http://198.51.100.7:8080`), each a standard request handler.
   * Their names resolve through the VM's resolver; `https` is served without real TLS in memory.
   */
  readonly http?: Readonly<Record<string, (request: Request) => Response | Promise<Response>>>;
  /** Services inside the VM by port, at the VM's own address (`vm` in `/etc/hosts`). */
  readonly vm?: Readonly<Record<number, (request: Request) => Response | Promise<Response>>>;
  /**
   * Raw TCP services by `host:port` (a name, which resolves through the VM's resolver, or an IPv4 address), for blocking
   * clients (`host.net.connectSync`, an interpreter's own sockets): a request handler answers asynchronously, which a
   * blocking read cannot wait for here, while a TCP service answers synchronously or later on the network's clock.
   */
  readonly tcp?: Readonly<Record<string, TestTcpService>>;
  /** Unix-domain stream services by socket path in the VM, for `host.net.connectUnixSync`; served like `tcp`. */
  readonly unix?: Readonly<Record<string, TestTcpService>>;
}

/** The service's end of one connection: write, end, reset, or act later on the network's clock (`after`). */
export type TestConnection = MemoryConnection;

/**
 * A raw TCP service of `TestNet.tcp`. `data` gets each write of the client as it happens; it may answer at once with
 * `connection.write`, later with `connection.after(ms, action)`, or not at all. A blocking read waits for the answer on
 * the network's clock; a read that nothing will ever answer fails with FEATURE_NOT_AVAILABLE instead of hanging.
 */
export type TestTcpService = MemoryServer;

export interface TestHostInputs {
  /** The command's arguments after argv[0]. */
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  /** How the module was started: by the application (default) or as one of its commands from a program in the VM. */
  readonly invocation?: { readonly kind: "host" } | { readonly kind: "command"; readonly name: string; readonly argv0: string };
  readonly terminals?: Terminals;
  /** Standard input; it then reaches end of file. */
  readonly stdin?: string | Uint8Array;
  /** Regular files that exist when the module starts. */
  readonly files?: Readonly<Record<string, string | Uint8Array>>;
  /** The consumer's options, resolved against the manifest as the runner does. */
  readonly options?: Readonly<Record<string, unknown>>;
  /** The bytes of each artifact the manifest declares. */
  readonly artifacts?: Readonly<Record<string, Uint8Array>>;
  readonly net?: TestNet;
}

export interface TestRun {
  /** The exit status: the adapter's 0-119, a runner status (120-124), or 128 + the signal that ended it. */
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Every regular file at the end of the run, by path. */
  readonly files: Readonly<Record<string, Uint8Array>>;
  /** The signal the module ended by, when one did. */
  readonly signal?: SignalName;
}

export interface TestHost {
  run(): Promise<TestRun>;
}

const encoder = new TextEncoder(), decoder = new TextDecoder();
const ADAPTER = encoder.encode("// testHost runs the definition's adapter itself\n");
const NO_TERMINALS: Terminals = { stdin: false, stdout: false, stderr: false };
const NAMESERVER = "10.0.2.3";

async function sha256(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))), byte => byte.toString(16).padStart(2, "0")).join("");
}

const bytesOf = (value: string | Uint8Array): Uint8Array => typeof value === "string" ? encoder.encode(value) : value;

/** The launch description and copies a release of `definition` would have, from the artifact bytes the test supplies. */
async function release(definition: Module, inputs: TestHostInputs): Promise<{ readonly descriptor: LaunchDescriptor; readonly copies: RunnerCopies; readonly readSync: SyncBlobReader }> {
  const declared: ModuleDecl = definition.manifest, supplied = inputs.artifacts ?? {};
  const pins = await Promise.all(declared.artifacts.map(async artifact => {
    const bytes = Object.hasOwn(supplied, artifact.name) ? supplied[artifact.name] : undefined;
    if (bytes === undefined) throw new VMError("INVALID_ARGUMENT", `testHost needs the bytes of artifact ${artifact.name} in inputs.artifacts`);
    return { name: artifact.name, sha256: await sha256(bytes), bytes };
  }));
  const adapterSha = await sha256(ADAPTER);
  const manifest = decodeResolvedManifest({
    schemaVersion: 1, ...declared, adapter: { api: 1, sha256: adapterSha, bytes: ADAPTER.length },
    artifacts: pins.map(pin => ({ name: pin.name, sha256: pin.sha256, bytes: pin.bytes.length })),
  });
  const url = (name: string): string => `https://testhost.invalid/${name}`;
  const descriptor: LaunchDescriptor = {
    v: 1, manifest, release: adapterSha, adapter: { url: url("adapter.mjs"), sha256: adapterSha, bytes: ADAPTER.length },
    artifacts: Object.fromEntries(pins.map(pin => [pin.name, { url: url(pin.name), sha256: pin.sha256, bytes: pin.bytes.length }])), options: inputs.options ?? {},
  };
  const artifacts = Object.fromEntries(await Promise.all(pins.map(async pin => {
    const module = pin.name.endsWith(".wasm") ? await WebAssembly.compile(new Uint8Array(pin.bytes)).catch(() => null) : null;
    return [pin.name, { blob: new Blob([new Uint8Array(pin.bytes)]), module }] as const;
  })));
  // Node has no FileReaderSync: `host.artifacts.bytesSync` reads the bytes each copy was made from.
  const bytesOfCopy = new Map(pins.flatMap(pin => { const blob = artifacts[pin.name]?.blob; return blob === undefined ? [] : [[blob, pin.bytes] as const]; }));
  const readSync = (blob: Blob): Uint8Array<ArrayBuffer> => {
    const bytes = bytesOfCopy.get(blob);
    if (bytes === undefined) throw new VMError("INVALID_ARGUMENT", "testHost reads only the copies of the artifacts it was given");
    return new Uint8Array(bytes);
  };
  return { descriptor, copies: { adapter: new Blob([ADAPTER], { type: "text/javascript" }), artifacts, tls: null }, readSync };
}

/** The in-memory VM network with the module's reach and the test's services. */
function network(definition: Module, net: TestNet = {}): MemoryNetwork {
  const memory = new MemoryNetwork(moduleReach(definition.manifest.requires.host));
  memory.state = net.connected === true ? "connected" : "local-only";
  memory.file("/etc/hosts", `127.0.0.1 localhost\n::1 localhost\n${VM_ADDRESS} vm\n`);
  memory.file("/etc/resolv.conf", `nameserver ${NAMESERVER}\n`);
  const names: Record<string, string[]> = {};
  /** The address `host` is served at: itself when numeric, else one address per name (the `index`th service's), which the resolver answers. */
  const addressOf = (host: string, index: number): string => {
    if (/^[\d.]+$/u.test(host) || host.includes(":")) return host;
    const address = names[host]?.[0] ?? `93.184.216.${String(10 + index)}`;
    names[host] = [address];
    return address;
  };
  const origins = Object.entries(net.http ?? {});
  origins.forEach(([origin, handler], index) => {
    const url = new URL(origin), scheme = url.protocol === "https:" ? "https" : "http";
    memory.listen(addressOf(url.hostname.replace(/^\[|\]$/gu, ""), index), url.port === "" ? (scheme === "https" ? 443 : 80) : Number(url.port), handlerServer(scheme, handler));
  });
  Object.entries(net.tcp ?? {}).forEach(([target, service], index) => {
    const match = /^([a-z0-9.-]+):(\d{1,5})$/iu.exec(target), port = Number(match?.[2]);
    if (match?.[1] === undefined || !Number.isInteger(port) || port < 1 || port > 65535) throw new VMError("INVALID_ARGUMENT", `testHost net.tcp keys are host:port, not ${target}`, { reason: "testhost-tcp" });
    memory.listen(addressOf(match[1].toLowerCase(), origins.length + index), port, service);
  });
  for (const [path, service] of Object.entries(net.unix ?? {})) memory.listenUnix(path, service);
  for (const [port, handler] of Object.entries(net.vm ?? {})) memory.listen(VM_ADDRESS, Number(port), handlerServer("http", handler));
  memory.listenDatagram(NAMESERVER, 53, dnsAnswerer(names));
  return memory;
}

/** The globals a run replaces: the network the runner installs, and the browser network APIs it removes. */
const NETWORK_GLOBALS = ["fetch", "WebSocket", ...BROWSER_NETWORK_GLOBALS] as const;

function saveGlobals(): ReadonlyMap<string, PropertyDescriptor | undefined> {
  return new Map(NETWORK_GLOBALS.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
}

function restoreGlobals(saved: ReadonlyMap<string, PropertyDescriptor | undefined>): void {
  for (const [name, descriptor] of saved) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name); else Object.defineProperty(globalThis, name, descriptor);
  }
}

/**
 * A module definition (`defineModule`) ready to run in a unit test. `run()` starts it once with these inputs and
 * resolves with its status and output; a failure of the runner's own contract (options, artifacts, adapter shape)
 * gives the runner's status (120-124) exactly as in the browser.
 */
export function testHost(definition: Module, inputs: TestHostInputs = {}): TestHost {
  return {
    run: async () => {
      const { descriptor, copies, readSync } = await release(definition, inputs);
      const invocation = inputs.invocation ?? { kind: "host" };
      const args = invocation.kind === "command" ? [invocation.argv0, ...inputs.args ?? []] : [...inputs.args ?? []];
      const existing = Object.fromEntries(Object.entries(inputs.files ?? {}).map(([path, value]) => [path, { bytes: bytesOf(value), mode: 0o644 }]));
      const linux = fakeLinux({
        args, environment: Object.entries(inputs.env ?? {}).map(([key, value]) => `${key}=${value}`), existingFiles: existing,
        ...(inputs.cwd === undefined ? {} : { cwd: inputs.cwd }), ...(inputs.stdin === undefined ? {} : { stdin: bytesOf(inputs.stdin) }),
      });
      const signals = fakeSignals(), ended = Promise.withResolvers<number>();
      const memory = network(definition, inputs.net);
      const context: RunnerContext = {
        ...linux,
        browser: { crossOriginIsolated: true, indexedDB: true, jspi: true, webLocks: true },
        importAdapter: () => Promise.resolve({ default: definition.adapter }),
        readBlobSync: readSync,
        signals: { ...signals, kill: signal => { const before = signals.exits.length, killed = signals.kill(signal); if (signals.exits.length > before) ended.resolve(signal); return killed; } },
        // Module code reaches the network through the global fetch and WebSocket, as in its worker; they are this run's.
        network: { ports: { sockets: memory.sockets(), sync: memory.syncSockets(), tls: null }, scope: globalThis, tls: PASS_THROUGH_TLS },
      };
      const launch: RunnerLaunch = invocation.kind === "command"
        ? { kind: "module-command", invocation: { name: invocation.name, path: `/usr/local/bin/${invocation.name}` }, terminals: inputs.terminals ?? NO_TERMINALS, descriptor: encodeLaunchArgument(descriptor), ...copies }
        : { kind: "host", descriptor: encodeLaunchArgument(descriptor), ...copies };
      const saved = saveGlobals();
      let outcome: { readonly status: number } | { readonly signal: number };
      try { outcome = await Promise.race([runModule(context, launch).then(status => ({ status })), ended.promise.then(signal => ({ signal }))]); }
      finally { restoreGlobals(saved); }
      const files = Object.fromEntries([...linux.written].map(([path, file]) => [path, Uint8Array.from(file.bytes)]));
      const output = { stdout: decoder.decode(linux.stdoutBytes()), stderr: decoder.decode(linux.stderrBytes()), files };
      if ("status" in outcome) return { status: outcome.status, ...output };
      const name = signalName(outcome.signal);
      return { status: 128 + outcome.signal, ...output, ...(name === null ? {} : { signal: name }) };
    },
  };
}
