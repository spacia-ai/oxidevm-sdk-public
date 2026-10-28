import {expect,it} from "vitest";
import {UserspaceRootPersistence} from "./userspace-root-persistence.js";
import {UserspaceStorageClient} from "./userspace-storage-channel.js";
import {serveUserspaceStorage} from "./userspace-storage-server.js";
import {UserspaceRootStorage} from "./userspace-root-storage.js";
import {MemoryDirectory} from "./opfs-double.test-support.js";
import {opfsWorkspaceStoreBackend} from "./workspace-backend.js";

it("configures a restore scaffold without replay and configures a remount exactly once",async()=>{
 const channel=new MessageChannel(),storage=new UserspaceStorageClient(channel.port1),owner=new UserspaceRootStorage(opfsWorkspaceStoreBackend(new MemoryDirectory()));
 const requests:string[]=[],generations:number[]=[];
 const server=serveUserspaceStorage(channel.port2,(request,signal)=>{requests.push(request.type);if(request.type==="open-root-overlay")generations.push(request.binding.generation);return owner.handle(request,signal);});
 let configured=false,configurations=0;
 const runtime={memory:new WebAssembly.Memory({initial:1}),instance:{exports:{
   oxidevm_userspace_staging_resize:()=>0,oxidevm_userspace_staging_ptr:()=>0,
   oxidevm_userspace_configure_root_persistence:()=>{if(configured)return 1;configured=true;configurations++;return 0;},
 }} satisfies WebAssembly.Instance};
 const root=new UserspaceRootPersistence(runtime,storage,"a".repeat(64),()=>{},()=>{});
 try {
  root.configure();root.configure();expect(configurations).toBe(1);expect(requests).toEqual([]);
  // An automatic restore replaces this configured scaffold before any root read bound storage.
  const initialRestore=root.restored(runtime,"a".repeat(64),()=>{},()=>{});
  await initialRestore.initialize();expect(configurations).toBe(1);expect(generations).toEqual([1,1]);
  const restored=initialRestore.restored(runtime,"a".repeat(64),()=>{},()=>{});
  restored.configure();expect(configurations).toBe(1);
  // Native startup discard remounts a fresh zero-process owner in this same memory.
  configured=false;
  const fresh=restored.remounted(runtime,"a".repeat(64),()=>{},()=>{});
  fresh.configure();await fresh.initialize();expect(configurations).toBe(2);
  expect(generations).toEqual([1,1,2,2]);
  await expect(root.initialize()).rejects.toMatchObject({code:"ABORTED"});
 }finally{storage.close();await server.close();await owner.close();}
});
