import { Buffer } from "buffer";
import { PassThrough } from "readable-stream";
import { expect, it } from "vitest";
import { createNodeDns } from "./node-dns.js";
import { createAsyncContext } from "./async-context.js";
import { createNativeChildren } from "./node-children.js";
import type { AssistanceEvent } from "../../protocol/assistance-event.js";
import type { AssistanceOperation } from "../../protocol/assistance.js";

function fixture() {
  const context = createAsyncContext(); let receive: ((event: AssistanceEvent) => void) | undefined;
  const operations: AssistanceOperation[] = []; let child = 0; let sequence = 0;
  const children = createNativeChildren({ setChildEvents(value) { receive = value; },
    callSync(operation) { operations.push(operation); return operation.kind === "spawn" ? { kind: "spawned", child: ++child, pid: 100 + child } : { kind: "unit" }; },
    call: () => Promise.resolve({ kind: "unit" }),
  }, context, {});
  const stderr = new PassThrough(); stderr.resume();
  const dns = createNodeDns(children, context, stderr);
  async function result(value: unknown, code = 0): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 0));
    const identity = { session: "11111111-2222-4333-8444-555555555555", generation: 1, process: 1 };
    const emit = (event: AssistanceEvent["event"]) => {
      if (receive === undefined) throw new Error("Child events missing");
      receive({ ...identity, sequence: ++sequence, event });
    };
    const bytes = Buffer.from(JSON.stringify(value));
    for (let offset = 0; offset < bytes.length; offset += 16384) emit({ kind: "output", child, stream: "stdout", bytes: bytes.subarray(offset, offset + 16384) });
    emit({ kind: "exit", child, code, signal: null });
    emit({ kind: "eof", child, stream: "stdout" }); emit({ kind: "eof", child, stream: "stderr" });
  }
  return { dns, context, operations, result, children };
}

it("uses the original guest resolver and preserves callback context, order and full address results", async () => {
  const f = fixture(); const store = new f.context.AsyncLocalStorage<string>();
  f.dns.setDefaultResultOrder("ipv6first");
  const done = store.run("lookup", () => new Promise<unknown[]>((resolve, reject) => {
    f.dns.lookup("localhost", { all: true }, (error: unknown, addresses: unknown) => {
      if (error !== null) { reject(error instanceof Error ? error : new Error("Unexpected DNS callback error")); return; } resolve([store.getStore(), addresses]);
    });
  }));
  expect(f.children.hasPending).toBe(true);
  const operation = f.operations[0];
  if (operation?.kind !== "spawn") throw new Error("Guest process missing");
  expect(operation.command).toBe("/usr/bin/node");
  expect(JSON.parse(operation.args[2] ?? "")).toEqual({ hostname: "localhost", options: { family: 0, hints: 0, all: true, order: "ipv6first" } });
  const addresses = [{ address: "::1", family: 6 }, { address: "127.0.0.1", family: 4 }];
  await f.result({ kind: "addresses", addresses });
  expect(await done).toEqual(["lookup", addresses]);
  await f.children.idle(); expect(f.children.hasPending).toBe(false);
});

it("preserves native lookup errors and rejects malformed or mismatched guest results", async () => {
  for (const result of [
    { kind: "error", message: "getaddrinfo ENOTFOUND absent.invalid", code: "ENOTFOUND", errno: -3008, syscall: "getaddrinfo", hostname: "absent.invalid" },
    { kind: "addresses", addresses: [{ address: "999.1.1.1", family: 4 }] },
    { kind: "error", message: "wrong", code: "ENOTFOUND", errno: -3008, syscall: "getaddrinfo", hostname: "other.invalid" },
  ]) {
    const f = fixture(); const pending = f.dns.promises.lookup("absent.invalid").catch((error: unknown) => error);
    await f.result(result);
    expect(await pending).toMatchObject({ code: result.kind === "error" && result.hostname === "absent.invalid" ? "ENOTFOUND" : "PROTOCOL_ERROR" });
  }
});

it("validates lookup options before native execution and shares promise/callback result order", async () => {
  const f = fixture();
  expect(() => f.dns.lookup("bad\0host", () => {})).toThrow();
  expect(() => f.dns.lookup("localhost", { hints: 2 }, () => {})).toThrow();
  expect(() => f.dns.lookup("localhost", { all: 1 }, () => {})).toThrow();
  expect(() => f.dns.setDefaultResultOrder("random")).toThrow();
  expect(f.operations).toEqual([]);
  f.dns.promises.setDefaultResultOrder("ipv4first"); expect(f.dns.getDefaultResultOrder()).toBe("ipv4first");
  const pending = f.dns.promises.lookup("localhost", { family: "IPv4" });
  await f.result({ kind: "addresses", addresses: [{ address: "127.0.0.1", family: 4 }] });
  expect(await pending).toEqual({ address: "127.0.0.1", family: 4 });
});


it("bounds helper output and waits for retirement after quota or native failure", async () => {
  for (const [value, exit, expected] of [["x".repeat(70000), 0, "QUOTA_EXCEEDED"], [{}, 1, "GUEST_CRASH"]] as const) {
    const f = fixture(); const pending = f.dns.promises.lookup("localhost").catch((error: unknown) => error);
    await f.result(value, exit);
    expect(await pending).toMatchObject({ code: expected });
    await f.children.idle(); expect(f.children.hasPending).toBe(false);
  }
});
