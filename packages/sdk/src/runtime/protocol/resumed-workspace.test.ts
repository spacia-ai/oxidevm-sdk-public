import { expect, it } from "vitest";
import { controlResponseDecoders, decodeResumedWorkspace } from "../protocol.js";

function restored(unresolved: readonly string[]) {
  return {
    newerFilesDropped: false,
    appData: null,
    consoleTail: new Uint8Array(),
    processes: [{ mode: "userspace", attachmentKey: 9, terminalKey: 3, pid: 42,
      command: "/bin/sh", terminal: true, tail: new Uint8Array([65]) }],
    workspace: { workspace: "conflict-preserved", unresolved },
    workspaceDetails: { state: "conflict-preserved",
      conflicts: unresolved.map(path => ({ path, reason: "content-unavailable" })), omittedConflicts: 0 },
  };
}

it("preserves root directory conflicts in direct and committed native restore responses", () => {
  const response = restored(["/workspace", "/workspace/project/file", "/workspace/back\\slash"]);
  expect(decodeResumedWorkspace(response.workspace)).toEqual(response.workspace);
  expect(controlResponseDecoders["restore-userspace-checkpoint"](response)).toEqual(response);
});

it.each([
  "/workspace-other", "/workspace/../etc", "/workspace/./file", "/workspace//file",
  "/workspace/", "workspace/file", "/workspace/file\0",
  `/workspace/${"a".repeat(256)}`, `/workspace/${"a/".repeat(2048)}file`,
])("rejects noncanonical or out-of-scope resumed workspace path %j", (path) => {
  const response = restored([path]);
  for (const decode of [
    () => decodeResumedWorkspace(response.workspace),
    () => controlResponseDecoders["restore-userspace-checkpoint"](response),
  ]) {
    let failure: unknown;
    try { decode(); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "PROTOCOL_ERROR" });
  }
});
