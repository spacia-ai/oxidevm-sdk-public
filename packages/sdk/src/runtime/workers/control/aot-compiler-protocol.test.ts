import { describe, expect, it } from "vitest";

import {
  AOT_COMPILER_PROTOCOL_VERSION,
  decodeAotCompilerRequest,
  decodeAotCompilerResponse,
} from "./aot-compiler-protocol.js";

const digest = "ab".repeat(32);

describe("AOT compiler protocol", () => {
  it("strictly decodes a bounded compile request", () => {
    expect(decodeAotCompilerRequest({
      version: AOT_COMPILER_PROTOCOL_VERSION,
      type: "compile",
      id: 1,
      runtimeEpoch: 2,
      catalogGeneration: 3n,
      url: "https://example.test/aot/pack.wasm",
      byteLength: 1024,
      sha256: digest,
      sourceSha256: digest,
      memberCount: 4,
    })).toMatchObject({ id: 1, runtimeEpoch: 2, catalogGeneration: 3n });
  });

  it("rejects untrusted URLs and extra request fields", () => {
    const request = {
      version: AOT_COMPILER_PROTOCOL_VERSION,
      type: "compile",
      id: 1,
      runtimeEpoch: 1,
      catalogGeneration: 1n,
      url: "file:///tmp/pack.wasm",
      byteLength: 1,
      sha256: digest,
      sourceSha256: digest,
      memberCount: 1,
    };
    expect(() => decodeAotCompilerRequest(request)).toThrow(/HTTP/u);
    expect(() => decodeAotCompilerRequest({
      ...request,
      url: "https://example.test/pack.wasm",
      unchecked: true,
    })).toThrow(/unexpected protocol field/u);
  });

  it("requires a real transferable WebAssembly module", () => {
    const response = {
      version: AOT_COMPILER_PROTOCOL_VERSION,
      type: "compiled",
      id: 1,
      runtimeEpoch: 1,
      catalogGeneration: 1n,
      sha256: digest,
      module: {},
      fetchMilliseconds: 1,
      hashMilliseconds: 1,
      compileMilliseconds: 1,
    };
    expect(() => decodeAotCompilerResponse(response)).toThrow(/module/u);
    expect(decodeAotCompilerResponse({
      ...response,
      module: new WebAssembly.Module(new Uint8Array([
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      ])),
    }).type).toBe("compiled");
  });
});
