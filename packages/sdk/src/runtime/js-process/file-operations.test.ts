import { expect, it } from "vitest";
import { files } from "./file-operations.js";
import { decodeJSIdentity, Writer } from "./codec.js";
import { encodeJSRequest } from "./native-abi.js";
import { VMError } from "../errors.js";

it("versions bounded multi-descriptor readiness and refuses mismatched replies", () => {
  const request = files.poll([{ fd: 3, events: 1 }, { fd: 4, events: 4 }]);
  const encoded = encodeJSRequest(decodeJSIdentity(1n, 1n), 1, request.number, request.payload);
  expect(new DataView(encoded.buffer).getUint32(4, true)).toBe(4);
  expect(() => files.poll([])).toThrow();
  expect(() => files.poll(Array.from({ length: 17 }, () => ({ fd: 3, events: 1 })))).toThrow();
  const bytes = new Uint8Array(16), view = new DataView(bytes.buffer);
  view.setInt32(0, 3, true); view.setUint16(4, 1, true);
  view.setInt32(8, 4, true); view.setUint16(12, 4, true); view.setUint16(14, 4, true);
  expect(request.decode({ value: 1n, bytes })).toEqual([0, 4]);
  expect(() => request.decode({ value: 2n, bytes })).toThrow();
  view.setInt32(8, 5, true);
  expect(() => request.decode({ value: 1n, bytes })).toThrow();
});

it("decodes one bounded canonical-path and Linux-stat result", () => {
  const bytes = new Uint8Array(144);
  new DataView(bytes.buffer).setUint32(24, 0o100640, true);
  const request = files.pathInfo("/link");
  expect(request.number).toBe(65545);
  const result = { value: 0n, bytes: new Writer().raw(bytes).path("/workspace/a.js").finish() };
  expect(request.decode(result)).toMatchObject({ path: "/workspace/a.js", stat: { mode: 0o100640 } });
  for (const corrupt of [result.bytes.subarray(0, -1), new Uint8Array([...result.bytes, 0])]) {
    expect(() => request.decode({ value: 0n, bytes: corrupt })).toThrow();
  }
  expect(() => request.decode({ ...result, value: 1n })).toThrow();
});

it("accepts Rust pipe arrival order and rejects incomplete or duplicated identities", () => {
  const entries = [{ fd: 3, events: 1 }, { fd: 4, events: 4 }] as const;
  const request = files.pollPipes(entries);
  expect(request.number).toBe(65549);
  const bytes = new Uint8Array(16), view = new DataView(bytes.buffer);
  view.setInt32(0, 4, true); view.setUint16(4, 4, true); view.setUint16(6, 4, true);
  view.setInt32(8, 3, true); view.setUint16(12, 1, true); view.setUint16(14, 1, true);
  expect(request.decode({ value: 2n, bytes })).toEqual([{ fd: 4, events: 4, revents: 4 }, { fd: 3, events: 1, revents: 1 }]);
  expect(() => files.pollPipes([])).toThrow();
  expect(() => files.pollPipes([entries[0], entries[0]])).toThrow();
  expect(() => files.pollPipes(Array.from({ length: 17 }, (_, fd) => ({ fd, events: 1 })))).toThrow();
  expect(() => request.decode({ value: 1n, bytes })).toThrow();
  expect(() => request.decode({ value: 2n, bytes: bytes.subarray(0, 8) })).toThrow();
  view.setInt32(8, 4, true);
  expect(() => request.decode({ value: 2n, bytes })).toThrow();
  view.setInt32(8, 5, true);
  expect(() => request.decode({ value: 2n, bytes })).toThrow();
  view.setInt32(8, 3, true); view.setUint16(14, 64, true);
  expect(() => request.decode({ value: 2n, bytes })).toThrow();
});

const request = (operation: { readonly number: number; readonly payload: Uint8Array }) => ({ number: operation.number, payload: Array.from(operation.payload) });
function thrown(action: () => unknown): unknown { try { action(); } catch (error: unknown) { return error; } return undefined; }
const word = (value: number) => [value, 0, 0, 0, 0, 0, 0, 0];

it("encodes chmod and fchmod as pinned wire bytes and keeps only the permission bits", () => {
  // blob("/a") = u32 length + bytes; the mode is a full u64.
  expect(request(files.chmod("/a", 0o640))).toEqual({ number: 90, payload: [2, 0, 0, 0, 0x2f, 0x61, 0xa0, 0x01, 0, 0, 0, 0, 0, 0] });
  expect(request(files.fchmod(3, 0o604))).toEqual({ number: 91, payload: [...word(3), 0x84, 0x01, 0, 0, 0, 0, 0, 0] });
  // Linux chmod ignores the file-type bits, so a stat() mode is accepted and masked.
  expect(request(files.chmod("/a", 0o100640))).toEqual(request(files.chmod("/a", 0o640)));
  expect(request(files.fchmod(3, 0o107604))).toEqual(request(files.fchmod(3, 0o7604)));
});

const u64 = (value: bigint): number[] => Array.from(new Uint8Array(new BigUint64Array([BigInt.asUintN(64, value)]).buffer));
const A = [2, 0, 0, 0, 0x2f, 0x61]; // blob("/a")
const UTIME_NOW = 0x3fffffffn, UTIME_OMIT = 0x3ffffffen;

it("encodes utimes as utimensat: the path, then each time's seconds and nanoseconds, then the flags", () => {
  // 2026-10-31T12:00:00.250Z: the whole seconds, then the milliseconds as nanoseconds.
  const instant = new Date(Date.UTC(2026, 9, 31, 12, 0, 0, 250)), seconds = BigInt(Math.floor(instant.getTime() / 1000));
  const later = new Date(Date.UTC(2026, 9, 31, 12, 0, 1, 5));
  expect(request(files.utimes("/a", instant, later))).toEqual({ number: 280, payload: [...A, ...u64(seconds), ...u64(250_000_000n), ...u64(seconds + 1n), ...u64(5_000_000n), ...u64(0n)] });
  // Before the epoch, seconds round down and the nanoseconds stay positive: -1.5 s is -2 s and 500 ms; seconds are two's complement.
  expect(request(files.utimes("/a", new Date(-1500), new Date(0)))).toEqual({ number: 280, payload: [...A, ...u64(-2n), ...u64(500_000_000n), ...u64(0n), ...u64(0n), ...u64(0n)] });
  // "now" and "omit" are the special nanosecond values Linux defines; the seconds are ignored.
  expect(request(files.utimes("/a", "now", "omit"))).toEqual({ number: 280, payload: [...A, ...u64(0n), ...u64(UTIME_NOW), ...u64(0n), ...u64(UTIME_OMIT), ...u64(0n)] });
  // Not following links sets AT_SYMLINK_NOFOLLOW, nothing else.
  expect(request(files.utimes("/a", "now", "now", false)).payload.slice(-8)).toEqual(u64(0x100n));
  expect(request(files.utimes("/a", "now", "now", true)).payload.slice(-8)).toEqual(u64(0n));
});

it("refuses a time that is not an instant, and a path with a NUL, before anything is sent", () => {
  expect(() => files.utimes("/a", new Date(Number.NaN), "now")).toThrow(VMError);
  expect(() => files.utimes("/a", "now", new Date(Number.NaN))).toThrow(/valid date/u);
  expect(() => files.utimes("/a\0b", "now", "now")).toThrow(VMError);
  // A value the types forbid still has to be refused when a caller passes it anyway.
  const unlisted: unknown = "never";
  expect(() => { Reflect.apply(files.utimes, undefined, ["/a", unlisted, "now"]); }).toThrow(VMError);
});

it("encodes a write that must not raise SIGPIPE as sendto with MSG_NOSIGNAL, and an ordinary write unchanged", () => {
  const bytes = Uint8Array.of(1, 2, 3);
  expect(request(files.write(3, bytes))).toEqual({ number: 1, payload: [...word(3), 3, 0, 0, 0, 1, 2, 3] });
  expect(request(files.write(3, bytes, true))).toEqual({ number: 44, payload: [...word(3), 3, 0, 0, 0, 1, 2, 3, ...u64(0x4000n)] });
  // Both report how many bytes were written, never more than were offered.
  expect(files.write(3, bytes, true).decode({ value: 3n, bytes: new Uint8Array() })).toBe(3);
  expect(thrown(() => files.write(3, bytes, true).decode({ value: 4n, bytes: new Uint8Array() }))).toBeInstanceOf(VMError);
});

it("rejects modes, lengths and paths that Linux would not accept before anything is sent", () => {
  for (const mode of [-1, 1.5, Number.NaN, 0o200000]) expect(() => files.chmod("/a", mode), String(mode)).toThrow(VMError);
  for (const length of [-1, -1n, 1.5, Number.MAX_SAFE_INTEGER + 1, 2n ** 63n]) expect(() => files.truncate("/a", length), String(length)).toThrow(VMError);
  expect(() => files.ftruncate(3, -1)).toThrow(VMError);
  // The explicit bound names the real limit; the generic u64 check would only say "out of range".
  for (const length of [-1n, 2n ** 63n]) expect(() => files.truncate("/a", length)).toThrow(/signed 64-bit offset/u);
  for (const build of [() => files.chmod("/a\0b", 0o600), () => files.truncate("/a\0b", 0), () => files.link("/a", "/b\0"), () => files.symlink("t\0", "/b"), () => files.readlink("/l\0")]) {
    expect(thrown(build)).toMatchObject({ code: "INVALID_ARGUMENT" });
  }
  expect(() => files.readlink("x".repeat(4096))).toThrow(VMError);
  expect(() => files.chmod("/a", 0o640)).not.toThrow();
});

it("encodes truncate and ftruncate with the full 63-bit length", () => {
  expect(request(files.truncate("/a", 5))).toEqual({ number: 76, payload: [2, 0, 0, 0, 0x2f, 0x61, ...word(5)] });
  expect(request(files.ftruncate(3, 7n))).toEqual({ number: 77, payload: [...word(3), ...word(7)] });
  expect(files.truncate("/a", 2n ** 63n - 1n).payload.at(-1)).toBe(0x7f);
  expect(request(files.truncate("/a", 0n))).toEqual(request(files.truncate("/a", 0)));
});

it("keeps link, symlink and readlink argument order: existing name first, then the new name", () => {
  const blob = (text: string) => [text.length, 0, 0, 0, ...new TextEncoder().encode(text)];
  expect(request(files.link("/a", "/b"))).toEqual({ number: 86, payload: [...blob("/a"), ...blob("/b")] });
  // symlink(target, path): the target text is stored verbatim and may be relative.
  expect(request(files.symlink("a.txt", "/l"))).toEqual({ number: 88, payload: [...blob("a.txt"), ...blob("/l")] });
  expect(request(files.readlink("/l"))).toEqual({ number: 89, payload: blob("/l") });
});

it("decodes empty replies for the mutators and a bounded target for readlink", () => {
  const empty = new Uint8Array();
  for (const operation of [files.chmod("/a", 0), files.fchmod(3, 0), files.truncate("/a", 0), files.ftruncate(3, 0), files.link("/a", "/b"), files.symlink("t", "/b")]) {
    expect(() => operation.decode({ value: 0n, bytes: empty })).not.toThrow();
    expect(() => operation.decode({ value: 1n, bytes: empty })).toThrow(VMError);
    expect(() => operation.decode({ value: 0n, bytes: new Uint8Array(1) })).toThrow(VMError);
  }
  const target = new TextEncoder().encode("a.txt"), readlink = files.readlink("/l");
  expect(readlink.decode({ value: 5n, bytes: target })).toBe("a.txt");
  for (const bad of [{ value: 4n, bytes: target }, { value: 0n, bytes: empty }, { value: 4096n, bytes: new Uint8Array(4096) }]) {
    expect(() => readlink.decode(bad)).toThrow(VMError);
  }
});
