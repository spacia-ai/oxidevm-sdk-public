import { expect, it } from "vitest";
import { LinuxError } from "../../runtime/js-process/codec.js";
import { VMError } from "../../runtime/errors.js";
import { emscriptenErrno, linuxErrno } from "./errno.js";

it("maps the Linux errno values a filesystem bridge sees to Emscripten's numbers", () => {
  const expected: readonly (readonly [string, number, number])[] = [
    ["EPERM", 1, 63], ["ENOENT", 2, 44], ["EBADF", 9, 8], ["EACCES", 13, 2], ["EEXIST", 17, 20], ["ENOTDIR", 20, 54], ["EISDIR", 21, 31],
    ["EINVAL", 22, 28], ["ENOSPC", 28, 51], ["EROFS", 30, 69], ["ENOTEMPTY", 39, 55], ["ENOSYS", 38, 52], ["ENOTSUP", 95, 138],
  ];
  for (const [name, linux, emscripten] of expected) expect(emscriptenErrno(linux), name).toBe(emscripten);
});

it("maps the errno values a socket bridge sees, which a program tests for by name (retry on ECONNREFUSED, stop on EPIPE)", () => {
  const expected: readonly (readonly [string, number, number])[] = [
    ["EPIPE", 32, 64], ["ECONNREFUSED", 111, 14], ["ETIMEDOUT", 110, 73], ["ECONNRESET", 104, 15], ["ECONNABORTED", 103, 13], ["ENOTCONN", 107, 53],
    ["EISCONN", 106, 30], ["EADDRINUSE", 98, 3], ["EADDRNOTAVAIL", 99, 4], ["EAFNOSUPPORT", 97, 5], ["EINPROGRESS", 115, 26], ["EALREADY", 114, 7],
    ["ENETUNREACH", 101, 40], ["EHOSTUNREACH", 113, 23], ["ENOTSOCK", 88, 57], ["EPROTONOSUPPORT", 93, 66], ["ENOBUFS", 105, 42], ["EMSGSIZE", 90, 35],
  ];
  for (const [name, linux, emscripten] of expected) expect(emscriptenErrno(linux), name).toBe(emscripten);
});

it("never gives two different Linux errors the same Emscripten number, which would make a program unable to tell them apart", () => {
  const seen = new Map<number, number>();
  for (let linux = 1; linux < 200; linux += 1) {
    const emscripten = emscriptenErrno(linux);
    if (emscripten === 29 && linux !== 5) continue; // the EIO fallback is shared by design
    expect(seen.get(emscripten), `Linux ${String(linux)} and Linux ${String(seen.get(emscripten))} both map to ${String(emscripten)}`).toBeUndefined();
    seen.set(emscripten, linux);
  }
});

it("falls back to EIO for an errno with no counterpart and accepts the negative form", () => {
  expect(emscriptenErrno(133)).toBe(29);
  expect(emscriptenErrno(0)).toBe(29);
  expect(emscriptenErrno(-2)).toBe(emscriptenErrno(2));
});

it("reads the errno only from a Linux failure, never from a lookalike", () => {
  expect(linuxErrno(new LinuxError(13))).toBe(13);
  expect(linuxErrno(new VMError("ABORTED", "x"))).toBeUndefined();
  expect(linuxErrno({ errno: 2 })).toBeUndefined();
  expect(linuxErrno("ENOENT")).toBeUndefined();
});
