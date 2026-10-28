import {afterEach,expect,it,vi} from "vitest";
import {captureWhenQuiesced,poll,waitPort} from "./readiness.js";
import {VMError} from "../../runtime/errors.js";
import type {VM,ListeningPort} from "../../contracts.js";
afterEach(()=>vi.useRealTimers());
it("wait_until_polls_predicate_not_sleep",async()=>{
  vi.useFakeTimers();let calls=0;
  const waiting=poll(()=>++calls===3,new AbortController().signal);
  await vi.advanceTimersByTimeAsync(249);expect(calls).toBe(1);
  await vi.advanceTimersByTimeAsync(251);await waiting;expect(calls).toBe(3);
});
it("wait_port_observes_before_subscribe_race",async()=>{
  const actual:ListeningPort={port:3000,address:"0.0.0.0",program:"node",previewable:true};
  const vm:Pick<VM,"listeningPorts"|"watchListeningPorts">={
    listeningPorts:()=>Promise.resolve([]),
    watchListeningPorts:(listener,{signal})=>{
      listener([actual]);
      return new Promise<void>(resolve=>{signal.addEventListener("abort",()=>resolve(),{once:true});});
    },
  };
  await expect(waitPort(vm,3000,new AbortController().signal)).resolves.toEqual(actual);
});
const notQuiesced=()=>new VMError("PROTOCOL_ERROR","Native checkpoint could not begin",{reason:"checkpoint-begin-rejected",phase:"initial-round",domain:"runtime",owner:"files",nativeReason:4,scalar0:0,scalar1:0,nativeCauses:["not-quiesced"]});
it("capture_waits_out_a_guest_that_is_not_quiesced_yet",async()=>{
  vi.useFakeTimers();let calls=0;
  const capturing=captureWhenQuiesced(()=>++calls<3?Promise.reject(notQuiesced()):Promise.resolve("captured"),new AbortController().signal);
  await vi.advanceTimersByTimeAsync(5_000);
  await expect(capturing).resolves.toBe("captured");expect(calls).toBe(3);
});
it("capture_does_not_retry_other_checkpoint_failures",async()=>{
  const other=new VMError("PROTOCOL_ERROR","Native checkpoint could not begin",{reason:"checkpoint-begin-rejected",owner:"files",nativeCauses:["poisoned"]});
  let calls=0;
  await expect(captureWhenQuiesced(()=>{calls++;return Promise.reject(other);},new AbortController().signal)).rejects.toBe(other);
  expect(calls).toBe(1);
});
it("capture_retry_stops_when_its_deadline_aborts",async()=>{
  vi.useFakeTimers();const deadline=new AbortController();
  const capturing=captureWhenQuiesced(()=>Promise.reject(notQuiesced()),deadline.signal);
  const settled=expect(capturing).rejects.toMatchObject({code:"ABORTED"});
  await vi.advanceTimersByTimeAsync(1_000);deadline.abort(new VMError("ABORTED","Snapshot helper deadline expired"));
  await vi.advanceTimersByTimeAsync(5_000);await settled;
});
