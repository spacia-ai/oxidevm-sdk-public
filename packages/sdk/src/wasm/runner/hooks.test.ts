import { describe, expect, it } from "vitest";
import type { CommandIO } from "../define.js";
import { descriptor } from "../../runtime/js-process/codec.js";
import { AdapterShapeError, commandRun, serviceRun } from "./hooks.js";

const io: CommandIO = { args: [], env: {}, cwd: "/", stdin: descriptor(0), stdout: descriptor(1), stderr: descriptor(2) };

describe("command adapters", () => {
  it("accepts main and an optional close, and calls them on the adapter object", async () => {
    class Tool { readonly seen: string[] = []; main(): number { this.seen.push("main"); return 3; } close(): void { this.seen.push("close"); } }
    const tool = new Tool(), run = commandRun(tool);
    await expect(run.main(io)).resolves.toBe(3);
    await run.close();
    expect(tool.seen).toEqual(["main", "close"]);
  });

  it("turns a synchronous throw into a rejection and tolerates a missing close", async () => {
    const run = commandRun({ main() { throw new Error("sync"); } });
    await expect(run.main(io)).rejects.toThrow("sync");
    await expect(run.close()).resolves.toBeUndefined();
  });

  it("rejects anything that is not an object with a function main, and unknown members of an object literal", () => {
    for (const value of [undefined, null, 5, "main", [], {}, { main: 1 }, { main: () => 0, close: 1 }, { main: () => 0, extra: true }, { main: () => 0, clsoe: () => undefined }]) {
      expect(() => commandRun(value), JSON.stringify(value)).toThrow(AdapterShapeError);
    }
  });

  it("lets a class instance keep its own state in fields, but still requires its hooks to be functions", () => {
    class Stateful { readonly cache = new Map<string, string>(); main(): number { return this.cache.size; } }
    expect(() => commandRun(new Stateful())).not.toThrow();
    class Broken { main = 5; }
    expect(() => commandRun(new Broken())).toThrow(/must be a function/u);
  });
});

describe("service adapters", () => {
  const handler = (): Promise<void> => Promise.resolve();
  it("requires one handler per declared endpoint and no others", () => {
    expect(serviceRun({ protocols: { sql: handler, pg: handler } }, ["sql", "pg"]).handlers.size).toBe(2);
    expect(() => serviceRun({ protocols: { sql: handler } }, ["sql", "pg"])).toThrow(/no handler for pg/u);
    expect(() => serviceRun({ protocols: { sql: handler, pg: handler, x: handler } }, ["sql", "pg"])).toThrow(/x is not a declared endpoint/u);
    expect(() => serviceRun({ protocols: [] }, ["sql"])).toThrow(AdapterShapeError);
    expect(() => serviceRun({ protocols: { sql: 1 } }, ["sql"])).toThrow(/must be a function/u);
    expect(() => serviceRun({ protocols: { sql: handler }, main: () => 0 }, ["sql"])).toThrow(/unknown member main/u);
    expect(() => serviceRun(undefined, ["sql"])).toThrow(AdapterShapeError);
  });

  it("normalizes info and close to asynchronous calls", async () => {
    const run = serviceRun({ protocols: { sql: handler }, info: () => ({ a: 1 }), close() { /* nothing to release */ } }, ["sql"]);
    await expect(run.info()).resolves.toEqual({ a: 1 });
    await expect(run.close()).resolves.toBeUndefined();
    const bare = serviceRun({ protocols: { sql: handler } }, ["sql"]);
    await expect(bare.info()).resolves.toBeUndefined();
  });
});
