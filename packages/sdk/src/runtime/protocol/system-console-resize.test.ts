import { expect, it } from "vitest";
import { decodeControlIncoming, PROTOCOL_VERSION } from "../protocol.js";

it("decodes console geometry and rejects invalid or ambiguous dimensions", () => {
  const request = { id: 1, version: PROTOCOL_VERSION, type: "resize-system-console", columns: 120, rows: 36 };
  expect(decodeControlIncoming(request)).toEqual(request);
  for (const invalid of [
    { columns: 0 }, { rows: 0 }, { columns: 1001 }, { rows: -1 },
    { columns: 1.5 }, { rows: "24" }, { extra: true },
  ]) {
    expect(() => decodeControlIncoming({ ...request, ...invalid })).toThrow();
  }
});
