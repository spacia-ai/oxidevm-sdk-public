import { expect, it } from "vitest";
import { record } from "../../decode.js";
import { createAsyncContext } from "./async-context.js";
import { createNativeChildren } from "./node-children.js";

it("shares ChildProcess identity with spawned children and preserves unspawned handles", () => {
  const calls: unknown[] = [];
  const api = createNativeChildren({ setChildEvents() {},
    callSync(operation) { calls.push(operation); return { kind: "spawned", child: 1, pid: 12 }; },
    call: () => Promise.resolve({ kind: "unit" }),
  }, createAsyncContext(), {});
  const constructor: unknown = Reflect.get(api, "ChildProcess");
  if (typeof constructor !== "function") throw new Error("Missing ChildProcess constructor");
  const empty = record(Reflect.construct(constructor, []) as unknown, "empty child");
  expect(empty).toMatchObject({ connected: false, exitCode: null, signalCode: null, killed: false, spawnfile: null });
  for (const name of ["stdin", "stdout", "stderr", "stdio", "spawnargs"]) expect(empty[name]).toBeUndefined();
  const kill: unknown = Reflect.get(empty, "kill");
  if (typeof kill !== "function") throw new Error("Missing child kill");
  expect(Reflect.apply(kill, empty, [])).toBe(true);
  expect(empty["killed"]).toBe(true);
  expect(calls).toEqual([]);
  const child = api.spawn("/bin/true", ["argument"]);
  expect(child instanceof constructor).toBe(true);
  expect(child.constructor.name).toBe("ChildProcess");
  expect(child).toMatchObject({ spawnfile: "/bin/true", spawnargs: ["/bin/true", "argument"] });
  child.unref();
});
