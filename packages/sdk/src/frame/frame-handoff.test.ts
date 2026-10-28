import {afterEach,expect,it,vi} from "vitest";
import {VMError} from "../runtime/errors.js";
import {handoffOverPort} from "./client/handoff.js";
import {serveFrame} from "./host/server.js";
import {closeChannels,connect,fakeVM} from "./frame-vm.test-support.js";
import type {WorkspaceMovedAway} from "../contracts.js";
afterEach(closeChannels);
it("requests the storage-origin handoff before creating a VM and preserves failures",async()=>{
  const ports=new MessageChannel(),create=vi.fn(()=>Promise.resolve(fakeVM().vm));
  const handoff=vi.fn(()=>Promise.resolve("released" as const));
  serveFrame(ports.port2,{embedderOrigin:"https://page.test",create,eraseLocalData:()=>Promise.resolve(),requestWorkspaceHandoff:handoff});
  try {
    expect(await handoffOverPort(ports.port1,"ws",{timeoutMs:42})).toBe("released");
    expect(create).not.toHaveBeenCalled();expect(handoff).toHaveBeenCalledWith("ws",expect.objectContaining({timeoutMs:42}));
  } finally {ports.port1.close();ports.port2.close();}
  const failed=new MessageChannel();serveFrame(failed.port2,{embedderOrigin:"https://page.test",create,eraseLocalData:()=>Promise.resolve(),requestWorkspaceHandoff:()=>Promise.reject(new VMError("STORAGE_ERROR","save failed"))});
  try {await expect(handoffOverPort(failed.port1,"ws")).rejects.toMatchObject({code:"STORAGE_ERROR",message:"save failed"});}
  finally {failed.port1.close();failed.port2.close();}
});
it.each(["system","userspace"] as const)("opts in to %s holder handoff until revoked",async(mode)=>{
  const {vm:system}=fakeVM(),vm=mode==="system"?system:{...system,spawnJS: (): Promise<never> => Promise.reject(new Error("Unused JS worker fake")),mode,image:{...system.image,mode}};
  const connected=await connect(vm),request=new AbortController();
  const moved=Promise.withResolvers<WorkspaceMovedAway>();const subscription=connected.client.allowWorkspaceHandoff(moved.resolve,{signal:request.signal});
  await vi.waitFor(()=>expect(system.allowWorkspaceHandoff).toHaveBeenCalledOnce());
  const call=system.allowWorkspaceHandoff.mock.calls[0];if(call===undefined) throw new Error("missing handoff registration");
  call[0]({saved:true});expect(await moved.promise).toEqual({saved:true});request.abort();await subscription;
  await vi.waitFor(()=>expect(call[1].signal.aborted).toBe(true));await connected.client.dispose();
});

it("propagates unavailable hosted holder registration as a typed rejection",async()=>{
 const {vm}=fakeVM();vm.allowWorkspaceHandoff.mockRejectedValue(new VMError("FEATURE_NOT_AVAILABLE","snapshot owner is unavailable",{reason:"release-gate-open"}));
 const connected=await connect(vm);await expect(connected.client.allowWorkspaceHandoff(()=>{}, {signal:new AbortController().signal})).rejects.toMatchObject({code:"FEATURE_NOT_AVAILABLE",detail:{reason:"release-gate-open"}});await connected.client.dispose();
});

it.each(["system", "userspace"] as const)("rejects malformed hosted %s handoff registrations without sending them", async mode => {
  const { vm: system } = fakeVM(), vm = mode === "system" ? system : { ...system, spawnJS: (): Promise<never> => Promise.reject(new Error("Unused JS worker fake")), mode, image: { ...system.image, mode } };
  const connected = await connect(vm);
  const untyped: { allowWorkspaceHandoff(listener: unknown, options?: unknown): Promise<void> } = connected.client;
  try {
    const cases: readonly [unknown, (signal: AbortSignal) => unknown][] = [
      [null, signal => ({ signal })], [42, signal => ({ signal })],
      [() => {}, () => undefined], [() => {}, () => null], [() => {}, () => ({})],
      [() => {}, () => ({ signal: {} })], [() => {}, signal => ({ signal, unexpected: true })],
    ];
    for (const [listener, options] of cases) {
      const controller = new AbortController();
      const rejection = expect(untyped.allowWorkspaceHandoff(listener, options(controller.signal))).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      controller.abort();
      await rejection;
      expect(system.allowWorkspaceHandoff).not.toHaveBeenCalled();
      expect(system.dispose).not.toHaveBeenCalled();
    }
  } finally { await connected.client.dispose(); }
});

it("ends a valid hosted handoff subscription when the VM is disposed", async () => {
  const { vm } = fakeVM(), connected = await connect(vm), moved = vi.fn();
  const subscription = connected.client.allowWorkspaceHandoff(moved, { signal: new AbortController().signal });
  await vi.waitFor(() => expect(vm.allowWorkspaceHandoff).toHaveBeenCalledOnce());
  const call = vm.allowWorkspaceHandoff.mock.calls[0];
  if (call === undefined) throw new Error("missing holder listener");
  await connected.client.dispose(); await subscription;
  expect(moved).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(call[1].signal.aborted).toBe(true));
});
