import { expect, it } from "vitest";
import { decodeSynchronousMessage, encodeSynchronousMessage } from "./message-serialization.js";

it("agrees with structured clone for scalar values, binary aliases, cycles and standard errors", () => {
  const input: { self?: unknown; values: unknown[] } = { values: [undefined, null, true, 1, -0, NaN, Infinity, -Infinity, 17n, "π", /test/giu, new Date(NaN)] };
  input.self = input;
  for (const error of [new Error("error"), new TypeError("type", { cause: input }), new RangeError("range")]) input.values.push(error);
  const expected: unknown = structuredClone(input), encoded = encodeSynchronousMessage(expected);
  if (encoded === null) throw new Error("Portable clone unexpectedly unavailable");
  const value = decodeSynchronousMessage(encoded);
  expect(value).toEqual(expected);
  if (typeof value !== "object" || value === null) throw new Error("Missing graph");
  expect(Reflect.get(value, "self")).toBe(value);
});

it("keeps platform capabilities on the original transport and rejects malformed graphs", () => {
  expect(encodeSynchronousMessage(new SharedArrayBuffer(8))).toBeNull();
  const channel = new MessageChannel();
  try { expect(encodeSynchronousMessage({ port: channel.port1 })).toBeNull(); }
  finally { channel.port1.close(); channel.port2.close(); }
  for (const graph of [
    { version: 2, root: 0, nodes: [["undefined"]] },
    { version: 1, root: 2, nodes: [["undefined"]] },
    { version: 1, root: 0, nodes: [["object", [["__proto__", 4]]]] },
    { version: 1, root: 0, nodes: [["view", "Function", 1, 0, 1], ["buffer", "AA=="]] },
    { version: 1, root: 0, nodes: [["regexp", "[", ""]] },
    { version: 1, root: 0, nodes: [["buffer", "!invalid!"]] },
  ]) expect(() => decodeSynchronousMessage(new TextEncoder().encode(JSON.stringify(graph)))).toThrow(/message|worker|protocol/iu);
});
