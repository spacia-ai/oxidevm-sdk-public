import {createVM,defineImage,VMError,type VM} from "./sdk.js";
import {decodeTrustedImageKey} from "../../image.js";
import {exactKeys,record,string} from "../../runtime/decode.js";
import {builtInCommandInterceptors, decodePublicVMOptions} from "../../vm-options.js";
import {decodeSerializedShippedSnapshot} from "../../runtime/protocol/shipped-source.js";
import {detectBrowserSupport} from "../../runtime/browser-support.js";
export function assertSnapshotBrowserSupport():void {
  const capabilities:Partial<Navigator>=navigator;
  if(!detectBrowserSupport().supported||!isSecureContext||!crossOriginIsolated||typeof capabilities.storage?.getDirectory!=="function"
    ||typeof capabilities.locks?.request!=="function"||typeof indexedDB!=="object"||!("serviceWorker" in navigator)) {
    throw new VMError("FEATURE_NOT_AVAILABLE","Snapshot authoring requires secure isolated durable browser capabilities",{reason:"snapshot-browser-unavailable"});
  }
}
export async function openSnapshotVM(config:Readonly<Record<string,unknown>>,mode:"system"|"userspace",action:"prepare"|"verify",signal:AbortSignal):Promise<VM> {
  const image=record(config["image"],"image location");exactKeys(image,["mode","manifestUrl","manifestSHA256","trust"]);
  if(image["mode"]!==mode)throw new VMError("PROTOCOL_ERROR","Image mode differs from snapshot mode");
  const imageProperties={manifestUrl:string(image["manifestUrl"],"image URL"),manifestSHA256:string(image["manifestSHA256"],"image hash"),trust:decodeTrustedImageKey(image["trust"])};
  const shipped=config["shipped"]===undefined?undefined:decodeSerializedShippedSnapshot(config["shipped"]);
  const vmConfig=record(config["vm"],"snapshot VM resources");
  // Native checkpoints cannot retain browser JavaScript workers.
  const options=decodePublicVMOptions({...vmConfig,mode,...(mode==="userspace"?{commandInterceptors:"off"}:{}),image:defineImage({mode,...imageProperties}),...(shipped===undefined?{}:{shippedSnapshot:shipped}),
    workspaceId:`snapshot_${action}_${crypto.randomUUID().replaceAll("-","")}`,restorePoint:action==="prepare"?"none":"latest",
    runtime:{hosting:"self-hosted",baseUrl:"/oxidevm/runtime/"},preview:{origin:`http://preview.localhost:${location.port}`,isolation:"per-session"},signal});
  const common={workspaceId:options.workspaceId,runtime:options.runtime,network:options.network,...(options.preview===undefined?{}:{preview:options.preview}),signal,restorePoint:options.resume,
    ...(options.memoryMiB===undefined?{}:{memoryMiB:options.memoryMiB})};
  if(options.mode==="system")return createVM({...common,mode:"system",...(options.image===undefined?{}:{image:options.image}),vcpus:options.vcpus,...(options.shipped===undefined?{}:{shippedSnapshot:options.shipped})});
  return createVM({...common,mode:"userspace",commandInterceptors:builtInCommandInterceptors(options),...(options.image===undefined?{}:{image:options.image}),...(options.processLimitExplicit?{limits:options.limits}:{}),
    ...(options.initialUser===undefined?{}:{initialUser:options.initialUser}),...(options.rootPersistence===undefined?{}:{rootPersistence:options.rootPersistence}),...(options.shipped===undefined?{}:{shippedSnapshot:options.shipped})});
}
