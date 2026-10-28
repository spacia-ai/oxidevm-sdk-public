import { expect, it } from "vitest";
import { reconcileWorkspaceStreams } from "./userspace-workspace-reconcile.js";
import { workspaceBytesInput } from "./workspace-stream.js";

it("verifies every required base file before apply and retires all immutable reads", async () => {
  const calls: string[] = [];
  const body = workspaceBytesInput(new Uint8Array([1, 2]));
  const transfer = {
    source() {}, feed() {}, sourceComplete() {}, plan: () => ({ sources: [3] as const, hosts: 1 }),
    host: () => ({ source:0 as const,identity: 1n, path: "/workspace/a", length: 2, sha256: "a".repeat(64) }),
    apply: () => { calls.push("apply"); }, replay() {}, replayFeed() {}, replayComplete() {}, hostFeed() {}, hostComplete() {},
    finish: () => ({workspace:{workspace:"reconciled" as const,unresolved:[]},workspaceDetails:{state:"reconciled" as const,conflicts:[],omittedConflicts:0}}),
  };
  const result = await reconcileWorkspaceStreams(transfer, body, async selection => {
    await Promise.resolve();
    calls.push(selection.kind); return { selection: { generation: 1, workspaceBaseSha256:"a".repeat(64), snapshot: body }, retire: () => { calls.push("retire"); return Promise.resolve(); } };
  }, { kind:"restore", snapshotId: "old", retainedId: "new",workspaceBaseSha256:"a".repeat(64) }, new AbortController().signal,()=>Promise.resolve(undefined));
  expect(result.workspace.workspace).toBe("reconciled");
  expect(calls).toEqual(["retained", "retire", "retained", "retire", "rootfs", "retire", "apply", "retained", "retire", "rootfs", "retire"]);
});

it("does not apply after cached base-file verification fails", async () => {
  let applied = false;
  const transfer = {
    source() {}, feed() {}, sourceComplete() {}, plan: () => ({ sources: [] as const, hosts: 1 }),
    host: () => ({ source:0 as const,identity: 1n, path: "/workspace/a", length: 2, sha256: "a".repeat(64) }),
    apply: () => { applied = true; }, replay() {}, replayFeed() {}, replayComplete() {}, hostFeed() {}, hostComplete() {},
    finish: () => ({workspace:{workspace:"in-sync" as const,unresolved:[]},workspaceDetails:{state:"in-sync" as const,conflicts:[],omittedConflicts:0}}),
  };
  await expect(reconcileWorkspaceStreams(transfer, workspaceBytesInput(new Uint8Array(12)), async selection => {
    await Promise.resolve();
    if (selection.kind === "rootfs") throw new Error("damaged cached closure");
    return { selection: undefined, retire: async () => {} };
  }, { kind:"restore", snapshotId: "old", retainedId: "new",workspaceBaseSha256:"a".repeat(64) }, new AbortController().signal,()=>Promise.resolve(undefined))).rejects.toThrow("damaged");
  expect(applied).toBe(false);
});

it("indexes the actual foreign base and scopes its immutable bodies to that base", async () => {
  const selected="a".repeat(64),foreign="b".repeat(64),sources:number[]=[],reads:{kind:string;base:string|undefined}[]=[];
  const bytes=workspaceBytesInput(new Uint8Array(12));
  const transfer={source:(source:number)=>{sources.push(source);},feed(){},sourceComplete(){},plan:()=>({sources:[5] as const,hosts:1}),
    host:()=>({source:5 as const,identity:1n,path:"/workspace/a",length:12,sha256:"c".repeat(64)}),
    apply(){},replay(){},replayFeed(){},replayComplete(){},hostFeed(){},hostComplete(){},
    finish:()=>({workspace:{workspace:"reconciled" as const,unresolved:[]},workspaceDetails:{state:"reconciled" as const,conflicts:[],omittedConflicts:0}})};
  await reconcileWorkspaceStreams(transfer,bytes,async(selection,base)=>{
    await Promise.resolve();reads.push({kind:selection.kind,base});
    return {selection:selection.kind==="retained"&&selection.id==="old"?undefined:{generation:1,workspaceBaseSha256:foreign,snapshot:bytes},retire:async()=>{}};
  },{kind:"restore",snapshotId:"old",retainedId:"new",workspaceBaseSha256:selected},new AbortController().signal,async base=>{await Promise.resolve();expect(base).toBe(foreign);return {metadata:new Uint8Array(12)};});
  expect(sources).toEqual([0,5,3]);
  expect(reads.filter(read=>read.kind==="workspace-base-file")).toEqual([{kind:"workspace-base-file",base:foreign},{kind:"workspace-base-file",base:foreign}]);
});

it("lets the native owner decide unknown-base delta conflicts", async()=>{
  const sources:number[]=[],bytes=workspaceBytesInput(new Uint8Array(12));
  const transfer={source:(source:number)=>{sources.push(source);},feed(){},sourceComplete(){},plan:()=>({sources:[] as const,hosts:0}),host:()=>{throw new Error("no hosts");},
    apply(){},replay(){},replayFeed(){},replayComplete(){},hostFeed(){},hostComplete(){},
    finish:()=>({workspace:{workspace:"conflict-preserved" as const,unresolved:[]},workspaceDetails:{state:"conflict-preserved" as const,conflicts:[{path:"/workspace/a",reason:"base-unknown" as const}],omittedConflicts:0}})};
  const result=await reconcileWorkspaceStreams(transfer,bytes,async selection=>{await Promise.resolve();return {selection:selection.kind==="retained"&&selection.id==="new"?{generation:1,workspaceBaseSha256:"b".repeat(64),delta:bytes}:undefined,retire:async()=>{}};},
    {kind:"restore",snapshotId:"old",retainedId:"new",workspaceBaseSha256:"a".repeat(64)},new AbortController().signal,()=>Promise.resolve(undefined));
  expect(sources).toEqual([0,6,4]);expect(result.workspaceDetails.conflicts[0]?.reason).toBe("base-unknown");
});

it("rejects a retained stream that omits its authoritative base",async()=>{
  let applied=false;const bytes=workspaceBytesInput(new Uint8Array(12));
  const transfer={source(){},feed(){},sourceComplete(){},plan:()=>({sources:[] as const,hosts:0}),host:()=>{throw new Error("no hosts");},apply(){applied=true;},replay(){},replayFeed(){},replayComplete(){},hostFeed(){},hostComplete(){},
    finish:()=>({workspace:{workspace:"in-sync" as const,unresolved:[]},workspaceDetails:{state:"in-sync" as const,conflicts:[],omittedConflicts:0}})};
  await expect(reconcileWorkspaceStreams(transfer,bytes,async selection=>{await Promise.resolve();return {selection:selection.kind==="retained"&&selection.id==="new"?{generation:1,snapshot:bytes}:undefined,retire:async()=>{}};},
    {kind:"restore",snapshotId:"old",retainedId:"new",workspaceBaseSha256:"a".repeat(64)},new AbortController().signal,()=>Promise.resolve(undefined))).rejects.toThrow("base");
  expect(applied).toBe(false);
});

it("cold startup indexes only current streams and reads target bodies from the active verified root", async () => {
  const sources: number[] = [], selected: unknown[] = [];
  const bytes = workspaceBytesInput(new Uint8Array(12));
  const transfer = { source:(source:number)=>{sources.push(source);},feed(){},sourceComplete(){},
    plan:()=>({sources:[3] as const,hosts:1}),host:()=>({source:0 as const,identity:1n,path:"/workspace/a",length:12,sha256:"c".repeat(64)}),
    apply(){},replay(){},replayFeed(){},replayComplete(){},hostFeed(){},hostComplete(){},
    finish:()=>({workspace:{workspace:"in-sync" as const,unresolved:[]},workspaceDetails:{state:"in-sync" as const,conflicts:[],omittedConflicts:0}})};
  await reconcileWorkspaceStreams(transfer,bytes,async selection=>{await Promise.resolve();selected.push(selection);return {selection:{generation:1,workspaceBaseSha256:"a".repeat(64),snapshot:bytes},retire:async()=>{}};},
    {kind:"cold",retainedId:"source",workspaceBaseSha256:"a".repeat(64)},new AbortController().signal,()=>Promise.resolve(undefined));
  expect(sources).toEqual([0,3]);
  expect(selected).toEqual([
    {kind:"retained",id:"source",allowDifferentBase:true},
    {kind:"rootfs",path:"/workspace/a",sha256:"c".repeat(64),bytes:12},
    {kind:"retained",id:"source"},
    {kind:"rootfs",path:"/workspace/a",sha256:"c".repeat(64),bytes:12},
  ]);
});
