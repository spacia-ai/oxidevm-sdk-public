import { describe, expect, it } from "vitest";
import { decodePreparedManagedImage } from "./storage.js";

const image = { id: "debian-next-bun-x86_64", version: "development", memoryMiB: 1536, vcpus: 1,
  kernel: new Uint8Array([1]), commandLine: "root=/dev/vda", diskBytes: 8192,
  aot: { kind: "skipped", reason: "no-catalog" },
  runtimes: { debian: "13.7", glibc: "2.41", node: "24.18.1", bun: "1.3.14", next: "16.2.12" } };
describe("prepared managed image runtime boundary", () => {
  it("preserves Debian/glibc identity and rejects mixed or incomplete metadata", () => {
    expect(decodePreparedManagedImage(image).runtimes).toEqual(image.runtimes);
    expect(() => decodePreparedManagedImage({ ...image, runtimes: { ...image.runtimes, alpine: "3.24" } })).toThrow();
    expect(() => decodePreparedManagedImage({ ...image, runtimes: { debian: "13.7", node: "24", bun: "1", next: "16" } })).toThrow();
    expect(decodePreparedManagedImage({ ...image, runtimes: { alpine: "3.24", node: "24", bun: "1", next: "16" } }).runtimes).toHaveProperty("alpine", "3.24");
  });
});

it("prepared images retain verified manifest identity and reject mismatched public metadata", () => {
  const identity = {id:"image",version:"1",mode:"system",manifestSHA256:"a".repeat(64),cpuProfile:"x86-64-v3",keyId:"trusted",signatureVerified:true};
  const image = {id:"image",version:"1",memoryMiB:256,vcpus:1,kernel:new Uint8Array(1),commandLine:"",diskBytes:512,aot:{kind:"skipped",reason:"no-catalog"},runtimes:{alpine:"3.24",node:"24",bun:"1",next:"16"},identity};
  expect(decodePreparedManagedImage(image).identity).toEqual(identity);
  expect(()=>decodePreparedManagedImage({...image,identity:{...identity,id:"other"}})).toThrow();
  expect(()=>decodePreparedManagedImage({...image,identity:{...identity,signatureVerified:false}})).toThrow();
});
