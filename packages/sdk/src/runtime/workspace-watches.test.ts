import { expect, it } from "vitest";
import { WorkspaceWatches } from "./workspace-watches.js";
import type { WorkspaceChange } from "./workspace-files.js";

it("shares a bounded directory union and releases it after each caller aborts", async () => {
  let deliver: (changes: readonly WorkspaceChange[]) => void = () => undefined;
  const sets: string[][] = [];
  let closes = 0;
  const owner = new WorkspaceWatches({
    open: (onChange) => { deliver = onChange; return Promise.resolve({ setDirectories: paths => { sets.push([...paths]); return Promise.resolve(); }, close: () => { closes++; return Promise.resolve(); } }); },
  }, new AbortController().signal);
  const a = new AbortController(); const b = new AbortController();
  const seen: (readonly WorkspaceChange[])[] = [];
  const one = owner.watch(changes => seen.push(changes), { signal: a.signal });
  const two = owner.watch(() => undefined, { signal: b.signal });
  await one.setDirectories(["/app", "/"]); await two.setDirectories(["/app", "/lib"]);
  expect(sets.at(-1)).toEqual(["/", "/app", "/lib"]);
  deliver([{ kind: "changed", directory: "/lib", name: "x" }, { kind: "changed", directory: "/app", name: "y" }]);
  await Promise.resolve(); expect(seen).toEqual([[{ kind: "changed", directory: "/app", name: "y" }]]);
  await expect(one.setDirectories(Array.from({ length: 256 }, (_, i) => `/dir${i}`))).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  a.abort(); await one.done; await two.setDirectories(["/lib"]);
  expect(sets.at(-1)).toEqual(["/lib"]);
  b.abort(); await two.done;
  await new Promise(resolve => setTimeout(resolve, 0)); expect(closes).toBe(1);
});

it("rejects completion when opening its native subscription fails", async () => {
  const failure = new Error("no filesystem");
  const owner = new WorkspaceWatches({ open: () => Promise.reject(failure) }, new AbortController().signal);
  const watch = owner.watch(() => undefined, { signal: new AbortController().signal });
  const completion = expect(watch.done).rejects.toBe(failure);
  await expect(watch.setDirectories(["/"])).rejects.toBe(failure);
  await completion;
});
