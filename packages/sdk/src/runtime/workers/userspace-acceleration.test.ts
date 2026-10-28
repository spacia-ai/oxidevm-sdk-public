import { expect, it, vi } from "vitest";
import { UserspaceAccelerationKnowledge } from "./userspace-acceleration.js";
import { PROTOCOL_VERSION } from "../protocol/common.js";

/** A runtime whose table is a list of imported files; its export joins them. */
function fakeRuntime(rejectImport = false) {
  const memory = new WebAssembly.Memory({ initial: 1 }), imported: Uint8Array[] = [];
  let staged = 0, record = 0;
  const instance = { exports: {
    oxidevm_userspace_staging_resize: (length: number) => { staged = length; return 0; },
    oxidevm_userspace_staging_ptr: () => 0,
    oxidevm_userspace_file_record_len: () => record,
    oxidevm_userspace_acceleration_knowledge: (length: number) => {
      if (length !== staged || rejectImport) return 1;
      imported.push(new Uint8Array(memory.buffer, 0, length).slice()); return 0;
    },
    oxidevm_userspace_acceleration_knowledge_export: () => {
      const bytes = new Uint8Array(imported.flatMap(part => [...part]).concat([0xee]));
      new Uint8Array(memory.buffer).set(bytes); record = bytes.byteLength; return 0;
    },
  } };
  return { binding: { instance, memory }, imported };
}

function fakeStorage(initial?: Uint8Array<ArrayBuffer>) {
  let stored = initial;
  return {
    readAccelerationKnowledge: vi.fn(() => Promise.resolve(stored)),
    writeAccelerationKnowledge: vi.fn((_: string, data: Uint8Array<ArrayBuffer>) => { stored = data; return Promise.resolve(); }),
    stored: () => stored,
  };
}

const failure = { kind: "unavailable-builtin", detail: "node:sqlite" } as const;
const notice = { pid: 42, session: 40, record: new Uint8Array([1]) };

it("imports what the origin stored before every acceleration enable", async () => {
  const storage = fakeStorage(new Uint8Array([7, 8]));
  const runtime = fakeRuntime(), knowledge = new UserspaceAccelerationKnowledge(storage, "ns", () => runtime.binding);
  await knowledge.load();
  knowledge.importInto(runtime.binding);
  expect(runtime.imported).toEqual([new Uint8Array([7, 8])]);
  const replacement = fakeRuntime();
  knowledge.importInto(replacement.binding);
  expect(replacement.imported).toEqual([new Uint8Array([7, 8])]);
});

it("drops a stored file Rust refuses and starts empty", async () => {
  const storage = fakeStorage(new Uint8Array([9])), refusing = fakeRuntime(true);
  const knowledge = new UserspaceAccelerationKnowledge(storage, "ns", () => refusing.binding);
  await knowledge.load();
  knowledge.importInto(refusing.binding);
  const next = fakeRuntime();
  knowledge.importInto(next.binding);
  expect(next.imported).toEqual([]);
});

it("merges another tab's file into Rust's table and writes the whole export back", async () => {
  const storage = fakeStorage(), runtime = fakeRuntime();
  const knowledge = new UserspaceAccelerationKnowledge(storage, "ns", () => runtime.binding);
  await knowledge.load();
  await storage.writeAccelerationKnowledge("ns", new Uint8Array([5]));
  await knowledge.remember(notice, failure);
  expect(runtime.imported).toEqual([new Uint8Array([5])]);
  expect(storage.stored()).toEqual(new Uint8Array([5, 0xee]));
});

it("announces each late failure to every open subscription and stops after close", async () => {
  const storage = fakeStorage(), runtime = fakeRuntime();
  const knowledge = new UserspaceAccelerationKnowledge(storage, "ns", () => runtime.binding);
  const port = knowledge.subscribe(), received: unknown[] = [];
  port.onmessage = event => { received.push(event.data); };
  await knowledge.remember(notice, failure);
  await vi.waitFor(() => { expect(received).toHaveLength(1); });
  expect(received[0]).toEqual({ version: PROTOCOL_VERSION, notice: { pid: 42, session: 40, kind: "unavailable-builtin", detail: "node:sqlite" } });
  port.postMessage({ version: PROTOCOL_VERSION, type: "close" });
  await vi.waitFor(() => { expect(knowledge.subscribers).toBe(0); });
  for (let index = 0; index < 8; index++) knowledge.subscribe();
  expect(() => knowledge.subscribe()).toThrow();
  knowledge.close();
  expect(knowledge.subscribers).toBe(0);
});

it("keeps working without durable storage", async () => {
  const runtime = fakeRuntime(), knowledge = new UserspaceAccelerationKnowledge(undefined, "ns", () => runtime.binding);
  await knowledge.load();
  knowledge.importInto(runtime.binding);
  await expect(knowledge.remember(notice, failure)).resolves.toBeUndefined();
});

it("closes a subscription whose page sends anything but its close message", async () => {
  const runtime = fakeRuntime(), knowledge = new UserspaceAccelerationKnowledge(undefined, "ns", () => runtime.binding);
  knowledge.subscribe().postMessage({ version: PROTOCOL_VERSION, type: "open" });
  knowledge.subscribe().postMessage("close");
  await vi.waitFor(() => { expect(knowledge.subscribers).toBe(0); });
});
