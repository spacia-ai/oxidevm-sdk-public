import type { FileDescriptor, LinuxFiles, LinuxSocketAddress, LinuxSockets } from "../../js-process-types.js";
import { integer } from "../decode.js";
import { descriptor, noValue, operation, protocol, Reader, value, Writer, type LinuxOperation } from "./codec.js";
import type { LinuxClient } from "./transport.js";

export function encodeAddress(address: LinuxSocketAddress): Uint8Array<ArrayBuffer> {
  if (address.family === "unix") {
    const path = new TextEncoder().encode(address.path), abstract = path[0] === 0;
    if (path.byteLength === 0 || path.byteLength > (abstract ? 108 : 107) || path.subarray(abstract ? 1 : 0).includes(0)) protocol("Invalid Unix socket address");
    const bytes = new Uint8Array(2 + path.byteLength + (abstract ? 0 : 1)); bytes[0] = 1; bytes.set(path, 2); return bytes;
  }
  const bytes = new Uint8Array(address.family === "ipv4" ? 16 : 28), view = new DataView(bytes.buffer);
  view.setUint16(0, address.family === "ipv4" ? 2 : 10, true); view.setUint16(2, integer(address.port, "TCP port", 0, 65535));
  if (address.family === "ipv4") bytes.set(ipv4(address.address), 4);
  else bytes.set(ipv6(address.address), 8);
  return bytes;
}
function ipv4(address: string): Uint8Array<ArrayBuffer> {
  const parts = address.split("."); if (parts.length !== 4 || parts.some(part => !/^(?:0|[1-9]\d{0,2})$/u.test(part))) protocol("An IPv4 socket requires a numeric address");
  return Uint8Array.from(parts.map(part => integer(Number(part), "IPv4 octet", 0, 255)));
}
function ipv6(address: string): Uint8Array<ArrayBuffer> {
  const halves = address.split("::"); if (halves.length > 2 || address.includes("%")) protocol("An IPv6 socket requires a numeric address without a scope");
  const groups = (part: string): number[] => part === "" ? [] : part.split(":").flatMap(group => {
    if (group.includes(".")) { const bytes = ipv4(group); return [(bytes[0] ?? 0) * 256 + (bytes[1] ?? 0), (bytes[2] ?? 0) * 256 + (bytes[3] ?? 0)]; }
    if (!/^[a-f\d]{1,4}$/iu.test(group)) protocol("Invalid numeric IPv6 group");
    return [Number.parseInt(group, 16)];
  });
  const left = groups(halves[0] ?? ""), right = groups(halves[1] ?? ""), missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) protocol("Invalid numeric IPv6 address length");
  const words = [...left, ...Array.from({ length: missing }, () => 0), ...right], bytes = new Uint8Array(16), view = new DataView(bytes.buffer);
  words.forEach((word, index) => view.setUint16(index * 2, word)); return bytes;
}
export function decodeAddress(bytes: Uint8Array): LinuxSocketAddress {
  if (bytes.byteLength < 2) protocol("Truncated Linux socket address");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), family = view.getUint16(0, true);
  if (family === 1) {
    const path = bytes.subarray(2), abstract = path[0] === 0;
    const end = abstract ? path.byteLength : path.indexOf(0);
    return { family: "unix", path: new TextDecoder().decode(path.subarray(0, end < 0 ? undefined : end)) };
  }
  if (family === 2 && bytes.byteLength === 16) return { family: "ipv4", address: Array.from(bytes.subarray(4, 8)).join("."), port: view.getUint16(2) };
  if (family === 10 && bytes.byteLength === 28) return { family: "ipv6", address: Array.from({ length: 8 }, (_, index) => view.getUint16(8 + index * 2).toString(16)).join(":"), port: view.getUint16(2) };
  return protocol("Unsupported Linux socket address");
}
/** The stream-socket operations both the asynchronous facade and synchronous callers (the module network) send. */
export const streamSocket = {
  /** OXJR 41: socket(family, SOCK_STREAM, 0). */
  socket: (family: LinuxSocketAddress["family"]): LinuxOperation<FileDescriptor> => operation(41, new Writer().u32(family === "unix" ? 1 : family === "ipv4" ? 2 : 10), result => descriptor(value(result))),
  /** OXJR 42: connect(fd, address). */
  connect: (fd: number, address: LinuxSocketAddress): LinuxOperation<void> => operation(42, new Writer().u64(fd).blob(encodeAddress(address)), noValue),
  /** OXJR 48: shutdown(fd, how). */
  shutdown: (fd: number, direction: "read" | "write" | "both"): LinuxOperation<void> => operation(48, new Writer().u64(fd).u8(direction === "read" ? 0 : direction === "write" ? 1 : 2), noValue),
} as const;

export function sockets(client: LinuxClient, files: LinuxFiles): LinuxSockets {
  return {
    socket: family => client.call(streamSocket.socket(family)),
    connect: (fd, address, options) => client.call(streamSocket.connect(fd, address), options?.signal),
    bind: (fd, address) => client.call(operation(49, new Writer().u64(fd).blob(encodeAddress(address)), noValue)),
    listen: (fd, backlog = 128) => client.call(operation(50, new Writer().u64(fd).u32(backlog), noValue)),
    accept: (fd, options) => client.call(operation(43, new Writer().u64(fd), result => descriptor(value(result))), options?.signal),
    address: (fd, peer = false) => client.call(operation(peer ? 52 : 51, new Writer().u64(fd), result => {
      if (result.value !== 0n || result.bytes.byteLength !== 132) protocol("Invalid Linux socket name result");
      const length = new DataView(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength).getUint32(128, true);
      if (length > 128) protocol("Oversized Linux socket address"); return decodeAddress(result.bytes.subarray(0, length));
    })),
    shutdown: (fd, direction) => client.call(streamSocket.shutdown(fd, direction)),
    read: files.read.bind(files), write: files.write.bind(files), close: files.close.bind(files),
  };
}

const SOCK_DGRAM = 2, MSG_PEEK = 0x2, MSG_DONTWAIT = 0x40, MSG_NOSIGNAL = 0x4000;
/** One datagram and the address it came from. */
export interface ReceivedDatagram { readonly bytes: Uint8Array; readonly source: LinuxSocketAddress | null }

/**
 * Datagram sockets (Userspace API 146, engine ADR 0029): the runner's own facility for its DNS resolver, never a member
 * of a module's `host`. Rust's socket owner applies the VM's network policy (UDP 53 to the resolver only) and the
 * module's reach to every datagram.
 */
export const datagram = {
  /** OXJR 41 `{u32 family, u32 type}`: socket(AF_INET or AF_INET6, SOCK_DGRAM, 0). */
  socket: (family: "ipv4" | "ipv6"): LinuxOperation<number> =>
    operation(41, new Writer().u32(family === "ipv4" ? 2 : 10).u32(SOCK_DGRAM), result => descriptor(value(result))),
  /** OXJR 44 with a destination: fd, blob(bytes), flags (MSG_NOSIGNAL), blob(address); answers the bytes sent. */
  sendTo: (fd: number, bytes: Uint8Array, destination: LinuxSocketAddress): LinuxOperation<number> =>
    operation(44, new Writer().u64(fd).blob(bytes).u64(MSG_NOSIGNAL).blob(encodeAddress(destination)), result => {
      const count = value(result); if (count > bytes.byteLength) protocol("Invalid datagram send result"); return count;
    }),
  /** OXJR 45: recvfrom(fd, count, flags); the reply is u32 address length, the address, then the datagram. */
  receiveFrom: (fd: number, count: number, options: { readonly dontWait?: boolean; readonly peek?: boolean } = {}): LinuxOperation<ReceivedDatagram> =>
    operation(45, new Writer().u64(fd).u64(integer(count, "datagram count", 0, 64 * 1024)).u64((options.dontWait === true ? MSG_DONTWAIT : 0) | (options.peek === true ? MSG_PEEK : 0)), result => {
      const reader = new Reader(result.bytes), length = reader.u32();
      if (length > 128) protocol("Oversized datagram source address");
      const source = reader.raw(length), bytes = reader.raw(result.bytes.byteLength - 4 - length);
      if (bytes.byteLength > count || result.value !== BigInt(bytes.byteLength)) protocol("Invalid datagram receive result");
      return { bytes: bytes.slice(), source: length === 0 ? null : decodeAddress(source) };
    }),
} as const;
