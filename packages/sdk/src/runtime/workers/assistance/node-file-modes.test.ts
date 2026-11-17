import { expect, it } from "vitest";
import { createFileOperations } from "./node-file-operations.js";

// Linux masks the file-type bits out of a mode; programs pass `stat().mode` straight back (webpack's cache does).
it("keeps only the permission bits of a mode that carries the file type, as Linux does", () => {
  const operations = createFileOperations(() => "/", false);
  expect(operations.chmod("/file", 0o100644).next().value).toEqual({ kind: "chmod", path: "/file", mode: 0o644 });
  expect(operations.fchmod(3, 0o104755).next().value).toEqual({ kind: "fchmod", fd: 3, mode: 0o4755 });
  expect(operations.open("/file", "w", 0o100600).next().value).toMatchObject({ kind: "open", path: "/file", mode: 0o600 });
  // graceful-fs forwards an absent mode as null; Node then opens with its default.
  expect(operations.open("/file", "w", null).next().value).toMatchObject({ kind: "open", mode: 0o666 });
  expect(() => operations.chmod("/file", -1).next()).toThrow(RangeError);
  expect(() => operations.chmod("/file", 0x1_0000_0000).next()).toThrow(RangeError);
});
