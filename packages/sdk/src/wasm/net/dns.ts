/**
 * DNS messages on the wire (RFC 1035, with an RFC 6891 OPT record so answers up to 1232 bytes arrive whole): one
 * question for A or AAAA records, and the addresses its answer holds. Pure functions; the resolver owns the sockets.
 * Everything in an answer is hostile input, bounded by the message it came in.
 */
export const DNS_TYPE = { A: 1, CNAME: 5, AAAA: 28 } as const;
export type AddressType = typeof DNS_TYPE.A | typeof DNS_TYPE.AAAA;

/** The largest answer the resolver reads, as its OPT record advertises. */
export const DNS_PAYLOAD_BYTES = 1232;
const MAX_NAME_BYTES = 253, MAX_POINTERS = 32;

export class DnsFormatError extends Error {}

function fail(message: string): never { throw new DnsFormatError(message); }

/** The labels of a query name, checked as a DNS name (letters, digits, hyphens and underscores, each label 1-63 bytes). */
export function nameLabels(name: string): readonly string[] {
  const trimmed = name.endsWith(".") ? name.slice(0, -1) : name;
  if (trimmed.length === 0 || trimmed.length > MAX_NAME_BYTES) fail("The name is empty or longer than 253 characters");
  const labels = trimmed.split(".");
  for (const label of labels) if (!/^[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?$/u.test(label)) fail(`"${name}" is not a valid DNS name`);
  return labels;
}

/** A recursive query for `name` (already a full name) and `type`, with the given ID. */
export function encodeQuery(id: number, name: string, type: AddressType): Uint8Array<ArrayBuffer> {
  const labels = nameLabels(name), encoder = new TextEncoder();
  const qname = labels.flatMap(label => [label.length, ...encoder.encode(label)]);
  const bytes = new Uint8Array(12 + qname.length + 1 + 4 + 11), view = new DataView(bytes.buffer);
  view.setUint16(0, id); view.setUint16(2, 0x0100); view.setUint16(4, 1); view.setUint16(10, 1);
  bytes.set(qname, 12);
  let at = 12 + qname.length + 1;
  view.setUint16(at, type); view.setUint16(at + 2, 1); at += 4;
  // OPT: root name, type 41, the UDP payload size as its class, no extended flags, no options.
  bytes[at] = 0; view.setUint16(at + 1, 41); view.setUint16(at + 3, DNS_PAYLOAD_BYTES);
  return bytes;
}

/** Skips a (possibly compressed) name starting at `at`; returns the offset after it. */
function skipName(bytes: Uint8Array, at: number): number {
  for (;;) {
    const length = bytes[at];
    if (length === undefined) fail("Truncated name");
    if (length === 0) return at + 1;
    // A pointer ends the name where it stands.
    if ((length & 0xc0) === 0xc0) { if (at + 2 > bytes.length) fail("Invalid name pointer"); return at + 2; }
    if ((length & 0xc0) !== 0) fail("Invalid label type");
    at += 1 + length;
  }
}

/** Reads a name (following compression pointers, bounded) in lower case. */
function readName(bytes: Uint8Array, at: number): string {
  const labels: string[] = [];
  let total = 0;
  for (let pointers = 0; ;) {
    const length = bytes[at];
    if (length === undefined) fail("Truncated name");
    if (length === 0) return labels.join(".").toLowerCase();
    if ((length & 0xc0) === 0xc0) {
      const low = bytes[at + 1];
      if (low === undefined || ++pointers > MAX_POINTERS) fail("Invalid name pointer");
      at = (length & 0x3f) << 8 | low; continue;
    }
    if ((length & 0xc0) !== 0 || at + 1 + length > bytes.length) fail("Invalid label");
    total += length + 1;
    if (total > 255) fail("Name too long");
    labels.push(String.fromCharCode(...bytes.subarray(at + 1, at + 1 + length)));
    at += 1 + length;
  }
}

function ipv6Text(bytes: Uint8Array): string {
  const groups = Array.from({ length: 8 }, (_, index) => ((bytes[index * 2] ?? 0) << 8 | (bytes[index * 2 + 1] ?? 0)).toString(16));
  return groups.join(":");
}

export type DnsAnswer =
  | { readonly kind: "addresses"; readonly addresses: readonly string[] }
  /** NXDOMAIN: the name does not exist. */
  | { readonly kind: "no-name" }
  /** The name exists but has no record of this type. */
  | { readonly kind: "no-data" }
  /** SERVFAIL, REFUSED or another failure: ask the next server. */
  | { readonly kind: "server-failure"; readonly rcode: number }
  | { readonly kind: "truncated" };

/**
 * Decodes the answer to the query with `id` for `name`: the addresses of `type` the answer section holds for the name or
 * the CNAME chain it leads to. Returns null for a message that is not the answer to this query (a stray datagram).
 */
export function decodeAnswer(bytes: Uint8Array, id: number, name: string, type: AddressType): DnsAnswer | null {
  if (bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = view.getUint16(2);
  if (view.getUint16(0) !== id || (flags & 0x8000) === 0 || view.getUint16(4) !== 1) return null;
  let at = skipName(bytes, 12);
  if (readName(bytes, 12) !== name.toLowerCase().replace(/\.$/u, "") || at + 4 > bytes.length || view.getUint16(at) !== type) return null;
  at += 4;
  if ((flags & 0x0200) !== 0) return { kind: "truncated" };
  const rcode = flags & 0x000f;
  if (rcode === 3) return { kind: "no-name" };
  if (rcode !== 0) return { kind: "server-failure", rcode };
  const answers = view.getUint16(6), names = new Set([name.toLowerCase().replace(/\.$/u, "")]), addresses: string[] = [];
  const records: { readonly owner: string; readonly type: number; readonly data: Uint8Array; readonly offset: number }[] = [];
  for (let index = 0; index < answers; index++) {
    const owner = readName(bytes, at);
    at = skipName(bytes, at);
    if (at + 10 > bytes.length) fail("Truncated record");
    const recordType = view.getUint16(at), length = view.getUint16(at + 8);
    if (at + 10 + length > bytes.length) fail("Truncated record data");
    records.push({ owner, type: recordType, data: bytes.subarray(at + 10, at + 10 + length), offset: at + 10 });
    at += 10 + length;
  }
  // CNAMEs may come in any order; follow them until no new name appears.
  for (let changed = true; changed;) {
    changed = false;
    for (const record of records) {
      if (record.type !== DNS_TYPE.CNAME || !names.has(record.owner)) continue;
      const target = readName(bytes, record.offset);
      if (!names.has(target)) { names.add(target); changed = true; }
    }
  }
  for (const record of records) {
    if (record.type !== type || !names.has(record.owner)) continue;
    if (type === DNS_TYPE.A && record.data.length === 4) addresses.push(Array.from(record.data).join("."));
    if (type === DNS_TYPE.AAAA && record.data.length === 16) addresses.push(ipv6Text(record.data));
  }
  return addresses.length > 0 ? { kind: "addresses", addresses } : { kind: "no-data" };
}
