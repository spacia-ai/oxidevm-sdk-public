import { expect, it } from "vitest";
import { UserspaceHostService } from "./userspace-host-service.js";
import { createUserspaceWorkspaceCommit } from "./userspace-workspace-commit.js";
import { userspaceDurabilityCompletion } from "./userspace-durability.js";
import { VMError } from "../errors.js";
import type { UserspaceCommandHostRequest } from "../userspace-command-abi.js";
import { decodeJSIdentity } from "../js-process/codec.js";

it("drains immutable reads for a workspace publication without requiring a live guest process", async () => {
  const reply = Promise.withResolvers<undefined>();
  let taken = false, finished = false;
  const host = new UserspaceHostService({
    active: () => true,
    take: mask => {
      if (mask !== 1 || taken) return undefined;
      taken = true;
      return { kind: "storage", generation: 1n, id: 1n, path: "/workspace/original", expectedBytes: 14, offset: 0, length: 14 };
    },
    service: async () => { await reply.promise; finished = true; },
    settled() {}, failed(error) { throw error; },
  });
  const pending = host.drainStorage();
  expect(taken).toBe(true); expect(finished).toBe(false);
  reply.resolve(undefined);
  expect(await pending).toBe(true); expect(finished).toBe(true);
  expect(await host.drainStorage()).toBe(false);
});

it("fences saturated durability admission before failed disposal drains its publications", async () => {
  const gate = Promise.withResolvers<undefined>();
  let active = true, taken = 0, publications = 0, settled = 0;
  const completions: Uint8Array[] = [];
  const root = createUserspaceWorkspaceCommit(async () => {
    publications++; await gate.promise; throw new VMError("QUOTA_EXCEEDED", "full");
  }, () => {});
  const host = new UserspaceHostService({
    active: () => active,
    take: mask => mask !== 4 || taken === 129 ? undefined
      : { kind: "durability", generation: 1n, id: BigInt(++taken), root: 1n },
    service: async request => {
      if (request.kind !== "durability") throw new Error("Unexpected host request");
      completions.push(await userspaceDurabilityCompletion(request, { flush: () => Promise.resolve() }, root)); settled++;
    }, settled: () => {}, failed: error => { throw error; },
  });
  host.pump(); expect(taken).toBe(128);
  active = false;
  const disposal = root.flush();
  const failed = expect(disposal).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  const drained = host.drainDurability();
  gate.resolve(undefined); await failed; await drained;
  expect(taken).toBe(128); expect(publications).toBe(2); expect(settled).toBe(128);
  expect(completions.map(bytes => new DataView(bytes.buffer, bytes.byteOffset).getUint32(28, true))).toEqual(Array.from({ length: 128 }, () => 28));
  expect(new Set(completions.map(bytes => new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(20, true))).size).toBe(128);
  host.pump(); await Promise.resolve();
  expect(taken).toBe(128); expect(publications).toBe(2);
  host.cancel();
});

function commandRequest(id: number): UserspaceCommandHostRequest {
  return { kind: "command", ...decodeJSIdentity(1n, BigInt(id)), pid: 100 + id, tty: false, cwd: "/workspace", args: [], environment: [], program: { kind: "worker", token: BigInt(id) } };
}

it("serves every admitted command without waiting for earlier JS processes to end", () => {
  // A JS process holds its command request until it exits, so a cap here would hold processes Rust already admitted.
  const running = Promise.withResolvers<undefined>();
  let offered = 8, taken = 0;
  const host = new UserspaceHostService({
    active: () => true,
    take: mask => mask !== 8 || taken === offered ? undefined : commandRequest(++taken),
    service: () => running.promise,
    settled() {}, failed(error) { throw error; },
  });
  host.pump();
  expect(taken).toBe(8);
  offered = 9;
  host.pump();
  expect(taken).toBe(9);
  host.cancel(); running.resolve(undefined);
});

it("keeps storage reads at four while commands run without an SDK cap", () => {
  const blocked = Promise.withResolvers<undefined>();
  let reads = 0, commands = 0;
  const host = new UserspaceHostService({
    active: () => true,
    take: mask => mask === 1 && reads < 10 ? { kind: "storage", generation: 1n, id: BigInt(++reads), path: "/workspace/file", expectedBytes: 1, offset: 0, length: 1 }
      : mask === 8 && commands < 6 ? commandRequest(++commands) : undefined,
    service: () => blocked.promise,
    settled() {}, failed(error) { throw error; },
  });
  host.pump();
  expect(reads).toBe(4); expect(commands).toBe(6);
  host.cancel(); blocked.resolve(undefined);
});
