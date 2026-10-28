import {expect,it} from "vitest";
import {decodeInspectStartImageFields} from "./start-image.js";
it("admits the manifest verifier raw Ed25519 key and rejects other key layouts",()=>{
  const input={workspaceId:"ws",mode:"userspace",resume:"latest",manifestUrl:"https://profiles.test/manifest.json",manifestSHA256:"a".repeat(64),trustedKeyId:"test",trustedPublicKey:new Uint8Array(32)};
  expect(decodeInspectStartImageFields(input)).toEqual(input);
  for(const length of [0,31,33,44]) expect(()=>decodeInspectStartImageFields({...input,trustedPublicKey:new Uint8Array(length)})).toThrow();
});
