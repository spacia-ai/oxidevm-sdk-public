import { expect, it } from "vitest";
import { createAsyncContext } from "./async-context.js";
import { createNativeChildren } from "./node-children.js";

it.each([
  { shell: false, command: "printf", args: ["%s", "hello"] },
  { shell: true, command: "/bin/sh", args: ["-c", "printf %s hello"] },
  { shell: "/bin/ash", command: "/bin/ash", args: ["-c", "printf %s hello"] },
])("preserves Linux shell selection for spawn: $shell", ({ shell, command, args }) => {
  const calls: unknown[] = [];
  const children = createNativeChildren({
    setChildEvents() {},
    callSync(operation) { calls.push(operation); return { kind: "spawned", child: 1, pid: 9 }; },
    call: () => Promise.resolve({ kind: "unit" }),
  }, createAsyncContext(), { PATH: "/bin" });
  const child = children.spawn("printf", ["%s", "hello"], { shell, applicationMetadata: "ignored by Node" });
  expect(calls).toEqual([{ kind: "spawn", command, args, cwd: ".", env: { PATH: "/bin" } }]);
  child.unref();
  expect(() => children.spawn("printf", [], { uid: 0 })).toThrow("Unsupported child option");
  expect(calls).toHaveLength(1);
});
