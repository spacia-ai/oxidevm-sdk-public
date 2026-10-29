import { expect, it } from "vitest";
import { decodeDataframe, uploadError } from "./dataframe.js";

const frame = { schemaVersion: 1, columns: [{ name: "country", dtype: "str" }], rows: [["<script>alert(1)</script>"]], index: ["0"], rowCount: 1, csvAvailable: true, versions: { python: "3.12.15", pandas: "2.3.3", numpy: "2.2.6" } };
it("preserves cell text and validates shape, bounds and finite numbers", () => {
  expect(decodeDataframe(frame).rows[0]?.[0]).toBe("<script>alert(1)</script>");
  for (const value of [{ ...frame, unexpected: true }, { ...frame, rows: [[1, 2]] }, { ...frame, rows: [[Infinity]] }, { ...frame, rows: [[{}]] }, { ...frame, rowCount: 0 }, { ...frame, index: [] }, { ...frame, rows: Array.from({ length: 201 }, () => [1]) }]) expect(() => decodeDataframe(value)).toThrow();
});
it("accepts CSV uploads and rejects oversized or other files before reading them", () => {
  expect(uploadError({ name: "My DATA.CSV", size: 10 })).toBeUndefined();
  expect(uploadError({ name: "data.csv", size: 5 * 1024 ** 2 + 1 })).toContain("5 MiB");
  expect(uploadError({ name: "x.py", size: 1 })).toContain("CSV");
  expect(uploadError({ name: "empty.csv", size: 0 })).toContain("empty");
});
