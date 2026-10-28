import { constants } from "node:os";
import { expect, it } from "vitest";
import { linuxErrnoCode, linuxErrnoConstants } from "./linux-errno.js";

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("matches Linux errno constants and keeps canonical names for aliases", () => {
  expect(linuxErrnoConstants).toEqual(constants.errno);
  for (const [name, number] of Object.entries(linuxErrnoConstants)) {
    expect(linuxErrnoCode(number)).toBe(name === "EWOULDBLOCK" ? "EAGAIN" : name === "EOPNOTSUPP" ? "ENOTSUP" : name);
  }
  expect(() => linuxErrnoCode(9999)).toThrow("Linux errno name is not implemented");
});
