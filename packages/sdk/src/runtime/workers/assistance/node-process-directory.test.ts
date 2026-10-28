import { expect, it, vi } from "vitest";
import type { AssistanceOperation } from "../../protocol/assistance.js";
import type { AssistanceResult } from "../../protocol/assistance-reply.js";
import { createProcessDirectory } from "./node-process-directory.js";

function failure(run: () => unknown): unknown { try { run(); } catch (error) { return error; } throw new Error("Expected failure"); }

it("reads the shared Linux cwd in a worker and rejects worker chdir before any effect", () => {
  const call = vi.fn<(operation: AssistanceOperation) => AssistanceResult>();
  const directory = createProcessDirectory(call, "/workspace", false);
  call.mockReturnValueOnce({ kind: "path", path: "/workspace/current" }).mockReturnValueOnce({ kind: "path", path: "/workspace/moved" });
  expect(directory.cwd()).toBe("/workspace/current"); expect(directory.cwd()).toBe("/workspace/moved");
  expect(failure(() => directory.chdir("/tmp"))).toMatchObject({ code: "ERR_WORKER_UNSUPPORTED_OPERATION" });
  expect(call).toHaveBeenCalledTimes(2);
});

it("invalidates the Node cwd cache only after Linux accepts chdir", () => {
  const call = vi.fn<(operation: AssistanceOperation) => AssistanceResult>();
  const directory = createProcessDirectory(call, "/workspace");
  expect(directory.cwd()).toBe("/workspace");
  expect(call).not.toHaveBeenCalled();
  call.mockReturnValueOnce({ kind: "error", errno: 13, code: "EACCES", syscall: "chdir", path: "private", destination: null });
  expect(() => directory.chdir("private")).toThrow(/EACCES/u);
  expect(directory.cwd()).toBe("/workspace");
  call.mockReturnValueOnce({ kind: "unit" });
  directory.chdir("src");
  expect(call).toHaveBeenLastCalledWith({ kind: "chdir", path: "src" });
  call.mockReturnValueOnce({ kind: "error", errno: 2, code: "ENOENT", syscall: "getcwd", path: null, destination: null });
  expect(() => directory.cwd()).toThrow(/ENOENT/u);
  call.mockReturnValueOnce({ kind: "path", path: "/workspace/renamed" });
  expect(directory.cwd()).toBe("/workspace/renamed");
  expect(directory.cwd()).toBe("/workspace/renamed");
  expect(call).toHaveBeenCalledTimes(4);
  expect(() => directory.chdir(4)).toThrow(TypeError);
});
