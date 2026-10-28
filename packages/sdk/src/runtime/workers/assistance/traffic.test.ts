import { expect, it } from "vitest";
import { GrantedTraffic } from "./traffic.ts";
import type { AssistanceCredit } from "../../protocol/assistance-credit.ts";

const binding = { session: "11111111-2222-4333-8444-555555555555", generation: 1, process: 1, producer: "broker" as const };
const grants: readonly AssistanceCredit[] = ["data", "control"].map((pool, index) => ({
  ...binding, kind: "grant", producer: "broker", pool: pool === "data" ? "data" : "control",
  reservation: index + 1, sequence: index + 1, bytes: 1024, entries: 2,
}));

it("consumes only issued windows and retains independent supervisory progress", async () => {
  const traffic = new GrantedTraffic(binding, grants);
  const data = traffic.reserve("data", 1024);
  expect(() => traffic.reserve("data", 1)).toThrow("capacity");
  await expect(Promise.resolve().then(() => traffic.reserve("data", 1))).rejects.toMatchObject({
    code: "QUOTA_EXCEEDED", detail: { pool: "data", producer: "broker", requestedBytes: 1,
      availableBytes: 0, availableEntries: 1, sequence: 1 },
  });
  const control = traffic.reserve("control", 1024);
  expect(() => traffic.returns()).toThrow("pending");
  traffic.release(data); traffic.release(control);
  expect(() => traffic.release(data)).toThrow("reservation");
  expect(traffic.returns()).toEqual(grants.map(grant => ({ ...grant, kind: "return" })));
  expect(() => traffic.reserve("data", 1)).toThrow("retired");
});

it("rejects forged grants, duplicate pools, and identity substitution", () => {
  for (const values of [[], [grants[0]], [grants[0], grants[0]], grants.map(grant => ({ ...grant, process: 2 })),
    grants.map(grant => ({ ...grant, kind: "return" })), grants.map(grant => ({ ...grant, producer: "guest" })),
    grants.map(grant => ({ ...grant, extra: 1 }))]) {
    expect(() => new GrantedTraffic(binding, values)).toThrow();
  }
});

it("charges entry counts before allocation and retires only after buffers are released", () => {
  const traffic = new GrantedTraffic(binding, grants);
  const first = traffic.reserve("data", 1); const second = traffic.reserve("data", 1);
  expect(() => traffic.reserve("data", 1)).toThrow("capacity");
  traffic.release(first);
  const third = traffic.reserve("data", 1);
  expect(third).toBeGreaterThan(second);
  traffic.release(second); traffic.release(third);
  expect(traffic.returns()).toHaveLength(2);
  expect(() => traffic.returns()).toThrow("retired");
});

it("rejects invalid reservation sizes without consuming the issued window", () => {
  const traffic = new GrantedTraffic(binding, grants);
  for (const bytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => traffic.reserve("data", bytes)).toThrow();
  const full = traffic.reserve("data", 1024); traffic.release(full);
  expect(traffic.returns()).toHaveLength(2);
});

it("v6 network consumers spend only their VM-scoped grants and retain buffers until acknowledgement", () => {
  const network = { ...binding, process: null, producer: "network" as const };
  const issued = grants.map(grant => ({ ...grant, ...network }));
  const traffic = new GrantedTraffic(network, issued, 6);
  const bytes = traffic.reserve("data", 1024);
  expect(() => traffic.returns()).toThrow("pending");
  const cancellation = traffic.reserve("control", 128);
  traffic.release(cancellation);
  traffic.release(bytes);
  expect(traffic.returns()).toEqual(issued.map(grant => ({ ...grant, kind: "return" })));
  expect(() => new GrantedTraffic(network, issued)).toThrow();
  expect(() => new GrantedTraffic({ ...network, producer: "storage" }, issued, 6)).toThrow();
  expect(() => new GrantedTraffic({ ...network, generation: 2 }, issued, 6)).toThrow();
});

it("waits within the issued window and cancels queued acquisition without returning live grants", async () => {
  const traffic = new GrantedTraffic(binding, grants);
  const full = traffic.reserve("data", 1024);
  const controller = new AbortController();
  const queued = traffic.acquire(512, controller.signal);
  const cancelled = expect(queued).rejects.toMatchObject({ code: "ABORTED" });
  const supervision = traffic.reserve("control", 128);
  expect(() => traffic.returns()).toThrow("pending");
  controller.abort(); await cancelled;
  traffic.release(supervision);
  const resumed = traffic.acquire(1024, new AbortController().signal);
  traffic.release(full);
  traffic.release(await resumed);
  expect(traffic.returns()).toHaveLength(2);
});

it("rejects impossible producer acquisition without queuing", async () => {
  const traffic = new GrantedTraffic(binding, grants);
  for (const bytes of [0, -1, 1.5, 1025]) {
    await expect(traffic.acquire(bytes, new AbortController().signal)).rejects.toBeDefined();
  }
  expect(traffic.returns()).toHaveLength(2);
});

it("splits an atomic reservation without returning its bytes or reusing its identity", () => {
  const traffic = new GrantedTraffic(binding, grants);
  const combined = traffic.reserve("data", 1024);
  for (const bytes of [0, -1, 1.5, 1024, 1025]) expect(() => traffic.split(combined, bytes)).toThrow();
  const working = traffic.split(combined, 128);
  expect(working).toBeGreaterThan(combined);
  expect(() => traffic.split(combined, 1)).toThrow("capacity");
  expect(() => traffic.reserve("data", 1)).toThrow("capacity");
  traffic.release(combined);
  const remainder = traffic.reserve("data", 896);
  expect(() => traffic.returns()).toThrow("pending");
  traffic.release(working); traffic.release(remainder);
  expect(() => traffic.split(combined, 1)).toThrow();
  expect(traffic.returns()).toHaveLength(2);
});

it("lets fitting work progress past a larger waiter while retaining the waiting grant", async () => {
  const traffic = new GrantedTraffic(binding, grants);
  const retained = traffic.reserve("data", 512);
  const controller = new AbortController();
  const large = traffic.acquire(1024, controller.signal);
  const cancelled = expect(large).rejects.toMatchObject({ code: "ABORTED" });
  let progressed = false;
  const small = traffic.acquire(256, new AbortController().signal).then(reservation => {
    progressed = true; traffic.release(reservation);
  });
  try {
    for (let tick = 0; tick < 5; tick++) await Promise.resolve();
    expect(progressed).toBe(true);
  } finally {
    controller.abort(); await cancelled; traffic.release(retained); await small;
  }
  expect(traffic.returns()).toHaveLength(2);
});
