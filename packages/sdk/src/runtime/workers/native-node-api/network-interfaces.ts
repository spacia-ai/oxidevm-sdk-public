import type { LinuxClient } from "../../js-process/transport.js";
import { descriptor, LinuxError, operation, protocol, value, Writer } from "../../js-process/codec.js";
import { files } from "../../js-process/file-operations.js";
import type { NetworkInterfaces } from "../assistance/process-io.js";

type Address = NetworkInterfaces[string][number];
type Link = { name: string; flags: number; mac: string };
const align = (length: number) => Math.ceil(length / 4) * 4;
function invalid(): never { return protocol("Invalid Linux netlink interface reply"); }

/** Decode Linux's route interface projection. Rust owns all network state and permissions. */
export function networkInterfaces(client: LinuxClient): NetworkInterfaces {
  const fd = client.sync(operation(41, new Writer().u32(16), result => descriptor(value(result))));
  try {
    const request = new Uint8Array(40), view = new DataView(request.buffer);
    for (const [offset, type, sequence] of [[0, 18, 1], [20, 22, 2]] as const) {
      view.setUint32(offset, 17, true); view.setUint16(offset + 4, type, true);
      view.setUint16(offset + 6, 0x301, true); view.setUint32(offset + 8, sequence, true);
    }
    if (client.sync(files.write(fd, request)) !== request.length) invalid();
    return decode(client.sync(files.read(fd, 65536)));
  } finally { client.sync(files.close(fd)); }
}

function decode(bytes: Uint8Array): NetworkInterfaces {
  const links = new Map<number, Link>(), result = new Map<string, Address[]>(), done = new Set<number>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 16 > bytes.length) invalid();
    const length = view.getUint32(offset, true), type = view.getUint16(offset + 4, true), flags = view.getUint16(offset + 6, true), sequence = view.getUint32(offset + 8, true);
    if (length < 16 || align(length) > bytes.length - offset || flags & 0x10 || sequence < 1 || sequence > 2 || done.has(sequence)) invalid();
    const body = bytes.subarray(offset + 16, offset + length), fields = new DataView(body.buffer, body.byteOffset, body.byteLength);
    if (type === 2) {
      if (body.length < 20) invalid();
      const errno = -fields.getInt32(0, true);
      if (errno < 1 || errno > 4095) invalid();
      throw new LinuxError(errno);
    } else if (type === 3) { if (body.length !== 0 && (body.length !== 4 || fields.getInt32(0, true) !== 0)) invalid(); done.add(sequence); }
    else if (type === 16 && sequence === 1) {
      if (body.length < 16) invalid();
      const attrs = attributes(body.subarray(16)), name = attrs.get(3), mac = attrs.get(1);
      if (name === undefined || name.length < 2 || name.at(-1) !== 0 || name.subarray(0, -1).includes(0) || mac?.length !== 6) invalid();
      const index = fields.getUint32(4, true);
      if (index === 0 || links.has(index)) invalid();
      links.set(index, { name: new TextDecoder("utf-8", { fatal: true }).decode(name.subarray(0, -1)), flags: fields.getUint32(8, true), mac: Array.from(mac, byte => byte.toString(16).padStart(2, "0")).join(":") });
    } else if (type === 20 && sequence === 2) {
      if (body.length < 8 || !done.has(1)) invalid();
      const family = fields.getUint8(0), prefix = fields.getUint8(1), scope = fields.getUint8(3), index = fields.getUint32(4, true), link = links.get(index);
      if (link === undefined || (family !== 2 && family !== 10) || prefix > (family === 2 ? 32 : 128)) invalid();
      const attrs = attributes(body.subarray(8)), address = attrs.get(family === 2 ? 2 : 1) ?? attrs.get(1);
      if (address?.length !== (family === 2 ? 4 : 16)) invalid();
      if (link.flags & 1) {
        const text = format(address), mask = Uint8Array.from(address, (_, index) => 256 - 2 ** (8 - Math.min(8, Math.max(0, prefix - index * 8))));
        const addresses = result.get(link.name) ?? []; result.set(link.name, addresses);
        addresses.push({ address: text, netmask: format(mask), family: family === 2 ? "IPv4" : "IPv6", mac: link.mac, internal: (link.flags & 8) !== 0, cidr: `${text}/${String(prefix)}`, ...(family === 10 ? { scopeid: scope === 253 ? index : 0 } : {}) });
      }
    } else invalid();
    offset += align(length);
  }
  if (done.size !== 2) invalid();
  return Object.fromEntries(result);
}

function attributes(bytes: Uint8Array): Map<number, Uint8Array> {
  const result = new Map<number, Uint8Array>(), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 4 > bytes.length) invalid();
    const length = view.getUint16(offset, true), type = view.getUint16(offset + 2, true);
    if (length < 4 || align(length) > bytes.length - offset || result.has(type)) invalid();
    result.set(type, bytes.subarray(offset + 4, offset + length)); offset += align(length);
  }
  return result;
}
function format(bytes: Uint8Array): string {
  if (bytes.length === 4) return Array.from(bytes).join(".");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), groups = Array.from({ length: 8 }, (_, index) => view.getUint16(index * 2).toString(16));
  return new URL(`http://[${groups.join(":")}]`).hostname.slice(1, -1);
}
