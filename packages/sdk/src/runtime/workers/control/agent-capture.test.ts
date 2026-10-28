import { expect, it, vi } from "vitest";
import { AgentPayloadWriter } from "../../agent-protocol.js";
import { AgentCaptureProgress, openAgentCapture } from "./agent-capture.js";
import { VMError } from "../../errors.js";
import { encodeWorkspaceCaptureProgress } from "../../protocol/workspace-capture.js";

const length = (bytes: number) => new AgentPayloadWriter().u64(BigInt(bytes)).finish();
it("pulls bounded capture frames and confirms producer retirement before EOF", async () => {
  const offsets: number[] = [];
  const send = vi.fn((operation: { kind: "read"; offset: number } | { kind: "finish" | "abort" }) => {
    if (operation.kind === "read") {
      offsets.push(operation.offset);
      return Promise.resolve(new Uint8Array(Math.min(65_536, 70_000 - operation.offset)));
    }
    return Promise.resolve(operation.kind === "finish" ? length(70_000) : new Uint8Array());
  });
  const controller = new AbortController();
  const capture = await openAgentCapture(Promise.resolve(length(70_000)), send, controller.signal);
  const source = capture.source(controller.signal);
  let bytes = 0;
  for await (const frame of source.frames) bytes += frame.length;
  await source.retire();
  expect(bytes).toBe(70_000);
  expect(offsets).toEqual([0, 65_536, 70_000]);
  expect(send.mock.calls.at(-1)?.[0]).toEqual({ kind: "finish" });
  expect(() => capture.source(controller.signal)).toThrow();
});

it("cancels planning before begin responds and waits for its retirement", async () => {
  const ready = Promise.withResolvers<Uint8Array<ArrayBuffer>>();
  const retired = Promise.withResolvers<Uint8Array<ArrayBuffer>>();
  const send = vi.fn(() => retired.promise);
  const controller = new AbortController();
  const pending = openAgentCapture(ready.promise, send, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ code: "ABORTED" });
  controller.abort();
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ kind: "abort" }));
  ready.resolve(length(12));
  retired.resolve(new Uint8Array());
  await rejected;
});

it("retains failed retirement as uncertainty instead of reporting successful cancellation", async () => {
  const signal = AbortSignal.abort();
  const retired = vi.fn();
  await expect(openAgentCapture(Promise.resolve(length(12)), () => Promise.reject(new Error("lost abort receipt")), signal, retired))
    .rejects.toMatchObject({ detail: { cleanupFailed: true } });
  expect(retired).not.toHaveBeenCalled();
});

it("retains monotonic per-transfer progress until retirement or a generation reset", () => {
  const progress = new AgentCaptureProgress(), receive = vi.fn();
  const retire = progress.open(2, receive), otherRetire = progress.open(3, receive);
  const report = (transfer: number, phase: string, entries: number) => progress.receive(transfer,
    encodeWorkspaceCaptureProgress({ phase, entries }));
  report(2, "scan", 256); report(2, "scan", 256); report(2, "scan", 512);
  report(3, "plan", 2_000_000);
  report(2, "plan", 512); report(2, "rescan", 256);
  expect(receive).toHaveBeenCalledTimes(6);
  expect(() => report(2, "scan", 1024)).toThrow();
  expect(() => report(2, "rescan", 255)).toThrow();
  expect(() => report(2, "rescan", 1_000_001)).toThrow();
  expect(() => report(4, "scan", 256)).toThrow();
  expect(() => progress.receive(2, Uint8Array.of(1))).toThrow();
  expect(() => progress.open(4, receive)).toThrow();
  retire();
  expect(() => report(2, "rescan", 512)).toThrow();
  progress.clear();
  progress.open(3, receive);
  otherRetire(); // An old receipt cannot release the new generation's identity.
  report(3, "scan", 256);
  expect(receive).toHaveBeenCalledTimes(7);
  for (const transfer of [0, -1, 0x1_0000_0000, NaN]) expect(() => progress.open(transfer, receive)).toThrow();
});

it("preserves a rejected capture begin when abort retirement also fails", async () => {
  await expect(openAgentCapture(Promise.reject(new VMError("INVALID_ARGUMENT", "baseline input is invalid")),
    () => Promise.reject(new VMError("INVALID_ARGUMENT", "capture transfer was never registered")),
    new AbortController().signal)).rejects.toMatchObject({ code: "STORAGE_ERROR", detail: {
      cleanupFailed: true, originalError: { code: "INVALID_ARGUMENT", message: "baseline input is invalid" },
      retirementError: { code: "INVALID_ARGUMENT", message: "capture transfer was never registered" },
    } });
});

it.each(["finish","abort"] as const)("releases capture progress exactly once after acknowledged %s",async ending=>{
 const retired=vi.fn(),controller=new AbortController();
 const send=vi.fn((operation:{kind:"read";offset:number}|{kind:"finish"|"abort"})=>Promise.resolve(
  operation.kind==="read"?new Uint8Array(operation.offset===0?12:0):operation.kind==="finish"?length(12):new Uint8Array()));
 const capture=await openAgentCapture(Promise.resolve(length(12)),send,controller.signal,retired);
 if(ending==="finish"){for await(const frame of capture.source(controller.signal).frames)expect(frame.length).toBe(12);}
 else controller.abort();
 await capture.retire();await capture.retire();
 expect(retired).toHaveBeenCalledTimes(1);
 expect(send.mock.calls.filter(([operation])=>operation.kind===ending)).toHaveLength(1);
});
it("does not release capture progress when finish retirement has an invalid receipt",async()=>{
 const retired=vi.fn(),controller=new AbortController();
 const capture=await openAgentCapture(Promise.resolve(length(12)),operation=>Promise.resolve(
  operation.kind==="read"?new Uint8Array(operation.offset===0?12:0):length(13)),controller.signal,retired);
 const read=async()=>{for await(const frame of capture.source(controller.signal).frames)expect(frame.length).toBe(12);};
 await expect(read()).rejects.toMatchObject({detail:{cleanupFailed:true}});
 expect(retired).not.toHaveBeenCalled();
});
