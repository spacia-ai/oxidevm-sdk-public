import { describe, expect, it } from "vitest";
import { WASI } from "./errno.js";
import { GuestMemory } from "./memory.js";
import { WasiError } from "./context.js";
import { guestPath } from "./paths-resolve.js";

const memory = new GuestMemory(new WebAssembly.Memory({ initial: 1 }));
const put = (bytes: Uint8Array) => { memory.write(256, bytes); return guestPath(memory, 256, bytes.byteLength); };
const refused = (bytes: Uint8Array) => { try { put(bytes); return "accepted"; } catch (error) { return error instanceof WasiError ? error.errno : "other"; } };

describe("guest paths (OBL-PATH-BYTES)", () => {
  it("keeps raw bytes, invalid UTF-8 included, so names from readdir round-trip", () => {
    expect(put(Uint8Array.of(0x61, 0xff, 0x62))).toEqual(Uint8Array.of(0x61, 0xff, 0x62));
    expect(new TextDecoder().decode(put(new TextEncoder().encode("zażółć/x")))).toBe("zażółć/x");
  });

  it("accepts 4095 bytes and refuses 4096 before any host call", () => {
    expect(put(new Uint8Array(4095).fill(0x61)).byteLength).toBe(4095);
    expect(refused(new Uint8Array(4096).fill(0x61))).toBe(WASI.nametoolong);
  });

  it("refuses an embedded NUL and an empty path", () => {
    expect(refused(Uint8Array.of(0x61, 0x00, 0x62))).toBe(WASI.inval);
    expect(refused(new Uint8Array())).toBe(WASI.noent);
  });
});
