import { DNS_TYPE } from "./dns.js";

/**
 * A tiny authoritative DNS answerer for the in-memory network (`testHost`, unit tests): A and AAAA records from a table,
 * NXDOMAIN for anything else. It answers the question it was asked, with its ID, pointing every answer at the question
 * name. Queries it cannot read get no answer, as a real server would drop them.
 */
export type DnsTable = Readonly<Record<string, readonly string[]>>;

function addressBytes(address: string): Uint8Array | null {
  if (/^\d+\.\d+\.\d+\.\d+$/u.test(address)) return Uint8Array.from(address.split(".").map(Number));
  if (!address.includes(":")) return null;
  const [left = "", right = ""] = address.split("::"), words = (part: string) => part === "" ? [] : part.split(":").map(word => Number.parseInt(word, 16));
  const head = words(left), tail = words(right), all = [...head, ...Array.from({ length: 8 - head.length - tail.length }, () => 0), ...tail];
  const bytes = new Uint8Array(16);
  all.forEach((word, index) => { bytes[index * 2] = word >> 8; bytes[index * 2 + 1] = word & 0xff; });
  return bytes;
}

function questionName(query: Uint8Array): { readonly name: string; readonly end: number } | null {
  const labels: string[] = [];
  let at = 12;
  for (;;) {
    const length = query[at];
    if (length === undefined || length > 63) return null;
    if (length === 0) return { name: labels.join(".").toLowerCase(), end: at + 1 };
    labels.push(String.fromCharCode(...query.subarray(at + 1, at + 1 + length)));
    at += 1 + length;
  }
}

export function dnsAnswerer(table: DnsTable): (query: Uint8Array) => Uint8Array | null {
  return query => {
    if (query.length < 17) return null;
    const question = questionName(query);
    if (question === null || question.end + 4 > query.length) return null;
    const view = new DataView(query.buffer, query.byteOffset, query.byteLength), type = view.getUint16(question.end);
    const known = Object.hasOwn(table, question.name) ? table[question.name] ?? [] : undefined;
    const records = (known ?? []).map(addressBytes).filter((bytes): bytes is Uint8Array => bytes !== null && (type === DNS_TYPE.A ? bytes.length === 4 : type === DNS_TYPE.AAAA && bytes.length === 16));
    const head = query.slice(0, question.end + 4), size = head.length + records.reduce((total, bytes) => total + 12 + bytes.length, 0);
    const answer = new Uint8Array(size), out = new DataView(answer.buffer);
    answer.set(head);
    out.setUint16(2, 0x8180 | (known === undefined ? 3 : 0)); out.setUint16(6, records.length); out.setUint16(8, 0); out.setUint16(10, 0);
    let at = head.length;
    for (const bytes of records) {
      out.setUint16(at, 0xc00c); out.setUint16(at + 2, type); out.setUint16(at + 4, 1); out.setUint32(at + 6, 60); out.setUint16(at + 10, bytes.length);
      answer.set(bytes, at + 12); at += 12 + bytes.length;
    }
    return answer;
  };
}
