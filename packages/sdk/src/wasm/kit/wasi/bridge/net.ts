import { WASI, wasiErrno, type WasiErrno } from "../errno.js";
import type { NetSyncHost, SyncConnection } from "../host.js";
import type { GuestMemory } from "../memory.js";
import { WasiError, type WasiContext } from "../context.js";
import type { Handles } from "./handles.js";

type ImportFunction = (...args: never[]) => number;
export const NET_FUNCTIONS = ["net_connect", "net_read", "net_write", "net_shutdown", "net_close"] as const;
const NO_TIMEOUT = 0xffff_ffff, MAX_READ = 64 * 1024, MAX_TIMEOUT_MS = 86_400_000;

export type Destination = { readonly kind: "tcp"; readonly host: string; readonly port: number; readonly tls: boolean; readonly alpn: readonly string[] } | { readonly kind: "unix"; readonly path: string };
export interface Connection { readonly socket: SyncConnection; readClosed: boolean }

/** kind u8 (0 TCP, 1 TCP+TLS, 2 Unix), then host string + port u16 (+ ALPN list for TLS), or a Unix path string. */
export function decodeDestination(bytes: Uint8Array): Destination {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), decoder = new TextDecoder("utf-8", { fatal: true });
  let at = 0;
  const fail = (): never => { throw new WasiError(WASI.inval); };
  const u8 = () => { if (at + 1 > bytes.byteLength) fail(); return view.getUint8(at++); };
  const u16 = () => { if (at + 2 > bytes.byteLength) fail(); const value = view.getUint16(at, true); at += 2; return value; };
  const u32 = () => { if (at + 4 > bytes.byteLength) fail(); const value = view.getUint32(at, true); at += 4; return value; };
  const text = (max: number) => {
    const length = u32();
    if (length === 0 || length > max || at + length > bytes.byteLength) fail();
    const raw = bytes.subarray(at, at + length); at += length;
    if (raw.includes(0)) fail();
    try { return decoder.decode(raw); } catch { return fail(); }
  };
  const kind = u8();
  let destination: Destination;
  if (kind === 2) destination = { kind: "unix", path: text(107) };
  else if (kind === 0 || kind === 1) {
    const host = text(253), port = u16();
    if (port === 0) fail();
    const count = kind === 1 ? u32() : 0;
    if (count > 8) fail();
    destination = { kind: "tcp", host, port, tls: kind === 1, alpn: Array.from({ length: count }, () => text(255)) };
  } else return fail();
  if (at !== bytes.byteLength) fail();
  return destination;
}

/**
 * The socket part of `oxidevm_bridge_v1`: client streams on the module process's own VM sockets, under its declared
 * reach (Rust enforces it); TLS is the engine's client, verified against the VM's trust store. A write to a closed peer
 * is PIPE, never SIGPIPE.
 */
export function bridgeNet(context: WasiContext, net: NetSyncHost | undefined, memory: () => GuestMemory, connections: Handles<Connection>): Readonly<Record<(typeof NET_FUNCTIONS)[number], ImportFunction>> {
  const socketCall = (body: () => void): WasiErrno => context.guarded(() => {
    try { body(); }
    catch (error) {
      if (error instanceof WasiError || net === undefined) throw error;
      throw new WasiError(wasiErrno(net.errno(error)));
    }
  });
  const host = (): NetSyncHost => { if (net === undefined) throw new WasiError(WASI.nosys); return net; };
  return {
    net_connect: (pointer: number, length: number, out: number) => socketCall(() => {
      const network = host(), guest = memory();
      if (length > 4096) throw new WasiError(WASI.inval);
      guest.check(out, 4);
      const destination = decodeDestination(guest.read(pointer, length));
      const socket = destination.kind === "unix" ? network.connectUnixSync(destination.path)
        : network.connectSync({ host: destination.host, port: destination.port, ...(destination.tls ? { tls: true, alpn: destination.alpn } : {}) });
      let handle: number;
      try { handle = connections.add({ socket, readClosed: false }); } catch (error) { socket.close(); throw error; }
      memory().setU32(out, handle);
    }),
    net_read: (handle: number, buffer: number, length: number, rawTimeout: number, out: number) => socketCall(() => {
      // WebAssembly passes the u32 as an i32: u32::MAX ("no timeout") arrives as -1.
      const timeoutMs = rawTimeout >>> 0;
      const connection = connections.get(handle), guest = memory();
      guest.check(buffer, length); guest.check(out, 4);
      if (timeoutMs !== NO_TIMEOUT && timeoutMs > MAX_TIMEOUT_MS) throw new WasiError(WASI.inval);
      if (connection.readClosed || length === 0) { guest.setU32(out, 0); return; }
      const bytes = connection.socket.read(Math.min(length, MAX_READ), timeoutMs === NO_TIMEOUT ? {} : { timeoutMs });
      if (bytes.byteLength > length) throw new RangeError("the host returned more bytes than asked for");
      memory().write(buffer, bytes); memory().setU32(out, bytes.byteLength);
    }),
    net_write: (handle: number, buffer: number, length: number, out: number) => socketCall(() => {
      const connection = connections.get(handle), guest = memory();
      guest.check(out, 4);
      connection.socket.write(guest.read(buffer, Math.min(length, MAX_READ)));
      memory().setU32(out, Math.min(length, MAX_READ));
    }),
    net_shutdown: (handle: number, how: number) => socketCall(() => {
      const connection = connections.get(handle);
      if (how < 1 || how > 3) throw new WasiError(WASI.inval);
      // Shutting down the read side stops this program reading; the peer is told nothing (as SHUT_RD on Linux).
      if ((how & 1) !== 0) connection.readClosed = true;
      if ((how & 2) !== 0) connection.socket.closeWrite();
    }),
    net_close: (handle: number) => context.guarded(() => { connections.remove(handle).socket.close(); }),
  };
}

