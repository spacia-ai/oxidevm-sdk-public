import {guardLegacyFiles,readLegacySelection} from "./workspace-selections/legacy.js";
import type {ManagedBoot} from "../protocol/storage.js";
import type {WorkspaceReadLease} from "./workspace-read.js";
import { exactKeys, integer, record, string } from "../decode.js";
import { VMError } from "../errors.js";
import { decodeWorkspaceOverlayManifest, digest, parseJson, sha256, streamReferences, verifyDependencies } from "./workspace-manifest.js";
import { readWorkspaceStream, trackWorkspaceStream, WorkspaceStreamStaging } from "./workspace-stream.js";
import { WorkspaceStore, type WorkspaceStoreBackend } from "./workspace-store.js";
import { openUserspaceRootStore } from "./userspace-root-store.js";
import {decodeShippedInstallIdentity,type ShippedInstallIdentity} from "../protocol/shipped-source.js";

const HEAD = "selections/head.json";
const KEPT = "selections/kept/";
const METADATA_BYTES = 128 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
type Selection = ReadonlyMap<string, string | null>;
export interface NativeFileSession { readonly resume: string | null; readonly replaced?: string; readonly recovery?: string;readonly image?:string }
interface Head { readonly version: 1 | 2; readonly generation: number; readonly selected: Selection; readonly native?: NativeFileSession;readonly journals?:ReadonlyMap<string,string>;readonly preserved?:ReadonlySet<string>;readonly initialStart?:ShippedInstallIdentity }

export interface StagedWorkspaceSelection {
  readonly backend: WorkspaceStoreBackend;
  commit(signal: AbortSignal, session?: NativeFileSession,preservedId?:string,initialStart?:ShippedInstallIdentity): Promise<void>;
  abort(): Promise<void>;
}

/** One metadata commit selects workspace and writable root generations together.
 * WorkspaceStore retains stream publication, validation and reclamation ownership. */
export class WorkspaceSelections {
  readonly #raw: WorkspaceStoreBackend;
  readonly backend: WorkspaceStoreBackend;
  #queue = Promise.resolve();
  #mutations = Promise.resolve();
  #staged: string | undefined;
  readonly #reads=new Map<string,number>();
  readonly #releasedReads=new Set<string>();

  constructor(backend: WorkspaceStoreBackend) {
    this.#raw = backend;
    this.backend = this.#backend();
  }

  async initialStartEvidence():Promise<{readonly existing:boolean;readonly initialStart?:ShippedInstallIdentity}> {
    const headBytes=await this.#raw.read(HEAD,METADATA_BYTES);
    if(headBytes!==undefined&&headBytes.length===0)fail("File selection head is empty");
    const head=await this.#head();
    if(head.generation>0)return {existing:true,...(head.initialStart===undefined?{}:{initialStart:head.initialStart})};
    let existing=false;
    for await(const path of this.#raw.list("")) {
      if(path.startsWith("selections/")||path.startsWith("preserved/")||path.includes("/preserved/"))continue;
      if(path==="active.json"||path==="intent.json"||/^userspace-roots\/[^/]+\/(active|intent)\.json$/u.test(path)) {
        const bytes=await this.#raw.read(path,METADATA_BYTES);
        if(bytes!==undefined){decodeWorkspaceOverlayManifest(parseJson(bytes));existing=true;}
      }
      if(path.startsWith("journals/")||/^userspace-roots\/[^/]+\/journals\//u.test(path))existing=true;
    }
    return {existing:existing||head.selected.size>0};
  }

  async isPreserved(id:string):Promise<boolean> {keptPath(id);return (await this.#head()).preserved?.has(id)===true;}

  async has(id: string): Promise<boolean> {
    if (await this.#raw.read(keptPath(id), METADATA_BYTES) === undefined) return false;
    await this.#kept(id);
    return true;
  }

  async validate(id: string, signal: AbortSignal): Promise<void> {
    const selection = await this.#kept(id, signal);
    for (const [scope, ref] of selection) if (ref !== null) await this.#verify(scope, ref, signal);
  }

  async session(): Promise<NativeFileSession | undefined> { return (await this.#head()).native; }

  setSession(session: NativeFileSession): Promise<void> {
    return this.#serialize(async () => {
      const head = await this.#head();
      await this.#writeHead(head.generation + 1, head.selected, decodeSession(session));
    });
  }

  /** Select cold-start files at one head commit, excluding journals of replaced generations. */
  selectBoot(boot:ManagedBoot,rootIdentity:string,image:string,signal:AbortSignal):Promise<{readonly replaced?:string}> {
    return this.#serialize(async()=>{
      if(this.#staged!==undefined) fail("Startup file selection conflicts with a staged restore");
      requireActive(signal);keptPath(image);
      const head=await this.#head(),selected=new Map(head.selected),journals=new Map(head.journals);
      const destination=scopes(rootIdentity);
      let replaced:string|undefined;
      if(boot==="pre-resume"&&head.native?.replaced!==undefined) {
        replaced=head.native.replaced;
        const previous=await this.#kept(replaced,signal);
        for(const [scope,ref] of previous) {
          if(ref!==null) await this.#verify(scope,ref,signal);
          selected.set(scope,ref);journals.set(scope,crypto.randomUUID());
        }
      } else if(boot==="fresh-image") {
        for(const scope of destination) {selected.set(scope,null);journals.set(scope,crypto.randomUUID());}
      } else {
        // Update uses only the destination root's own current durable files.
        for(const scope of destination) {
          const bytes=await this.#active(scope);
          selected.set(scope,bytes===undefined?null:await this.#putManifest(scope,bytes));
        }
      }
      requireActive(signal);
      await this.#writeHead(head.generation+1,selected,{resume:null,image,
        ...(boot==="live"&&head.native?.replaced!==undefined?{replaced:head.native.replaced}:{})},journals);
      return replaced===undefined?{}:{replaced};
    });
  }

  async differences(original:string,selected:string,currentRoot:string|undefined,targetRoot:string|undefined,signal:AbortSignal):Promise<{readonly workspace:boolean;readonly root:boolean}> {
    const left=await this.#kept(original,signal),right=await this.#kept(selected,signal);
    const differs=async(leftScope:string,rightScope:string)=>{
      const a=left.get(leftScope),b=right.get(rightScope);if(a===b)return false;if(a===undefined||a===null||b===undefined||b===null)return (a??null)!==(b??null);
      const first=validateManifest(leftScope,await this.#manifest(a,signal)),second=validateManifest(rightScope,await this.#manifest(b,signal));
      const {generation:firstGeneration,...firstData}=first,{generation:secondGeneration,...secondData}=second;void firstGeneration;void secondGeneration;
      return JSON.stringify(firstData)!==JSON.stringify(secondData);
    };
    return {workspace:await differs("",""),root:currentRoot===undefined||targetRoot===undefined?false:await differs(scopes(currentRoot)[1]??"",scopes(targetRoot)[1]??"")};
  }

  /** A retained generation uses the same bounded stream lease as a normal reopen. */
  async retainedWorkspace(id:string,signal:AbortSignal,expectedBase?:string):Promise<WorkspaceReadLease|undefined> {
    await this.#serialize(async()=>{await this.#kept(id,signal);this.#reads.set(id,(this.#reads.get(id)??0)+1);});
    let retired=false;
    // A writer may await this producer's retirement while holding the mutation
    // turn. Drop its read pin here; collection removes a pending released pin in
    // a later turn instead of recursively acquiring the writer's turn.
    const retire=async()=>{if(retired)return;retired=true;await this.#serialize(()=>{const count=this.#reads.get(id)??0;if(count<=1)this.#reads.delete(id);else this.#reads.set(id,count-1);return Promise.resolve();});};
    try {
    const selection=await this.#kept(id,signal),ref=selection.get("");
    if(ref===undefined||ref===null){await retire();return undefined;}
    const manifest=validateManifest("",await this.#manifest(ref,signal));
    if(expectedBase!==undefined&&manifest.workspaceBaseSha256!==expectedBase) fail("Retained workspace base differs from requested source");
    const lease=await new WorkspaceStore(this.backend).openRetainedRead(manifest,signal);
    let retirement:Promise<void>|undefined;
    return {...lease,workspaceBaseSha256:manifest.workspaceBaseSha256,retire:()=>retirement??=lease.retire().finally(retire)};
    } catch(error){await retire();throw error;}
  }

  /** The checkpoint/recovery owner releases this pin only after its last use. */
  retain(id: string, rootIdentity?: string,additionalRoot?:string): Promise<void> {
    return this.#serialize(async () => {
      const path = keptPath(id);
      const entries = new Map<string, string | null>();
      for (const scope of new Set([...scopes(rootIdentity),...(additionalRoot===undefined?[]:scopes(additionalRoot))])) {
        const bytes = await this.#active(scope);
        entries.set(scope, bytes === undefined ? null : await this.#putManifest(scope, bytes));
      }
      const previous = await this.#raw.read(path, METADATA_BYTES);
      const bytes = encodeSelection(entries);
      if (previous !== undefined && !equal(previous, bytes)) fail("Retained file generation identity was reused");
      await this.#raw.write(path, bytes);
    });
  }

  /** Stage imported streams through the existing WorkspaceStore without selecting them. */
  async stage(id: string, rootIdentity?: string,source?:string): Promise<StagedWorkspaceSelection> {
    if (this.#staged !== undefined) fail("A file generation is already staged");
    await this.#reclaimInterrupted(rootIdentity);
    await this.#serialize(async () => {
      if (this.#staged !== undefined) fail("A file generation is already staged");
      const path = keptPath(id);
      if (await this.#raw.read(path, METADATA_BYTES) !== undefined) fail("Staged file generation already exists");
      const selected = new Map<string, string | null>(),original=source===undefined?undefined:await this.#kept(source);
      for (const scope of scopes(rootIdentity)) {
        if(original!==undefined){if(!original.has(scope))fail("Selected checkpoint has another persistence scope");selected.set(scope,original.get(scope)??null);continue;}
        const bytes = await this.#active(scope);
        selected.set(scope, bytes === undefined ? null : await this.#putManifest(scope, bytes));
      }
      await this.#raw.write(path, encodeSelection(selected));
      this.#staged = id;
    });
    let finished = false;
    return {
      backend: this.#backend(id),
      commit: async (signal, session,preservedId,initialStart) => {
        if (finished) fail("Staged file generation has retired");
        await this.publish(id, signal, session,preservedId,initialStart);
        finished = true;
        this.#staged = undefined;
      },
      abort: async () => {
        if (finished) return;
        const scopes = await this.#mutate(() => this.#serialize(async () => {
          const released = await this.#release(id);
          for (const scope of released) await this.#raw.remove(`selections/staged/${id}/${scope}intent.json`);
          this.#staged = undefined;
          finished = true;
          return released;
        }));
        for (const scope of scopes) await new WorkspaceStore(scoped(this.backend, scope)).collect();
      },
    };
  }

  /** A closed tab can stop a publication after its staging objects were written. Recovery
   * deletes them, which is refused while a generation is staged, so it runs before staging. */
  async #reclaimInterrupted(rootIdentity: string | undefined): Promise<void> {
    // An uncertain publication keeps every object and stays with its own recovery path.
    const collect = (store: WorkspaceStore) => store.collect().catch((error: unknown) => {
      if (!(error instanceof VMError && error.detail?.["reason"] === "workspace-publication-uncertain")) throw error;
    });
    await collect(new WorkspaceStore(this.backend));
    if (rootIdentity !== undefined) await collect(await openUserspaceRootStore(this.backend, rootIdentity));
  }

  /** Validate all file objects before the sole publication write. Cancellation
   * after that write cannot turn a committed selection into a reported rollback. */
  publish(id: string, signal: AbortSignal, session?: NativeFileSession,preservedId?:string,initialStart?:ShippedInstallIdentity|null): Promise<void> {
    return this.#serialize(async () => {
      if (this.#staged !== undefined && this.#staged !== id) fail("Another file generation is staged");
      requireActive(signal);
      const selection = await this.#kept(id, signal);
      for (const [scope, ref] of selection) if (ref !== null) await this.#verify(scope, ref, signal);
      const head = await this.#head();
      const selected = new Map(head.selected),journals=new Map(head.journals);
      for (const [scope, ref] of selection) {selected.set(scope, ref);journals.set(scope,crypto.randomUUID());}
      const preserved=new Set(head.preserved);if(preservedId!==undefined){await this.#kept(preservedId,signal);preserved.add(preservedId);}
      requireActive(signal);
      await this.#writeHead(head.generation + 1, selected, session === undefined ? head.native : decodeSession(session),journals,preserved,initialStart);
    });
  }

  release(id: string): Promise<void> {
    return this.#mutate(() => this.#serialize(async () => {
      if (this.#staged === id) fail("Cannot release an active file generation");
      if(this.#reads.has(id)){this.#releasedReads.add(id);return;}
      await this.#release(id);
    }));
  }

  /** Catalogue, recovery and in-flight owners supply every live checkpoint pin. */
  async collect(kept: ReadonlySet<string>): Promise<void> {
    const scopes = await this.#mutate(() => this.#serialize(async () => {
      if (this.#staged !== undefined) return new Set<string>();
      const scopes = new Set<string>();
      for await (const path of this.#raw.list(KEPT)) {
        const id = path.slice(KEPT.length, -5);
        if (keptPath(id) !== path) fail("Retained file generation path is invalid");
        if ((!kept.has(id)||this.#releasedReads.has(id))&&!this.#reads.has(id)) for (const scope of await this.#release(id)) scopes.add(scope);
      }
      const referenced = new Set<string>();
      for (const ref of (await this.#head()).selected.values()) if (ref !== null) referenced.add(ref);
      for await (const path of this.#raw.list(KEPT)) {
        for (const ref of (await this.#kept(path.slice(KEPT.length, -5))).values()) if (ref !== null) referenced.add(ref);
      }
      for await (const path of this.#raw.list("selections/manifests/")) {
        const ref = path.slice("selections/manifests/".length, -5);
        if (manifestPath(ref) !== path) fail("File generation manifest path is invalid");
        if (!referenced.has(ref)) await this.#raw.remove(path);
      }
      return scopes;
    }));
    for (const scope of scopes) await new WorkspaceStore(scoped(this.backend, scope)).collect();
  }

  async #release(id: string): Promise<ReadonlySet<string>> {
    if(await this.isPreserved(id))return new Set();
    if (await this.#raw.read(keptPath(id), METADATA_BYTES) === undefined) return new Set();
    const selected = await this.#kept(id);
    for (const [scope, ref] of selected) if (ref !== null) {
      const manifest = validateManifest(scope, await this.#manifest(ref));
      if (manifest.formatVersion === 2) {
        const backend = scoped(this.#raw, scope);
        const staging = new WorkspaceStreamStaging(backend);
        for (const stream of streamReferences(manifest)) await trackWorkspaceStream(backend, stream, staging);
      }
    }
    await this.#raw.remove(keptPath(id));
    this.#releasedReads.delete(id);
    return new Set(selected.keys());
  }

  #backend(staged?: string): WorkspaceStoreBackend {
    return {
      mutate: operation => this.#mutate(operation),
      list: prefix => this.#list(prefix),
      read: async (path, maximum, signal) => {
        requireActive(signal);
        const scope = activeScope(path);
        const preserved = retainedPath(path);
        const bytes = scope !== undefined ? await this.#active(scope, staged, signal)
          : preserved !== undefined ? await this.#retained(preserved.scope, preserved.id, signal)
            : await this.#raw.read(await this.#journalPath(path, staged), maximum, signal);
        if (maximum !== undefined && bytes !== undefined && bytes.length > maximum) fail("File generation metadata exceeds its bound");
        requireActive(signal);
        return bytes;
      },
      write: async (path, bytes) => {
        if (this.#staged !== staged) return Promise.reject(new VMError("STORAGE_ERROR", "File publication conflicts with a staged restore"));
        const scope = activeScope(path);
        return scope === undefined ? this.#raw.write(await this.#journalPath(path, staged), bytes) : this.#select(scope, bytes, staged);
      },
      remove: async path => {
        if (this.#staged !== staged) return Promise.reject(new VMError("STORAGE_ERROR", "File publication conflicts with a staged restore"));
        const scope = activeScope(path);
        return scope === undefined ? this.#raw.remove(await this.#journalPath(path, staged)) : this.#select(scope, undefined, staged);
      },
    };
  }

  #select(scope: string, bytes: Uint8Array<ArrayBuffer> | undefined, staged?: string): Promise<void> {
    return this.#serialize(async () => {
      if (this.#staged !== staged) fail("File publication conflicts with a staged restore");
      const ref = bytes === undefined ? null : await this.#putManifest(scope, bytes);
      if (staged !== undefined) {
        const selected = new Map(await this.#kept(staged));
        if (!selected.has(scope)) fail("Staged file publication escaped its selected image");
        selected.set(scope, ref);
        await this.#raw.write(keptPath(staged), encodeSelection(selected));
      } else {
        const head = await this.#head();
        const selected = new Map(head.selected);
        selected.set(scope, ref);
        await this.#writeHead(head.generation + 1, selected, head.native);
      }
    });
  }

  async #active(scope: string, staged?: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer> | undefined> {
    const selected = staged === undefined ? (await this.#head()).selected : await this.#kept(staged, signal);
    if (staged !== undefined && this.#staged !== staged) fail("Staged file generation has retired");
    const ref = selected.get(scope);
    if (ref === null) return undefined;
    return ref === undefined ? this.#raw.read(`${scope}active.json`, METADATA_BYTES, signal) : this.#manifest(ref, signal);
  }

  async #retained(scope: string, id: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer> | undefined> {
    if (id === "current") return this.#active(scope, undefined, signal);
    const selected = await this.#kept(id, signal);
    const ref = selected.get(scope);
    return ref === undefined || ref === null ? undefined : this.#manifest(ref, signal);
  }

  async *#list(prefix: string): AsyncGenerator<string> {
    yield* this.#raw.list(prefix);
    const scope = prefix.startsWith("userspace-roots/") ? rootScope(prefix) : "";
    if (scope === undefined || !`${scope}preserved/`.startsWith(prefix) && !prefix.startsWith(`${scope}preserved/`)) return;
    const current = `${scope}preserved/native-current/active.json`;
    if (current.startsWith(prefix) && await this.#active(scope) !== undefined) yield current;
    for await (const path of this.#raw.list(KEPT)) {
      const id = path.slice(KEPT.length, -5);
      if (keptPath(id) !== path) fail("Retained file generation path is invalid");
      const selected = await this.#kept(id);
      const ref = selected.get(scope);
      const virtual = `${scope}preserved/native-${id}/active.json`;
      if (ref !== undefined && ref !== null && virtual.startsWith(prefix)) yield virtual;
    }
  }

  async #putManifest(scope: string, bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    validateManifest(scope, bytes);
    const ref = await sha256(bytes);
    await this.#raw.write(manifestPath(ref), bytes);
    return ref;
  }

  async #manifest(ref: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    const bytes = await this.#raw.read(manifestPath(ref), METADATA_BYTES, signal);
    if (bytes === undefined || await sha256(bytes) !== ref) fail("Retained file generation is missing or corrupt");
    return bytes;
  }

  async #kept(id: string, signal?: AbortSignal): Promise<Selection> {
    const bytes = await this.#raw.read(keptPath(id), METADATA_BYTES, signal);
    if (bytes === undefined) fail("Retained file generation is missing");
    const selected = decodeSelection(parseJson(bytes));
    if (!selected.has("") || selected.size > 3) fail("Retained file generation must select one workspace and at most two roots");
    return selected;
  }

  async #head(): Promise<Head> {
    const bytes = await this.#raw.read(HEAD, METADATA_BYTES);
    if (bytes === undefined || bytes.length === 0) {const legacy=await readLegacySelection(this.#raw,0);return { version: 1, generation: 0, selected:legacy===undefined?new Map():decodeSelection(legacy) };}
    const value = record(parseJson(bytes), "file generation head");
    exactKeys(value, ["version", "generation", "selected"], ["native","journals","preserved",...(value["version"]===2?["initialStart"]:[])]);
    const version=integer(value["version"], "file generation version", 1, 2)===2?2:1;
    if(version===2&&value["initialStart"]===undefined)fail("Initialized file head lacks its source");
    const generation=integer(value["generation"],"file generation",1),selected=new Map(decodeSelection(value["selected"])),legacy=await readLegacySelection(this.#raw,generation);
    if(legacy!==undefined)for(const [scope,ref] of decodeSelection(legacy))if(!selected.has(scope))selected.set(scope,ref);
    return { version, generation, selected,
      ...(value["initialStart"]===undefined?{}:{initialStart:decodeShippedInstallIdentity(value["initialStart"])}),
      ...(value["native"] === undefined ? {} : { native: decodeSession(value["native"]) }),
      ...(value["journals"]===undefined?{}:{journals:decodeJournals(value["journals"])}),
      ...(value["preserved"]===undefined?{}:{preserved:decodePreserved(value["preserved"])}) };
  }

  async #writeHead(generation: number, selected: Selection, native?: NativeFileSession,journals?:ReadonlyMap<string,string>,preserved?:ReadonlySet<string>,initialStart?:ShippedInstallIdentity|null): Promise<void> {
    integer(generation, "file generation", 1);
    decodeSelection([...selected]);
    const previous=await this.#head(),fallback=new Map(previous.selected);
    for(const scope of selected.keys())if(!fallback.has(scope)) {
      const bytes=await this.#raw.read(`${scope}active.json`,METADATA_BYTES);
      fallback.set(scope,bytes===undefined?null:await this.#putManifest(scope,bytes));
    }
    await guardLegacyFiles(this.#raw,previous.generation,fallback,[...selected.keys()]);
    const nextJournals=new Map(journals??previous.journals);
    for(const scope of selected.keys())if(!nextJournals.has(scope))nextJournals.set(scope,crypto.randomUUID());
    journals=nextJournals;
    preserved??=previous.preserved; if(preserved!==undefined)decodePreserved([...preserved]);
    const completed=initialStart===null?undefined:initialStart??previous.initialStart;
    const bytes = encode({ version: completed===undefined?1:2, generation, selected: [...selected],journals:[...journals],...(preserved===undefined||preserved.size===0?{}:{preserved:[...preserved]}), ...(native === undefined ? {} : { native }),...(completed===undefined?{}:{initialStart:completed}) });
    if(bytes.length>METADATA_BYTES)fail("File selection head exceeds its bound");
    try { await this.#raw.write(HEAD, bytes); }
    catch (error) {
      // Atomic close can commit before its acknowledgement is lost.
      const committed = await this.#raw.read(HEAD, METADATA_BYTES);
      if (committed === undefined || !equal(bytes, committed)) throw error;
    }
  }

  async #verify(scope: string, ref: string, signal: AbortSignal): Promise<void> {
    const manifest = validateManifest(scope, await this.#manifest(ref, signal));
    if (manifest.formatVersion === 2) {
      await verifyDependencies(manifest);
      const backend = scoped(this.#raw, scope);
      for (const source of streamReferences(manifest)) {
        for await (const bytes of readWorkspaceStream(backend, source, signal)) void bytes;
      }
    } else {
      for (const [hash, length] of [[manifest.snapshotSha256, manifest.snapshotBytes], [manifest.deltaSha256, manifest.deltaBytes]] as const) {
        if (hash === undefined || length === undefined) continue;
        const bytes = await this.#raw.read(`${scope}blobs/${hash}`, length, signal);
        if (bytes === undefined || bytes.length !== length || await sha256(bytes) !== hash) fail("Retained file object is missing or corrupt");
      }
    }
  }

  async #journalPath(path:string,staged?:string):Promise<string> {
    if(staged!==undefined)return journalPath(path,staged);
    const scope=rootScope(path)??"";
    if(path!==`${scope}intent.json`)return path;
    const head=await this.#head(),journal=head.journals?.get(scope);
    return journal===undefined?(head.selected.has(scope)?`selections/journals/bootstrap/${scope}intent.json`:path):`selections/journals/${journal}/${scope}intent.json`;
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutations.then(operation);
    this.#mutations = result.then(() => {}, () => {});
    return result;
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation);
    this.#queue = result.then(() => {}, () => {});
    return result;
  }
}

function scopes(rootIdentity: string | undefined): string[] {
  return rootIdentity === undefined ? [""] : ["", `userspace-roots/${digest(rootIdentity, "root identity")}/`];
}
function decodeSession(value: unknown): NativeFileSession {
  const session = record(value, "native file session");
  exactKeys(session, ["resume"], ["replaced", "recovery","image"]);
  const id = (value: unknown): string => { const result = string(value, "native checkpoint id"); keptPath(result); return result; };
  return { resume: session["resume"] === null ? null : id(session["resume"]),
    ...(session["replaced"] === undefined ? {} : { replaced: id(session["replaced"]) }),
    ...(session["recovery"] === undefined ? {} : { recovery: id(session["recovery"]) }),
    ...(session["image"]===undefined?{}:{image:id(session["image"])}) };
}
function rootScope(path: string): string | undefined { return /^userspace-roots\/[0-9a-f]{64}\//u.exec(path)?.[0]; }
function activeScope(path: string): string | undefined {
  if (path === "active.json") return "";
  const scope = rootScope(path);
  return scope !== undefined && path === `${scope}active.json` ? scope : undefined;
}
function retainedPath(path: string): { readonly scope: string; readonly id: string } | undefined {
  const scope = rootScope(path) ?? "";
  const prefix = `${scope}preserved/native-`;
  if (!path.startsWith(prefix) || !path.endsWith("/active.json")) return undefined;
  const id = path.slice(prefix.length, -"/active.json".length);
  if (id !== "current") keptPath(id);
  return { scope, id };
}
function keptPath(id: string): string {
  if (!UUID.test(id)) fail("File generation pin identity is invalid");
  return `${KEPT}${id}.json`;
}
function manifestPath(ref: string): string { return `selections/manifests/${digest(ref, "file manifest digest")}.json`; }
function journalPath(path: string, staged: string | undefined): string {
  return staged !== undefined && (path === "intent.json" || path === `${rootScope(path) ?? "/"}intent.json`)
    ? `selections/staged/${staged}/${path}` : path;
}
function decodeSelection(value: unknown): Selection {
  if (!Array.isArray(value) || value.length > 512) return fail("File generation selection is invalid");
  const selected = new Map<string, string | null>();
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) fail("File generation entry is invalid");
    const scope = string(entry[0], "file scope");
    if (scope !== "" && rootScope(scope) !== scope || selected.has(scope)) fail("File generation scope is invalid or duplicated");
    selected.set(scope, entry[1] === null ? null : digest(entry[1], "file manifest digest"));
  }
  return selected;
}
function validateManifest(scope: string, bytes: Uint8Array<ArrayBuffer>) {
  if (bytes.length > METADATA_BYTES) fail("File generation manifest exceeds its bound");
  const value = decodeWorkspaceOverlayManifest(parseJson(bytes));
  if (scope !== "" && (value.formatVersion !== 2 || scope !== `userspace-roots/${value.workspaceBaseSha256}/`
    || value.delta.bytes !== 0 || value.dependencies !== undefined)) fail("Root file generation identity or format is invalid");
  return value;
}
function encodeSelection(value: Selection): Uint8Array<ArrayBuffer> { return encode([...value]); }
function encode(value: unknown): Uint8Array<ArrayBuffer> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.length > METADATA_BYTES) fail("File generation metadata exceeds its bound");
  return bytes;
}
function scoped(raw: WorkspaceStoreBackend, scope: string): WorkspaceStoreBackend {
  return {
    ...(raw.mutate === undefined ? {} : { mutate: raw.mutate.bind(raw) }),
    async *list(prefix) { for await (const path of raw.list(scope + prefix)) yield path.slice(scope.length); },
    read: (path, maximum, signal) => raw.read(scope + path, maximum, signal),
    write: (path, bytes) => raw.write(scope + path, bytes),
    remove: path => raw.remove(scope + path),
  };
}
function equal(left: Uint8Array, right: Uint8Array): boolean { return left.length === right.length && left.every((byte, index) => byte === right[index]); }
function requireActive(signal?: AbortSignal): void { if (signal?.aborted === true) throw new VMError("ABORTED", "File generation selection cancelled"); }
function fail(message: string): never { throw new VMError("STORAGE_ERROR", message); }

function decodeJournals(value:unknown):ReadonlyMap<string,string> {
  if(!Array.isArray(value)||value.length>256) fail("File journal scopes exceed their bound");
  const result=new Map<string,string>();
  for(const item of value) {
    if(!Array.isArray(item)||item.length!==2) fail("File journal entry is invalid");
    const scope=string(item[0],"file journal scope"),id=string(item[1],"file journal ID");
    if(scope!==""&&rootScope(scope)!==scope||result.has(scope)||!UUID.test(id))fail("File journal identity is invalid");
    result.set(scope,id);
  }
  return result;
}

function decodePreserved(value:unknown):ReadonlySet<string> {
 if(!Array.isArray(value)||value.length>512)fail("Preserved selection set exceeds its bound");
 const result=new Set<string>();for(const entry of value){const id=string(entry,"preserved selection identity");keptPath(id);if(result.has(id))fail("Preserved selection is duplicated");result.add(id);}return result;
}
