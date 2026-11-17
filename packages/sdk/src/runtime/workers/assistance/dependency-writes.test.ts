import { expect, it } from "vitest";
import type { AssistanceResult } from "../../protocol/assistance-reply.js";
import { keepingDependencyWrites } from "./dependency-writes.js";

const failure = (code: string, errno: number): AssistanceResult => ({ kind: "error", errno, code, syscall: "mkdir", path: null, destination: null });
const mkdir = (path: string) => ({ kind: "mkdir", path, mode: 0o777 }) as const;

it("keeps the first write the read-only dependency capture refused, by its path", async () => {
  const kept = keepingDependencyWrites();
  const sync = kept.sync(operation => "path" in operation && operation.path.includes("/dist") ? { kind: "unit" } : failure("EROFS", 30));
  // The program still gets Linux's answer.
  expect(sync(mkdir("/workspace/app/node_modules/$app"))).toEqual(failure("EROFS", 30));
  expect(kept.refused()).toEqual({ kind: "read-only-dependencies", detail: "/workspace/app/node_modules/$app" });
  const asynchronous = kept.asynchronous(() => Promise.resolve(failure("EROFS", 30)));
  await asynchronous(mkdir("/workspace/app/node_modules/later"));
  expect(kept.refused()).toEqual({ kind: "read-only-dependencies", detail: "/workspace/app/node_modules/$app" });
  expect(sync(mkdir("/workspace/app/dist"))).toEqual({ kind: "unit" });
});

it("does not take another error, or a read-only path outside the dependencies, for the limitation", () => {
  const kept = keepingDependencyWrites();
  kept.sync(() => failure("ENOENT", 2))(mkdir("/workspace/app/node_modules/a/b"));
  kept.sync(() => failure("EROFS", 30))(mkdir("/proc/sys/x"));
  kept.sync(() => failure("EROFS", 30))(mkdir("/workspace/app/my_node_modules/x"));
  expect(kept.refused()).toBeUndefined();
});
