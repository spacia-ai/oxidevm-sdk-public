import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {inspectRetainedStart} from "./retained-start.js";
import {decodePublicVMOptions} from "./vm-options.js";
import {defineImage} from "./image.js";
import {ScriptedWorker} from "./runtime/system-vm.test-support.js";
import {decodeSHA256} from "./values.js";
import {verifyImage} from "./verified-image.js";
vi.mock("./verified-image.js",()=>({verifyImage:vi.fn()}));
beforeEach(()=>{vi.mocked(verifyImage).mockRejectedValue(new TypeError("offline"));});
afterEach(()=>{ScriptedWorker.reset();vi.unstubAllGlobals();vi.resetAllMocks();});
async function image() {
  const key=await crypto.subtle.generateKey("Ed25519",true,["sign","verify"]);
  const publicKey=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey("spki",key.publicKey))));
  return defineImage({mode:"userspace",manifestUrl:"/new-default.json",manifestSHA256:"b".repeat(64),trust:{algorithm:"Ed25519",keyId:"test",publicKey}});
}
it("requests retained identity beforeVM initialization and always retires the temporary storage worker",async()=>{
  vi.stubGlobal("Worker",ScriptedWorker);const ref=await image();
  const selected={image:{id:"retained",version:"old",mode:"userspace",manifestSHA256:decodeSHA256("a".repeat(64),"test"),cpuProfile:"x86-64-v2",keyId:"test",signatureVerified:true},manifestUrl:"https://profiles.test/retained.json",memoryMiB:256} as const;
  ScriptedWorker.answers.set("inspect-start-image",()=>selected);
  const result=await inspectRetainedStart(decodePublicVMOptions({mode:"userspace",workspaceId:"ws",restorePoint:"latest"}),ref,"https://page.test/");
  expect(result).toEqual(selected);
  const worker=ScriptedWorker.named("oxidevm-start-image-inspection");
  expect(worker.operations).toEqual(["inspect-start-image"]);
});
it("skips inspection for ephemeral/reset/update starts and refuses anothermode",async()=>{
  vi.stubGlobal("Worker",ScriptedWorker);const ref=await image();
  for(const options of [{mode:"userspace"},{mode:"userspace",workspaceId:"ws",restorePoint:"fresh-image"},{mode:"userspace",workspaceId:"ws",restorePoint:"update-image"}]) expect(await inspectRetainedStart(decodePublicVMOptions(options),ref,"https://page.test/")).toBeNull();
  expect(ScriptedWorker.instances).toHaveLength(0);
  ScriptedWorker.answers.set("inspect-start-image",()=>({image:{id:"other",version:"1",mode:"system",manifestSHA256:"a".repeat(64),cpuProfile:"x86-64-v3",keyId:"test",signatureVerified:true},manifestUrl:"https://profiles.test/full.json",memoryMiB:256,vcpus:1}));
  await expect(inspectRetainedStart(decodePublicVMOptions({mode:"userspace",workspaceId:"ws"}),ref,"https://page.test/")).rejects.toMatchObject({code:"PROTOCOL_ERROR"});
});
it("returns retained metadata without waiting for uncached optional update discovery",async()=>{
  vi.stubGlobal("Worker",ScriptedWorker);const ref=await image();
  const selected={image:{id:"retained",version:"old",mode:"userspace",manifestSHA256:decodeSHA256("a".repeat(64),"test"),cpuProfile:"x86-64-v2",keyId:"test",signatureVerified:true},manifestUrl:"https://profiles.test/retained.json",memoryMiB:256} as const;
  ScriptedWorker.answers.set("inspect-start-image",()=>selected);
  vi.mocked(verifyImage).mockResolvedValue({info:{...selected.image,id:"new-default",version:"new",manifestSHA256:ref.manifestSHA256},memoryMiB:256});
  expect(await inspectRetainedStart(decodePublicVMOptions({mode:"userspace",workspaceId:"ws",restorePoint:"latest"}),ref,"https://page.test/")).toEqual(selected);
  expect(verifyImage).not.toHaveBeenCalled();
});
