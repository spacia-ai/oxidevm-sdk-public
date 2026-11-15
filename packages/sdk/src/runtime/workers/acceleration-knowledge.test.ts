import { expect, it, vi } from "vitest";
import { MemoryDirectory } from "./opfs-double.test-support.js";
import { KNOWLEDGE_MAX_BYTES, accelerationKnowledgeNamespace, readAccelerationKnowledge, writeAccelerationKnowledge } from "./acceleration-knowledge.js";

const release = "a".repeat(64);

it("names one file per engine release, SDK version and served operation set", () => {
  expect(accelerationKnowledgeNamespace(release, "0.1.0-alpha.274", 0)).toBe(`${release}-0.1.0-alpha.274-ops0`);
  // A newer served set can pass add-ons an older one failed, so it starts afresh (ADR 0026, 2.8).
  expect(accelerationKnowledgeNamespace(release, "0.1.0-alpha.274", 1)).toBe(`${release}-0.1.0-alpha.274-ops1`);
  for (const [engine, sdk] of [["A".repeat(64), "1"], ["a".repeat(63), "1"], [release, ""], [release, "../escape"], [release, "a/b"]]) {
    expect(() => accelerationKnowledgeNamespace(engine ?? "", sdk ?? "", 0)).toThrow();
  }
  for (const set of [-1, 0x1_0000, 0.5]) expect(() => accelerationKnowledgeNamespace(release, "1", set)).toThrow();
});

it("keeps Rust's bytes in OPFS under /oxidevm and replaces them whole", async () => {
  const oxidevm = new MemoryDirectory("oxidevm"), backend = { kind: "opfs", root: oxidevm } as const;
  const namespace = accelerationKnowledgeNamespace(release, "0.1.0-alpha.274", 0);
  await expect(readAccelerationKnowledge(backend, namespace)).resolves.toBeUndefined();
  await writeAccelerationKnowledge(backend, namespace, new Uint8Array([1, 2, 3]));
  await writeAccelerationKnowledge(backend, namespace, new Uint8Array([4, 5]));
  await expect(readAccelerationKnowledge(backend, namespace)).resolves.toEqual(new Uint8Array([4, 5]));
  const directory = await oxidevm.getDirectoryHandle("acceleration-knowledge");
  await expect(directory.getFileHandle(`${namespace}.bin`)).resolves.toBeDefined();
  await expect(readAccelerationKnowledge(backend, accelerationKnowledgeNamespace(release, "0.1.0-alpha.275", 0))).resolves.toBeUndefined();
});

it("refuses oversized record files in both directions", async () => {
  const oxidevm = new MemoryDirectory("oxidevm"), backend = { kind: "opfs", root: oxidevm } as const;
  const namespace = accelerationKnowledgeNamespace(release, "0.1.0-alpha.274", 0);
  await expect(writeAccelerationKnowledge(backend, namespace, new Uint8Array(KNOWLEDGE_MAX_BYTES + 1))).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  const directory = await oxidevm.getDirectoryHandle("acceleration-knowledge", { create: true });
  const writable = await (await directory.getFileHandle(`${namespace}.bin`, { create: true })).createWritable();
  await writable.write(new Uint8Array(KNOWLEDGE_MAX_BYTES + 1)); await writable.close();
  await expect(readAccelerationKnowledge(backend, namespace)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
});

it.each([KNOWLEDGE_MAX_BYTES, KNOWLEDGE_MAX_BYTES + 1])("checks the %i-byte OPFS snapshot before reading its payload", async size => {
  const root = new MemoryDirectory("oxidevm"), backend = { kind: "opfs", root } as const;
  const namespace = accelerationKnowledgeNamespace(release, "0.1.0-alpha.274", 0);
  const directory = await root.getDirectoryHandle("acceleration-knowledge", { create: true });
  const handle = await directory.getFileHandle(`${namespace}.bin`, { create: true });
  const writable = await handle.createWritable();
  await writable.write(new Uint8Array(size));
  await writable.close();
  const snapshot = await handle.getFile();
  const read = vi.spyOn(snapshot, "arrayBuffer");
  vi.spyOn(handle, "getFile").mockResolvedValue(snapshot);
  if (size > KNOWLEDGE_MAX_BYTES) {
    await expect(readAccelerationKnowledge(backend, namespace)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    expect(read).not.toHaveBeenCalled();
  } else {
    await expect(readAccelerationKnowledge(backend, namespace)).resolves.toHaveLength(size);
    expect(read).toHaveBeenCalledOnce();
  }
});
