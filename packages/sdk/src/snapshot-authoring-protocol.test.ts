import {expect,it} from "vitest";
import {decodeSnapshotTransport,decodeSnapshotPreviewResponse} from "./snapshot-authoring-protocol.js";
it("rejects_unknown_fields_versions_tokens_sequences_and_bounds",()=>{
  const message={version:1,buildId:"123e4567-e89b-42d3-a456-426614174000",token:"a".repeat(64),sequence:1,type:"progress",phase:"ready"};
  expect(decodeSnapshotTransport(message)).toEqual(message);
  for(const input of [{...message,extra:1},{...message,version:0},{...message,sequence:0},{...message,token:"x"},{...message,phase:"other"}])expect(()=>decodeSnapshotTransport(input)).toThrow();
  expect(()=>decodeSnapshotPreviewResponse({status:200,body:"a".repeat(1024**2+1),transportError:false})).toThrow();
});
