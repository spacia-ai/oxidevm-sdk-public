import { expect, it } from "vitest";
import { VMError } from "../errors.js";
import { userspaceDurabilityCompletion } from "./userspace-durability.js";
import { createUserspaceWorkspaceCommit } from "./userspace-workspace-commit.js";

it("flushes only Rust-selected filesystems and waits for actual publication", async () => {
  const gate = Promise.withResolvers<undefined>();
  let workspaceCalls = 0, rootCalls = 0, complete = false;
  const workspace = createUserspaceWorkspaceCommit(() => { workspaceCalls++; return Promise.resolve(); }, () => {});
  const root = createUserspaceWorkspaceCommit(async () => { rootCalls++; await gate.promise; }, () => {});
  const reply = userspaceDurabilityCompletion({ kind: "durability", generation: 3n, id: 7n, root: 1n }, workspace, root)
    .then(record => { complete = true; return record; });
  await Promise.resolve(); await Promise.resolve();
  expect(workspaceCalls).toBe(0); expect(rootCalls).toBe(1); expect(complete).toBe(false);
  gate.resolve(undefined);
  const record = await reply, view = new DataView(record.buffer);
  expect(new TextDecoder().decode(record.subarray(0, 4))).toBe("OXDC");
  expect(view.getBigUint64(12, true)).toBe(3n); expect(view.getBigUint64(20, true)).toBe(7n);
  expect(view.getUint32(28, true)).toBe(0);
});

it("drains both selected publications before returning a quota failure, then permits retry", async () => {
  const gate = Promise.withResolvers<undefined>();
  let failing = true, rootFinished = false;
  const workspace = createUserspaceWorkspaceCommit(() => failing ? Promise.reject(new VMError("QUOTA_EXCEEDED", "full")) : Promise.resolve(), () => {});
  const root = createUserspaceWorkspaceCommit(async () => { await gate.promise; rootFinished = true; }, () => {});
  const request = { kind: "durability", generation: 2n, id: 3n, workspace: 1n, root: 4n } as const;
  let completed = false;
  const failed = userspaceDurabilityCompletion(request, workspace, root).then(record => { completed = true; return record; });
  await Promise.resolve(); await Promise.resolve(); expect(completed).toBe(false);
  gate.resolve(undefined);
  expect(new DataView((await failed).buffer).getUint32(28, true)).toBe(28); expect(rootFinished).toBe(true);
  failing = false;
  expect(new DataView((await userspaceDurabilityCompletion(request, workspace, root)).buffer).getUint32(28, true)).toBe(0);
});

it("reports unavailable persistence and interrupted storage explicitly", async () => {
  const workspace = { flush: () => Promise.reject(new VMError("ABORTED", "closed")) };
  const missing = await userspaceDurabilityCompletion({ kind: "durability", generation: 1n, id: 1n, root: 2n }, workspace);
  expect(new DataView(missing.buffer).getUint32(28, true)).toBe(5);
  const interrupted = await userspaceDurabilityCompletion({ kind: "durability", generation: 1n, id: 2n, workspace: 3n }, workspace);
  expect(new DataView(interrupted.buffer).getUint32(28, true)).toBe(4);
});
