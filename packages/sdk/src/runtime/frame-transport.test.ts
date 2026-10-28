import { expect, test } from "vitest";
import { createFrameTransport } from "./frame-transport.js";
import { encodeFrameRecords, FRAME_BRIDGE_RING_BYTES } from "./frame-bridge.js";

function pair() {
  const messagesToRouter: unknown[] = [], messagesToLinux: unknown[] = [];
  const control = createFrameTransport("message",{postMessage:message=>{messagesToRouter.push(message);}},"control");
  const router = createFrameTransport("message",{postMessage:message=>{messagesToLinux.push(message);}},"router");
  return {control,router,messagesToRouter,messagesToLinux};
}
test("message frames return bounded credit only after whole-frame consumption", () => {
  const {control,router,messagesToRouter,messagesToLinux}=pair();
  const records=encodeFrameRecords([new Uint8Array(1514),new Uint8Array(14)]);
  control.toRouter.write(records); expect(control.toRouter.freeBytes()).toBe(FRAME_BRIDGE_RING_BYTES-records.length);
  expect(router.receive(messagesToRouter.shift())).toBe(true);
  const scratch=new Uint8Array(1516);const peek=router.toRouter.peek(scratch);expect(peek.recordEnds).toEqual([1516]);
  expect(()=>router.toRouter.advance(1)).toThrow();router.toRouter.advance(peek.length);
  expect(control.toRouter.freeBytes()).toBe(FRAME_BRIDGE_RING_BYTES-records.length);
  control.receive(messagesToLinux.shift());expect(control.toRouter.freeBytes()).toBe(FRAME_BRIDGE_RING_BYTES-16);
  expect(()=>router.receive(messagesToRouter[0])).toThrow();
});
test("reset drops old-generation frames and credits; new router generation is explicit", () => {
  const {control,router,messagesToRouter,messagesToLinux}=pair();
  const records=encodeFrameRecords([new Uint8Array(14)]);control.toRouter.write(records);const stale=messagesToRouter.shift();
  control.advanceGeneration();router.receive(messagesToRouter.shift());expect(router.generation).toBe(1);
  expect(router.receive(stale)).toBe(true);expect(router.toRouter.usedBytes()).toBe(0);
  router.publishGeneration(1);control.receive(messagesToLinux.shift());expect(control.routerGeneration).toBe(1);
  control.toRouter.write(records);router.receive(messagesToRouter.shift());expect(router.toRouter.usedBytes()).toBe(16);
  expect(()=>router.advanceGeneration()).toThrow();
});
