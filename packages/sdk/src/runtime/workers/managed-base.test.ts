import { describe, expect, it, vi, type MockInstance } from "vitest";
import { sha256Hex } from "./snapshot-content.js";

import { ManagedBases } from "./managed-base.js";
import { MemoryDirectory } from "./opfs-double.test-support.js";

const STEM = "alpine-2026.10.02-" + "c".repeat(64);

function imagesWithPack(): MemoryDirectory {
  const images = new MemoryDirectory("managed-images");
  images.file(`${STEM}.pack`, true).setBytes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
  return images;
}

describe("shared managed bases", () => {
  it("checks only requested chunks, shares proofs across leases and rechecks after reopening", async () => {
    const images=imagesWithPack(),file=images.file(`${STEM}.pack`,false),bases=new ManagedBases();
    const chunks=await Promise.all([Uint8Array.of(1,2,3,4),Uint8Array.of(5,6,7,8)].map(async bytes=>({bytes:bytes.length,sha256:await sha256Hex(bytes)})));
    const opened=file.createSyncAccessHandle.bind(file);
    const reads: MockInstance<FileSystemSyncAccessHandle["read"]>[]=[];
    vi.spyOn(file,"createSyncAccessHandle").mockImplementation(async()=>{const handle=await opened();reads.push(vi.spyOn(handle,"read"));return handle;});
    const first=await bases.acquire(images,STEM,chunks),second=await bases.acquire(images,STEM,chunks);
    try {
      expect(reads[0]).not.toHaveBeenCalled();
      first.read(0,new Uint8Array(1));second.read(1,new Uint8Array(1));
      expect(reads[0]?.mock.calls.filter(([bytes])=>bytes instanceof Uint8Array&&bytes.byteLength===4)).toHaveLength(1);
      // The unused second chunk is still checked before its first bytes reach the guest.
      file.setBytes(Uint8Array.of(1,2,3,4,9,6,7,8));
      const output=new Uint8Array(1);
      expect(()=>second.read(4,output)).toThrowError("Cached image chunk is damaged");
      expect(output).toEqual(Uint8Array.of(0));
    } finally {first.release();second.release();}
    file.setBytes(Uint8Array.of(9,2,3,4,5,6,7,8));
    const reopened=await bases.acquire(images,STEM,chunks);
    try {expect(()=>reopened.read(0,new Uint8Array(1))).toThrow();}finally{reopened.release();}
  });

  it("invalidates shared chunk proofs after successful and failed repairs", async () => {
    const images=imagesWithPack(),bases=new ManagedBases();
    const chunks=[{bytes:8,sha256:await sha256Hex(Uint8Array.of(1,2,3,4,5,6,7,8))}];
    const lease=await bases.acquire(images,STEM,chunks);
    try {
      lease.read(0,new Uint8Array(1));
      await bases.repair(images,STEM,handle=>{handle.write(Uint8Array.of(9),{at:0});return Promise.resolve();});
      expect(()=>lease.read(0,new Uint8Array(1))).toThrow();
      await bases.repair(images,STEM,handle=>{handle.write(Uint8Array.of(1),{at:0});return Promise.resolve();});
      expect(()=>lease.read(0,new Uint8Array(1))).not.toThrow();
      await expect(bases.repair(images,STEM,handle=>{handle.write(Uint8Array.of(9),{at:0});return Promise.reject(new Error("repair failed"));})).rejects.toThrow("repair failed");
      expect(()=>lease.read(0,new Uint8Array(1))).toThrow();
    }finally{lease.release();}
  });

  it("rejects a conflicting chunk layout and keeps the existing lease usable", async () => {
    const images=imagesWithPack(),bases=new ManagedBases(),chunks=[{bytes:8,sha256:await sha256Hex(Uint8Array.of(1,2,3,4,5,6,7,8))}];
    const lease=await bases.acquire(images,STEM,chunks);
    try {
      await expect(bases.acquire(images,STEM,[{bytes:8,sha256:"0".repeat(64)}])).rejects.toMatchObject({code:"STORAGE_ERROR"});
      const output=new Uint8Array(2);lease.read(3,output);expect(output).toEqual(Uint8Array.of(4,5));
    }finally{lease.release();}
    expect(images.locked).toBe(false);
  });

  it("closes a newly opened handle when its expected layout has the wrong length",async()=>{
    const images=imagesWithPack();
    await expect(new ManagedBases().acquire(images,STEM,[{bytes:7,sha256:"0".repeat(64)}])).rejects.toMatchObject({code:"STORAGE_ERROR"});
    expect(images.locked).toBe(false);
  });

  it("lets two disks of one image read its base through a single sync handle", async () => {
    const images = imagesWithPack();
    const bases = new ManagedBases();

    const [first, second] = await Promise.all([bases.acquire(images, STEM), bases.acquire(images, STEM)]);
    const left = new Uint8Array(2);
    const right = new Uint8Array(3);
    first.read(2, left);
    second.read(5, right);

    expect([...left]).toEqual([3, 4]);
    expect([...right]).toEqual([6, 7, 8]);
    first.release();
    second.release();
  });

  it("closes the handle after the last lease, so the pack can be removed", async () => {
    const images = imagesWithPack();
    const bases = new ManagedBases();
    const first = await bases.acquire(images, STEM);
    const second = await bases.acquire(images, STEM);

    first.release();
    await expect(images.removeEntry(`${STEM}.pack`)).rejects.toMatchObject({ name: "NoModificationAllowedError" });
    second.release();
    await images.removeEntry(`${STEM}.pack`);

    expect(images.names()).toEqual([]);
  });

  it("refuses reads through a released lease", async () => {
    const lease = await new ManagedBases().acquire(imagesWithPack(), STEM);
    lease.release();

    expect(() => lease.read(0, new Uint8Array(1))).toThrow();
  });

  it("reports a missing pack as a missing base", async () => {
    let failure: unknown;
    try {
      await new ManagedBases().acquire(new MemoryDirectory("managed-images"), STEM);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "STORAGE_NOT_FOUND", detail: { reason: "base-missing" } });
  });
});
