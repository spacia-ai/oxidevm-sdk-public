import type { LinuxProcessContext, LinuxSocketAddress } from "../../../js-process-types.js";
import { integer } from "../../decode.js";
import { descriptor, LinuxError, protocol } from "../../js-process/codec.js";
import type { LinuxClient } from "../../js-process/transport.js";
import { networkInterfaces } from "../native-node-api/network-interfaces.js";
import { decodeNativeLookupResult, nativeLookupSource, NativeDNSLookupError } from "../assistance/node-dns.js";

type Callback = (error: { errno: number; message: string } | null, value?: unknown) => void;
type Pending = { readonly fd: number; readonly direction: "read" | "write"; readonly controller: AbortController; timer?: ReturnType<typeof setTimeout> };
type Deadline = { read: number | undefined; write: number | undefined };

/** Go owns HTTP/TLS and requested deadlines. Rust owns socket state, waits and effects. */
export function goNetwork(context: LinuxProcessContext, client: LinuxClient, failed: (error: unknown) => void) {
  const pending = new Set<Pending>(), deadlines = new Map<number, Deadline>();
  const finish = (callback: Callback, work: Promise<unknown>): void => {
    void work.then(value => callback(null, value), (error: unknown) => {
      if (error instanceof LinuxError) callback({ errno: error.errno, message: error.message });
      else if (error instanceof NativeDNSLookupError) callback({ errno: 0, message: error.message });
      else failed(error);
    }).catch(failed);
  };
  const address = (address: LinuxSocketAddress): string => {
    if (address.family === "unix") protocol("esbuild requires a TCP listener");
    return `${address.family === "ipv6" ? `[${address.address}]` : address.address}:${String(address.port)}`;
  };
  const describe = async (fd: number, peer: boolean) => ({ fd, local: address(await context.sockets.address(descriptor(fd))),
    ...(peer ? { peer: address(await context.sockets.address(descriptor(fd), true)) } : {}) });
  const arm = (request: Pending): void => {
    clearTimeout(request.timer); delete request.timer;
    const at = deadlines.get(request.fd)?.[request.direction];
    if (at === undefined) return;
    const wait = at - Date.now();
    if (wait <= 0) { request.controller.abort(new LinuxError(110)); return; }
    request.timer = setTimeout(() => { arm(request); }, Math.min(wait, 0x7fff_ffff));
  };
  const wait = async <T>(fd: number, direction: Pending["direction"], work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const request: Pending = { fd, direction, controller: new AbortController() }; pending.add(request); arm(request);
    try { return await work(request.controller.signal); }
    catch (error) { if (request.controller.signal.aborted && error instanceof LinuxError) { const reason: unknown = request.controller.signal.reason; throw reason instanceof LinuxError ? reason : new LinuxError(110); } throw error; }
    finally { pending.delete(request); clearTimeout(request.timer); }
  };
  return {
    listen(network: string, host: string, port: number, callback: Callback): void {
      finish(callback, (async () => {
        if (network !== "tcp" && network !== "tcp4" && network !== "tcp6") throw new LinuxError(93);
        integer(port, "esbuild port", 0, 65535);
        if (host.length === 0 || host.length > 4096 || host.includes("\0")) throw new LinuxError(22);
        const family = host.includes(":") ? "ipv6" : "ipv4";
        // Named hosts use the guest's original resolver; numerical addresses need no child.
        const resolved = /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(host) || host.includes(":") ? host : await resolveHost(context, host, network === "tcp4" ? 4 : network === "tcp6" ? 6 : 0);
        const fd = await context.sockets.socket(resolved.includes(":") ? "ipv6" : family);
        try {
          await context.sockets.bind(fd, { family: resolved.includes(":") ? "ipv6" : "ipv4", address: resolved, port });
          await context.sockets.listen(fd);
          return await describe(fd, false);
        } catch (error) { await context.files.close(fd); throw error; }
      })());
    },
    accept(fd: number, callback: Callback): void {
      finish(callback, wait(fd, "read", signal => context.sockets.accept(descriptor(fd), { signal })).then(async accepted => {
        try { return await describe(accepted, true); } catch (error) { await context.files.close(accepted); throw error; }
      }));
    },
    read(fd: number, output: Uint8Array, callback: Callback): void {
      finish(callback, wait(fd, "read", signal => context.files.read(descriptor(fd), Math.min(output.length, 65536), { signal })).then(bytes => {
        output.set(bytes); return bytes.length;
      }));
    },
    write(fd: number, input: Uint8Array, callback: Callback): void {
      finish(callback, wait(fd, "write", async signal => {
        let written = 0;
        while (written < input.length) {
          const bytes = input.subarray(written, written + 65536), count = await context.files.write(descriptor(fd), bytes, { signal });
          if (count === 0) throw new LinuxError(5);
          written += count;
        }
        return written;
      }));
    },
    close(fd: number, callback: Callback): void {
      for (const request of pending) if (request.fd === fd) request.controller.abort(new LinuxError(9));
      finish(callback, context.files.close(descriptor(fd)).finally(() => {
        deadlines.delete(fd);
        for (const request of pending) if (request.fd === fd) clearTimeout(request.timer);
      }));
    },
    deadline(fd: number, direction: string, value: string): void {
      descriptor(fd);
      if (direction !== "read" && direction !== "write" && direction !== "both") protocol("Invalid esbuild deadline direction");
      const at = value === "" ? undefined : integer(Number(value), "Go socket deadline"), current = deadlines.get(fd) ?? { read: undefined, write: undefined };
      for (const key of ["read", "write"] as const) if (direction === key || direction === "both") {
        current[key] = at;
      }
      deadlines.set(fd, current);
      for (const request of pending) if (request.fd === fd) arm(request);
    },
    interfaces(callback: Callback): void {
      finish(callback, Promise.resolve().then(() => Object.values(networkInterfaces(client)).flat().map(entry => entry.cidr)));
    },
  };
}

// Reuse real Linux Node for NSS/getaddrinfo. No browser resolver or host-network bypass exists.
async function resolveHost(context: LinuxProcessContext, hostname: string, family: number): Promise<string> {
  const info = await context.process.info();
  // The static Go process has no Node, loader or OpenSSL preload hooks.
  const env = Object.fromEntries(info.environment.flatMap(entry => {
    const at = entry.indexOf("="), key = entry.slice(0, at);
    return /^(?:NODE_|BUN_|LD_|OPENSSL_|UV_)/u.test(key) ? [] : [[key, entry.slice(at + 1)]];
  }));
  const child = await context.process.spawn({ command: "/usr/bin/node", args: ["-e", nativeLookupSource, JSON.stringify({ hostname, options: { family } })],
    env, stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe" } });
  if (child.stdin === null || child.stdout === null || child.stderr === null) protocol("Guest resolver descriptors are absent");
  const stdin = child.stdin, stdout = child.stdout, stderr = child.stderr;
  const read = async (fd: typeof stdout): Promise<Uint8Array> => {
    let bytes = new Uint8Array();
    for (;;) {
      const next = await context.files.read(fd, 4096);
      if (next.length === 0) return bytes;
      if (bytes.length + next.length > 65536) { await context.process.signal(child.pid, 9); throw new LinuxError(5); }
      const merged = new Uint8Array(bytes.length + next.length); merged.set(bytes); merged.set(next, bytes.length); bytes = merged;
    }
  };
  const state = { reaped: false };
  const waited = context.process.wait(child.pid).then(status => { state.reaped = true; return status; });
  const resolve = async (): Promise<string> => {
    await context.files.close(stdin);
    const [output, , status] = await Promise.all([read(stdout), read(stderr), waited]);
    if (status.kind !== "exited" || status.code !== 0) throw new LinuxError(5);
    const addresses = decodeNativeLookupResult(JSON.parse(new TextDecoder().decode(output)) as unknown, hostname);
    const selected = addresses[0]; if (selected === undefined) throw new LinuxError(99);
    return selected.address;
  };
  const outcome = await resolve().then(value => ({ kind: "resolved" as const, value }), (error: unknown) => ({ kind: "failed" as const, error }));
  // A failed close may already have committed. Never replay it against a reused descriptor.
  const cleanup = await Promise.allSettled([
    (async () => {
      if (!state.reaped) await context.process.signal(child.pid, 9).catch((error: unknown) => { if (!(error instanceof LinuxError) || error.errno !== 3) throw error; });
      await waited;
    })(),
    context.files.close(stdout), context.files.close(stderr),
  ]);
  if (outcome.kind === "failed") throw outcome.error;
  const failure = cleanup.find(result => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return outcome.value;
}
