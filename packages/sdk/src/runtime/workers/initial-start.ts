import {exactKeys,record} from "../decode.js";
import {VMError} from "../errors.js";
import {decodeShippedInstallIdentity,sameShippedIdentity,type ShippedInstallIdentity} from "../protocol/shipped-source.js";
import type {InitialStartState} from "../protocol/initial-start.js";
import {readDiskHead} from "./managed-disk-head.js";
import {isNotFound,readOpfsFile,writeOpfsFile} from "./snapshot-objects.js";
import {SnapshotCatalog} from "./snapshot-catalog.js";
import {WorkspaceSelections} from "./workspace-selections.js";
import type {WorkspaceStoreBackend} from "./workspace-store.js";
const INTENT="initial-start.json",MAX_BYTES=4096;
const V2_DIRECTORY="initial-start-v2",V2_SOURCE="source.json";
const RETIRED="initial-start-retired.json";

/** One classification under the storage lease, before managed preparation writes. */
export class InitialStart {
  readonly #root:FileSystemDirectoryHandle;
  #state:InitialStartState;
  private constructor(root:FileSystemDirectoryHandle,state:InitialStartState){this.#root=root;this.#state=state;}
  state():InitialStartState{return this.#state;}
  requirePending(source:ShippedInstallIdentity):void {
    if(this.#state.kind!=="pending"||!sameShippedIdentity(this.#state.source,source))throw new VMError("INVALID_ARGUMENT","Initial publication does not match the pending source");
  }
  static async open(root:FileSystemDirectoryHandle,backend:WorkspaceStoreBackend):Promise<InitialStart> {
    const disk=await directory(root,"managed-disks");
    const head=disk===undefined?undefined:await readDiskHead(disk);
    const files=await new WorkspaceSelections(backend).initialStartEvidence();
    const completed=head?.initialStart??files.initialStart;
    if(completed!==undefined) {
      // The durable head owns completion; an obsolete intent no longer admits a source.
      await root.removeEntry(INTENT).catch((error:unknown)=>{if(!isNotFound(error))throw error;});
      await root.removeEntry(V2_DIRECTORY,{recursive:true}).catch((error:unknown)=>{if(!isNotFound(error))throw error;});
      return new InitialStart(root,{kind:"existing"});
    }
    if(await hasRetiredIntent(root))return new InitialStart(root,{kind:"existing"});
    const pending=await readIntent(root);
    if(pending!==undefined)return new InitialStart(root,{kind:"pending",source:pending});
    if(head!==undefined||files.existing||await hasLegacyDisk(disk)||await hasUserPoints(root))return new InitialStart(root,{kind:"existing"});
    return new InitialStart(root,{kind:"empty"});
  }
  async begin(source:ShippedInstallIdentity):Promise<InitialStartState> {
    source=decodeShippedInstallIdentity(source);
    if(this.#state.kind==="existing"||this.#state.kind==="pending"&&!sameShippedIdentity(this.#state.source,source)) {
      throw new VMError("INVALID_ARGUMENT","This workspace cannot initialize from the requested prepared state",{reason:"shipped-incompatible"});
    }
    if(this.#state.kind==="empty") {
      const staged=await this.#root.getDirectoryHandle(V2_DIRECTORY,{create:true});
      await writeOpfsFile(staged,V2_SOURCE,new TextEncoder().encode(JSON.stringify({format:"oxidevm-initial-start",version:2,source})));
      this.#state={kind:"pending",source};
    }
    return this.#state;
  }
  /** Called after a deliberate startup commits, before its VM is exposed to the user. */
  async retire():Promise<void> {
    if(this.#state.kind!=="pending")return;
    await writeOpfsFile(this.#root,RETIRED,new TextEncoder().encode(JSON.stringify({format:"oxidevm-initial-start-retired",version:1,source:this.#state.source})));
    this.#state={kind:"existing"};
  }
}
async function hasRetiredIntent(root:FileSystemDirectoryHandle):Promise<boolean> {
  let bytes:Uint8Array<ArrayBuffer>;
  try{bytes=await readOpfsFile(root,RETIRED,MAX_BYTES);}catch(error){if(isNotFound(error))return false;throw error;}
  if(bytes.length===0)return false;
  decodeIntent(bytes,1,"oxidevm-initial-start-retired");return true;
}
async function readIntent(root:FileSystemDirectoryHandle):Promise<ShippedInstallIdentity|undefined> {
  let pending:ShippedInstallIdentity|undefined;
  const staged=await directory(root,V2_DIRECTORY);
  if(staged!==undefined){
    for await(const [name,handle] of staged.entries())if(name!==V2_SOURCE||handle.kind!=="file")throw new VMError("STORAGE_ERROR","Initial source staging has an unknown artifact");
    let bytes:Uint8Array<ArrayBuffer>|undefined;
    try{bytes=await readOpfsFile(staged,V2_SOURCE,MAX_BYTES);}catch(error){if(!isNotFound(error))throw error;}
    // Empty creation is an unpublished v2 write; a nonempty record must decode exactly.
    if(bytes!==undefined&&bytes.length!==0)pending=decodeIntent(bytes,2);
  }
  let bytes:Uint8Array<ArrayBuffer>;
  try {bytes=await readOpfsFile(root,INTENT,MAX_BYTES);} catch(error){if(isNotFound(error))return pending;throw error;}
  const legacy=decodeIntent(bytes,1);
  if(pending!==undefined&&!sameShippedIdentity(pending,legacy))throw new VMError("STORAGE_ERROR","Initial source records conflict");
  return pending??legacy;
}
function decodeIntent(bytes:Uint8Array<ArrayBuffer>,version:1|2,format="oxidevm-initial-start"):ShippedInstallIdentity {
  let value:unknown;
  try{value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}
  catch{throw new VMError("STORAGE_ERROR","Initial source record is damaged");}
  const intent=record(value,"initial start intent");exactKeys(intent,["format","version","source"]);
  if(intent["format"]!==format||intent["version"]!==version)throw new VMError("STORAGE_ERROR","Initial start intent is unsupported");
  return decodeShippedInstallIdentity(intent["source"]);
}
async function directory(root:FileSystemDirectoryHandle,name:string):Promise<FileSystemDirectoryHandle|undefined> {
  try{return await root.getDirectoryHandle(name);}catch(error){if(isNotFound(error))return undefined;throw error;}
}
async function hasLegacyDisk(disks:FileSystemDirectoryHandle|undefined):Promise<boolean> {
  if(disks===undefined)return false;
  for await(const [,handle] of disks.entries())if(handle.kind==="directory")for await(const [name] of handle.entries())if(name!=="reserve")return true;
  return false;
}
async function hasUserPoints(root:FileSystemDirectoryHandle):Promise<boolean> {
  const snapshots=await directory(root,"snapshots-v2");if(snapshots===undefined)return false;
  const commits=await directory(snapshots,"commits");if(commits===undefined)return false;
  let scanned=0;
  for await(const id of commits.keys()) {
    if(++scanned>4096)throw new VMError("STORAGE_ERROR","Initial catalogue exceeds inspection bound");
    const entry=await SnapshotCatalog.inspectEntry(snapshots,id);
    if(entry!==undefined&&entry.source===undefined)return true;
  }
  return false;
}
