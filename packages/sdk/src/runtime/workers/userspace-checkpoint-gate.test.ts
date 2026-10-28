import { expect, it } from "vitest";
import { UserspaceCheckpointGate } from "./userspace-checkpoint-gate.js";

it("drains admitted mutations before freezing and defers new input and host delivery until resume", async () => {
  const gate = new UserspaceCheckpointGate(), order: string[] = [];
  const pending = Promise.withResolvers<undefined>();
  const original = gate.operation(async () => { order.push("admitted"); await pending.promise; order.push("finished"); });
  expect(order).toEqual(["admitted"]);
  const freeze = gate.freeze(() => { expect(gate.executionAllowed).toBe(false); order.push("durable"); return Promise.resolve(undefined); });
  const next = gate.operation(() => { order.push("new"); return Promise.resolve(undefined); });
  expect(gate.open).toBe(false);
  expect(gate.executionAllowed).toBe(true);
  pending.resolve(undefined); await original; await freeze;
  expect(gate.executionAllowed).toBe(false);
  const delivery = gate.deliver(() => { order.push("host"); });
  expect(order).toEqual(["admitted", "finished", "durable"]);
  gate.resume(); await next; await delivery;
  expect(order).toEqual(["admitted", "finished", "durable", "new", "host"]);
});

it("never reopens a runtime retired during its durability barrier", async () => {
  const gate = new UserspaceCheckpointGate(), barrier = Promise.withResolvers<undefined>();
  const freezing = gate.freeze(() => barrier.promise);
  gate.close(); barrier.resolve(undefined);
  await expect(freezing).rejects.toMatchObject({ code: "ABORTED" });
  expect(gate.executionAllowed).toBe(false);
});

it("reopens admission after a failed durability barrier and rejects queued work when retired", async () => {
  const gate = new UserspaceCheckpointGate();
  await expect(gate.freeze(() => Promise.reject(new Error("disk full")))).rejects.toThrow("disk full");
  expect(gate.open).toBe(true);
  await gate.freeze(() => Promise.resolve());
  const blocked = gate.operation(() => Promise.resolve(1));
  gate.close();
  await expect(blocked).rejects.toMatchObject({ code: "ABORTED" });
});
