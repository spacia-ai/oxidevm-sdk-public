import {generateKeyPairSync} from "node:crypto";
import {expect,it} from "vitest";
import {defineShippedSnapshot} from "../../shipped-snapshot.js";
import {serializeShippedSnapshot} from "../protocol/shipped-source.js";
import {resolveShippedSource} from "./shipped-source.js";
const publicKey=generateKeyPairSync("ed25519").publicKey.export({type:"spki",format:"der"}).toString("base64");
it("image_A_and_snapshot_B_are_verified_separately",()=>{
  const ref=defineShippedSnapshot({mode:"userspace",name:"ready",manifestUrl:"https://state.test/manifest.json",manifestSHA256:"ab".repeat(32),imageManifestSHA256:"cd".repeat(32),manifestBytes:10,downloadBytes:100,trust:{algorithm:"Ed25519",keyId:"B",publicKey}});
  const source={kind:"reference",reference:serializeShippedSnapshot(ref)} as const;
  const image={mode:"userspace",id:"image",version:"1",identity:"ef".repeat(32),manifestSHA256:"cd".repeat(32),snapshots:[]} as const;
  const resolved=resolveShippedSource(source,image,{keyId:"A",publicKey:new Uint8Array(32)});
  expect(resolved.expectation.trusted.keyId).toBe("B");
  expect(resolved.expectation.image.identity).toBe("ef".repeat(32));
  expect(resolved.listing.bytes).toBe(90);
  expect(()=>resolveShippedSource(source,{...image,manifestSHA256:"00".repeat(32)},{keyId:"A",publicKey:new Uint8Array(32)})).toThrow();
});
