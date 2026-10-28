import { expect, it } from "vitest";
import { RootfsImagePreparation } from "./rootfs-image-preparation.js";

it("shares acquisition, promotes a manual waiter, and cancels only the departing consumer",async()=>{
  const end=Promise.withResolvers<undefined>();let calls=0,priority:()=>boolean=()=>false,workSignal:AbortSignal|undefined;
  const run=async(signal:AbortSignal,foreground:()=>boolean)=>{calls++;workSignal=signal;priority=foreground;await end.promise;};
  const owner=new RootfsImagePreparation();
  const cancellation=new AbortController(),background=owner.prepare("image",{background:true,signal:cancellation.signal},run);
  const failed=background.catch((error:unknown)=>error);
  await Promise.resolve();expect(priority()).toBe(false);
  const manual=owner.prepare("image",{},run);expect(priority()).toBe(true);cancellation.abort();
  expect(await failed).toMatchObject({code:"ABORTED"});expect(workSignal?.aborted).toBe(false);
  end.resolve(undefined);await manual;expect(calls).toBe(1);
  await owner.prepare("image",{},run);expect(calls).toBe(2);
});

it("retires underlying work after the final consumer cancels",async()=>{
  const run=(signal:AbortSignal)=>new Promise<void>((resolve)=>signal.addEventListener("abort",()=>resolve(),{once:true}));
  const owner=new RootfsImagePreparation();
  const cancellation=new AbortController(),work=owner.prepare("image",{signal:cancellation.signal},run);
  const failed=work.catch((error:unknown)=>error);await Promise.resolve();cancellation.abort();
  expect(await failed).toMatchObject({code:"ABORTED"});
  await owner.drain();
});
