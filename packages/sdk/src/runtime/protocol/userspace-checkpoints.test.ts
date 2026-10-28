import { expect, it } from "vitest";
import { decodeNativeCheckpointConnection, decodeNativeCheckpointRequest, nativeCheckpointResponseDecoders } from "./userspace-checkpoints.js";
import { PROTOCOL_VERSION } from "./common.js";

it("validates the separate native lifecycle channel and every transfer envelope", () => {
  const channel = new MessageChannel(), storage = new MessageChannel(), events = new MessageChannel();
  const connection = { version: PROTOCOL_VERSION, type: "connect-checkpoints", port: channel.port1, snapshotPort: storage.port1, eventsPort: events.port1 };
  expect(decodeNativeCheckpointConnection(connection)).toEqual(connection);
  expect(() => decodeNativeCheckpointConnection({ ...connection, version: PROTOCOL_VERSION - 1 })).toThrow();
  const request = { version: PROTOCOL_VERSION, id: 1, type: "capture", kind: "named", label: "before edit" };
  expect(decodeNativeCheckpointRequest(request)).toEqual(request);
  for (const bad of [{ ...request, kind: "unknown" }, { ...request, extra: true }, { ...request, label: "" }]) {
    expect(() => decodeNativeCheckpointRequest(bad)).toThrow();
  }
  expect(decodeNativeCheckpointRequest({ version: PROTOCOL_VERSION, type: "cancel", requestId: 1 })).toMatchObject({ type: "cancel" });
  expect(nativeCheckpointResponseDecoders.dirty(true)).toBe(true);
  expect(() => nativeCheckpointResponseDecoders.dirty(1)).toThrow();
  for (const port of [channel.port1, channel.port2, storage.port1, storage.port2, events.port1, events.port2]) port.close();
});

it("admits only exact cold source identities and explicit startup restore disposition",()=>{
 const sourceId="123e4567-e89b-42d3-a456-426614174001",base={version:PROTOCOL_VERSION,id:1};
 expect(decodeNativeCheckpointRequest({...base,type:"cold-start",sourceId})).toMatchObject({sourceId});
 expect(()=>decodeNativeCheckpointRequest({...base,type:"cold-start",sourceId:"../untrusted"})).toThrow();
 const restore={...base,type:"restore",startup:true,snapshot:{id:sourceId,createdAt:"2026-10-13T00:00:00.000Z"}};
 expect(decodeNativeCheckpointRequest(restore)).toEqual(restore);
 expect(()=>decodeNativeCheckpointRequest({...restore,startup:false})).toThrow();
});
