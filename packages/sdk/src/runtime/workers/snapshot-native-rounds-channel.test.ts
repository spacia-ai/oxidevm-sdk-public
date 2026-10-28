import { expect, it } from "vitest";
import { decodeNativePayloadRequest } from "./snapshot-native-rounds-channel.js";
it("decodes bounded round and final-index operations and rejects unknown fields", () => {
  for (const request of [
    { type: "native-payload-round-open", round: 0 },
    { type: "native-payload-round-put", round: 3, index: 0, data: new Uint8Array([1]) },
    { type: "native-payload-round-seal", round: 3, bytes: 16 },
    { type: "native-live-index-put", index: 0, data: new Uint8Array([1]) },
    { type: "native-live-index-seal", bytes: 16 },
    { type: "native-payload-consolidate" },
  ]) { expect(decodeNativePayloadRequest(request)).toEqual(request); expect(() => decodeNativePayloadRequest({ ...request, extra: true })).toThrow(); }
  for (const request of [
    { type: "native-payload-round-open", round: 4 },
    { type: "native-payload-round-open", round: -1 },
    { type: "native-payload-round-put", round: 0, index: 0, data: new Uint8Array(1024 * 1024 + 1) },
    { type: "native-live-index-seal", bytes: 0 },
    { type: "native-live-index-put", index: 0, data: new Uint8Array() },
  ]) expect(() => decodeNativePayloadRequest(request)).toThrow();
});
