import { describe, expect, it } from "vitest";
import { WASI, wasiErrno } from "./errno.js";

describe("Linux to WASI errno (OBL-ERRNO, table level)", () => {
  it("maps named Linux errors to Preview1 numbers, not raw Linux numbers", () => {
    expect([2, 9, 13, 17, 22, 28, 32, 110, 8].map(wasiErrno)).toEqual([WASI.noent, WASI.badf, WASI.acces, WASI.exist, WASI.inval, WASI.nospc, WASI.pipe, WASI.timedout, WASI.noexec]);
    expect(WASI).toMatchObject({ noent: 44, badf: 8, pipe: 64, notcapable: 76, nosys: 52, timedout: 73 });
  });

  it("turns an unknown Linux error into io, never success", () => {
    expect(wasiErrno(4095)).toBe(WASI.io);
    expect(wasiErrno(0)).toBe(WASI.io);
  });
});

describe("socket errors keep their meaning", () => {
  it("maps refused, reset, aborted, unreachable and not-connected exactly", () => {
    expect([111, 104, 103, 113, 101, 107, 98].map(wasiErrno)).toEqual([WASI.connrefused, WASI.connreset, WASI.connaborted, WASI.hostunreach, WASI.netunreach, WASI.notconn, WASI.addrinuse]);
    expect(WASI).toMatchObject({ connrefused: 14, connreset: 15, hostunreach: 23, netunreach: 40, notcapable: 76 });
  });
});
