import {generateKeyPairSync} from "node:crypto";
import {expect,it} from "vitest";
import {encodeSnapshotIndex,verifySnapshotIndex,decodeSnapshotIndex} from "./snapshot-index.js";
import {publicTrust} from "./keys.js";
it("index_authenticates_dependencies_and_verifier_and_rejects_traversal",()=>{
  const key=generateKeyPairSync("ed25519").privateKey,trust=publicTrust(key),digest="ab".repeat(32);
  const body={format:"oxidevm-snapshot-bundle",schemaVersion:2,name:"ready",mode:"userspace",publicBaseUrl:"/",
    source:{id:"123e4567-e89b-42d3-a456-426614174000",createdAt:"2026-10-14T00:00:00.000Z"},
    snapshot:{url:"snapshot/manifest.json",sha256:digest,bytes:10,downloadBytes:20},
    image:{mode:"userspace",manifestUrl:"/image/manifest.json",manifestSHA256:digest,trust},
    vm:{memoryMiB:256},compatibility:{stateSchema:4,stateFormatVersion:1,wasmAPI:37,workerProtocol:69,frameProtocol:7,storageChannel:12},
    sdkVersion:"0.1.0-alpha.32",engineReleaseId:digest,verifier:{url:"verification/verify.mjs",sha256:digest,bytes:1},
    receiptSHA256:null,artifacts:[{url:"image/manifest.json",sha256:digest,bytes:1},{url:"image/image.lock.json",sha256:digest,bytes:1}],
    reports:{build:{url:"reports/build.json",sha256:digest,bytes:1},test:{url:"reports/test.json",sha256:digest,bytes:1}},
    distribution:{status:"development-only"},trust};
  const bytes=encodeSnapshotIndex(decodeSnapshotIndex({...body,signing:{keyId:trust.keyId,signature:""}}),key);
  expect(verifySnapshotIndex(bytes,trust).name).toBe("ready");
  const value:unknown=JSON.parse(new TextDecoder().decode(bytes));
  if(typeof value!=="object"||value===null)throw new Error("not an index");
  expect(()=>verifySnapshotIndex(new TextEncoder().encode(JSON.stringify({...value,name:"other"})),trust)).toThrow();
  expect(()=>decodeSnapshotIndex({...body,verifier:{url:"../key.pem",sha256:digest,bytes:1},signing:{keyId:trust.keyId,signature:""}})).toThrow();
});
