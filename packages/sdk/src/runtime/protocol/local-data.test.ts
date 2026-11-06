import { describe, expect, it } from "vitest";
import { decodeStorageIncoming, PROTOCOL_VERSION, storageResponseDecoders } from "../protocol.js";
import { ORIGIN_STORAGE } from "../storage-scope.js";
it("retirement accepts no arguments and rejects the preceding worker protocol",()=>{
  const request={id:1,version:PROTOCOL_VERSION,type:"initial-start-retire"};
  expect(decodeStorageIncoming(request)).toEqual(request);storageResponseDecoders["initial-start-retire"](undefined);
  for(const value of [{...request,version:PROTOCOL_VERSION-1},{...request,version:PROTOCOL_VERSION+1},{...request,version:77},{...request,version:76},{...request,version:71},{...request,version:70},{...request,source:{}},{...request,force:true}])expect(()=>decodeStorageIncoming(value)).toThrow();
});

describe("local data erasure protocol", () => {
  it("accepts only a versioned erasure request of one storage scope", () => {
    const request = { id: 1, version: PROTOCOL_VERSION, type: "erase-local-data" };
    expect(decodeStorageIncoming(request)).toEqual({ ...request, storage: ORIGIN_STORAGE });
    const embedder = "0123456789abcdef0123456789abcdef";
    expect(decodeStorageIncoming({ ...request, storage: embedder })).toEqual({ ...request, storage: { kind: "embedder", id: embedder } });
    expect(PROTOCOL_VERSION).toBe(182);
    storageResponseDecoders["erase-local-data"](undefined);
    for (const invalid of [
      { ...request, version: PROTOCOL_VERSION - 1 }, { ...request, version: PROTOCOL_VERSION + 1 },
      { ...request, version: 53 }, { ...request, path: "/" },
      { ...request, workspaceId: "only-this-one" }, { ...request, force: true },
      { ...request, storage: "" }, { ...request, storage: embedder.toUpperCase() }, { ...request, storage: { kind: "origin" } },
    ]) expect(() => decodeStorageIncoming(invalid)).toThrow();
  });
});
