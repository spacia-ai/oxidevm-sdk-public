import { describe, expect, it } from "vitest";
import type { NetHost } from "../capabilities.js";
import { MemoryNetwork, PASS_THROUGH_TLS, VM_ADDRESS } from "../net/memory-network.js";
import { createModuleNetwork } from "../net/surface.js";
import { MAX_TRUST_ANCHORS } from "../net/tls-trust.js";
import { emscriptenErrno } from "./errno.js";
import { kit } from "./index.js";

/**
 * A hand-made Emscripten-shaped `Module`: the parts of SOCKFS, DNS and FS that `kit.emscripten.network` patches, and a
 * "C program" that calls them the way Emscripten's libc does for getaddrinfo, socket, connect, send and recv. (No
 * Emscripten toolchain is installed on this host, so the fixture is not compiled from C.)
 */
class ErrnoError extends Error { constructor(readonly errno: number) { super(`errno ${String(errno)}`); } }
function emscriptenModule() {
  return { SOCKFS: { websocket_sock_ops: {} }, DNS: { lookup_name: (name: string) => `172.29.1.${String(name.length)}`, lookup_addr: (): string | null => "fake" }, FS: { ErrnoError } };
}
type Ops = Readonly<Record<string, (...args: unknown[]) => unknown>>;
function opsOf(module: ReturnType<typeof emscriptenModule>): Ops {
  const ops: object = module.SOCKFS.websocket_sock_ops, table: Record<string, (...args: unknown[]) => unknown> = {};
  for (const name of Reflect.ownKeys(ops)) {
    const value: unknown = Reflect.get(ops, name);
    if (typeof name === "string" && typeof value === "function") table[name] = (...args: unknown[]): unknown => { const result: unknown = Reflect.apply(value, ops, args); return result; };
  }
  return table;
}
const call = (ops: Ops, name: string, ...args: unknown[]): unknown => { const op = ops[name]; if (op === undefined) throw new Error(`no ${name}`); return op(...args); };

function setup(reach: "vm" | "internet") {
  const network = new MemoryNetwork(reach);
  network.file("/etc/hosts", `${VM_ADDRESS} echo\n`);
  network.file("/etc/resolv.conf", "nameserver 10.0.2.3\n");
  // An echo server in the VM: it answers synchronously, as the blocking socket layer needs.
  network.listen(VM_ADDRESS, 7, { data: (connection, bytes) => { connection.write(bytes); } });
  const net = createModuleNetwork({ ports: { sockets: network.sockets(), sync: network.syncSockets(), tls: null }, reach, signal: new AbortController().signal, tls: PASS_THROUGH_TLS }).host;
  if (net === undefined) throw new Error("no host.net");
  return { network, host: { net } satisfies { readonly net: NetHost } };
}

describe("kit.emscripten.network (ADR 0029, N-4)", () => {
  it("gives getaddrinfo the VM resolver's real address and runs connect, send and recv on the module's VM sockets", () => {
    const { host } = setup("vm"), module = emscriptenModule();
    kit.emscripten.network(host, module);
    const address = module.DNS.lookup_name("echo"), ops = opsOf(module), sock = { type: 1, family: 2 };
    expect(address).toBe(VM_ADDRESS);
    call(ops, "connect", sock, address, 7);
    expect(Reflect.get(sock, "daddr")).toBe(VM_ADDRESS);
    expect(call(ops, "poll", sock)).toBe(0x1 | 0x4);
    expect(call(ops, "sendmsg", sock, new TextEncoder().encode("xxping"), 2, 4)).toBe(4);
    const received: unknown = call(ops, "recvmsg", sock, 64), buffer: unknown = typeof received === "object" && received !== null ? Reflect.get(received, "buffer") : undefined;
    if (!(buffer instanceof Uint8Array)) throw new Error("no bytes");
    expect(new TextDecoder().decode(buffer)).toBe("ping");
    expect(call(ops, "getname", sock, true)).toEqual({ addr: VM_ADDRESS, port: 7 });
    expect(call(ops, "close", sock)).toBe(0);
  });

  it("reports the VM's decisions as the errno Emscripten's libc expects, and refuses to listen", () => {
    const { host } = setup("vm"), module = emscriptenModule();
    kit.emscripten.network(host, module);
    const ops = opsOf(module), errnoOf = (work: () => unknown): number | undefined => { try { work(); return undefined; } catch (error: unknown) { return error instanceof ErrnoError ? error.errno : -1; } };
    expect(errnoOf(() => call(ops, "connect", { type: 1 }, "93.184.215.14", 443))).toBe(emscriptenErrno(13));
    expect(errnoOf(() => call(ops, "listen", { type: 1 }, 5))).toBe(emscriptenErrno(95));
    // A name a VM-only module cannot resolve gets the unspecified address, and connecting to it says why.
    expect(module.DNS.lookup_name("pypi.org")).toBe("0.0.0.0");
    expect(errnoOf(() => call(ops, "connect", { type: 1 }, "0.0.0.0", 443))).toBe(emscriptenErrno(113));
    expect(module.DNS.lookup_addr()).toBeNull();
  });

  it("local-only reaches the program as EPERM, and a Module without SOCKFS is refused clearly", () => {
    const { host } = setup("internet"), module = emscriptenModule();
    kit.emscripten.network(host, module);
    const ops = opsOf(module);
    let errno: number | undefined;
    try { call(ops, "connect", { type: 1 }, "93.184.215.14", 443); } catch (error: unknown) { if (error instanceof ErrnoError) errno = error.errno; }
    expect(errno).toBe(emscriptenErrno(1));
    expect(() => { kit.emscripten.network(host, { DNS: {}, FS: { ErrnoError } }); }).toThrow(/Module.SOCKFS/u);
  });
});

/**
 * Emscripten's `getaddrinfo` import as its JS library implements it: it calls `DNS.lookup_name` for a name and returns 0
 * with whatever address that gives; it has no path to fail. The fixture takes the name as text instead of a pointer.
 */
function emscriptenImports(module: ReturnType<typeof emscriptenModule>) {
  const answers: string[] = [];
  const getaddrinfo = Object.assign((name: string): number => { answers.push(module.DNS.lookup_name(name)); return 0; }, { sig: "ipppp" });
  return { imports: { env: { getaddrinfo, memory: new WebAssembly.Memory({ initial: 1 }) } }, answers };
}

function getaddrinfoOf(imports: { readonly env: object }): (name: string) => unknown {
  const imported: unknown = Reflect.get(imports.env, "getaddrinfo");
  if (typeof imported !== "function") throw new Error("no getaddrinfo import");
  return name => { const result: unknown = Reflect.apply(imported, undefined, [name]); return result; };
}

describe("kit.emscripten.networkImports: getaddrinfo reports lookup failures (ADR 0029, N-4)", () => {
  it("answers EAI_NONAME for a name the VM cannot resolve, and resolves the rest as before", () => {
    const { host } = setup("vm"), module = emscriptenModule(), { imports, answers } = emscriptenImports(module), memory = imports.env.memory;
    kit.emscripten.networkImports(imports);
    kit.emscripten.network(host, module);
    const getaddrinfo = getaddrinfoOf(imports);
    expect(getaddrinfo("echo")).toBe(0);
    expect(answers).toEqual([VM_ADDRESS]);
    // A VM-only module resolves from /etc/hosts alone: the name does not exist for it.
    expect(getaddrinfo("pypi.org")).toBe(-2);
    expect(answers).toEqual([VM_ADDRESS]);
    // The wrapper keeps what Emscripten's dynamic linker reads, and leaves the other imports alone.
    expect(Reflect.get(Reflect.get(imports.env, "getaddrinfo"), "sig")).toBe("ipppp");
    expect(imports.env.memory).toBe(memory);
  });

  it("answers EAI_AGAIN when the lookup could not be made, as a C library does without a working nameserver", () => {
    const { host } = setup("internet"), module = emscriptenModule(), { imports } = emscriptenImports(module);
    kit.emscripten.networkImports(imports);
    kit.emscripten.network(host, module);
    // The VM is local-only: the query to its nameserver is refused.
    expect(getaddrinfoOf(imports)("example.com")).toBe(-3);
  });

  it("is idempotent, and leaves imports without getaddrinfo as they are", () => {
    const module = emscriptenModule(), { imports } = emscriptenImports(module);
    kit.emscripten.networkImports(imports);
    const once: unknown = Reflect.get(imports.env, "getaddrinfo");
    kit.emscripten.networkImports(imports);
    expect(Reflect.get(imports.env, "getaddrinfo")).toBe(once);
    const bare = { env: { memory: 1 } };
    kit.emscripten.networkImports(bare);
    expect(bare).toEqual({ env: { memory: 1 } });
    kit.emscripten.networkImports({});
  });
});

describe("kit.emscripten.network receive timeouts (ADR 0029, N-4)", () => {
  it("applies a socket's receive timeout to recv: waiting longer is EAGAIN, as SO_RCVTIMEO reports it", () => {
    const { host, network } = setup("vm"), module = emscriptenModule();
    network.listen(VM_ADDRESS, 9, { data: () => undefined });
    const control = kit.emscripten.network(host, module), ops = opsOf(module), sock = { type: 1, family: 2, stream: { fd: 5 } };
    call(ops, "connect", sock, VM_ADDRESS, 9);
    control.receiveTimeout(5, 30);
    let errno: number | undefined;
    try { call(ops, "recvmsg", sock, 64); } catch (error: unknown) { if (error instanceof ErrnoError) errno = error.errno; }
    expect(errno).toBe(emscriptenErrno(11));
    let invalid: unknown;
    try { control.receiveTimeout(5, -1); } catch (error: unknown) { invalid = error; }
    expect(invalid).toMatchObject({ code: "INVALID_ARGUMENT" });
    // Closing the socket forgets its timeout, so a later socket on the same descriptor starts blocking again.
    call(ops, "close", sock);
    control.receiveTimeout(5, null);
  });
});

describe("kit.tls (ADR 0029, N-4)", () => {
  it("runs a sans-IO session's handshake over a blocking connection", () => {
    const { host } = setup("vm"), session = kit.tls.session(host, { serverName: "echo", alpn: ["http/1.1"] });
    const connection = host.net.connectSync({ host: "echo", port: 7 });
    kit.tls.handshakeSync(session, connection);
    expect([session.state(), session.alpn()]).toEqual(["established", "http/1.1"]);
    session.send(new TextEncoder().encode("hello"));
    connection.write(session.takeTls());
    session.receive(connection.read(64));
    expect(new TextDecoder().decode(session.takePlaintext(64))).toBe("hello");
    session.close(); session.free(); connection.close();
  });

  it("takes extra trust anchors, and refuses more than MAX_TRUST_ANCHORS before a session opens", () => {
    const { host } = setup("vm");
    const session = kit.tls.session(host, { serverName: "echo", trust: [new TextEncoder().encode("-----BEGIN CERTIFICATE-----\n")] });
    expect([session.peerCertificates(), session.protocolVersion(), session.cipherSuite()]).toEqual([[], null, null]);
    let refusal: unknown;
    try { host.net.tls({ serverName: "echo", trust: Array.from({ length: MAX_TRUST_ANCHORS + 1 }, () => Uint8Array.of(0x30)) }); } catch (error: unknown) { refusal = error; }
    expect(refusal).toMatchObject({ code: "ERR_TLS_INVALID_TRUST" });
  });
});
