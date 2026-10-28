// The pre-VM read belongs to the runtime's storage origin, including hosted frames.
import type { ImageRef } from "./image.js";
import { imagePublicKeyBytes } from "./image.js";
import type { RuntimeMode } from "./values.js";
import type { ValidatedVMOptions } from "./vm-options.js";
import type { PreparedStartImage } from "./runtime/protocol/start-image.js";
import { storageResponseDecoders, type StorageOperations } from "./runtime/protocol.js";
import { WorkerClient } from "./runtime/worker-client.js";
import { VMError } from "./runtime/errors.js";
export async function inspectRetainedStart(options:ValidatedVMOptions,image:ImageRef<RuntimeMode>,base:string):Promise<PreparedStartImage|null> {
  if(options.ephemeral||options.resume==="fresh-image"||options.resume==="update-image") return null;
  const storage=new WorkerClient<StorageOperations>(new Worker(new URL("./runtime/workers/storage.worker.js",import.meta.url),{type:"module",name:"oxidevm-start-image-inspection"}),storageResponseDecoders);
  try {
    const selected=await storage.request("inspect-start-image",{workspaceId:options.workspaceId,mode:options.mode,resume:options.resume,manifestUrl:new URL(image.manifestUrl,base).href,manifestSHA256:image.manifestSHA256,trustedKeyId:image.trust.keyId,trustedPublicKey:imagePublicKeyBytes(image.trust)},{signal:options.signal});
    if(selected!==null&&selected.image.mode!==options.mode) throw new VMError("PROTOCOL_ERROR","retained image inspection returned another runtime");
    return selected;
  } finally {storage.terminate();}
}
