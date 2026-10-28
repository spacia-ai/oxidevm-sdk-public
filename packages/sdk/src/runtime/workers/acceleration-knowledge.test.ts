import { expect, it } from "vitest";
import { MemoryDirectory } from "./opfs-double.test-support.js";
import { KNOWLEDGE_MAX_BYTES, accelerationKnowledgeNamespace, readAccelerationKnowledge, writeAccelerationKnowledge } from "./acceleration-knowledge.js";

const release = "a".repeat(64);

it("names one file per engine release and SDK version", () => {
  expect(accelerationKnowledgeNamespace(release, "0.1.0-alpha.274")).toBe(`${release}-0.1.0-alpha.274`);
  for (const [engine, sdk] of [["A".repeat(64), "1"], ["a".repeat(63), "1"], [release, ""], [release, "../escape"], [release, "a/b"]]) {
    expect(() => accelerationKnowledgeNamespace(engine ?? "", sdk ?? "")).toThrow();
  }
});

it("keeps Rust's bytes in OPFS under /oxidevm and replaces them whole", async () => {
  const oxidevm = new MemoryDirectory("oxidevm"), backend = { kind: "opfs", root: oxidevm } as const;
  const namespace = accelerationKnowledgeNamespace(release, "0.1.0-alpha.274");
  await expect(readAccelerationKnowledge(backend, namespace)).resolves.toBeUndefined();
  await writeAccelerationKnowledge(backend, namespace, new Uint8Array([1, 2, 3]));
  await writeAccelerationKnowledge(backend, namespace, new Uint8Array([4, 5]));
  await expect(readAccelerationKnowledge(backend, namespace)).resolves.toEqual(new Uint8Array([4, 5]));
  const directory = await oxidevm.getDirectoryHandle("acceleration-knowledge");
  await expect(directory.getFileHandle(`${namespace}.bin`)).resolves.toBeDefined();
  await expect(readAccelerationKnowledge(backend, accelerationKnowledgeNamespace(release, "0.1.0-alpha.275"))).resolves.toBeUndefined();
});

it("refuses oversized record files in both directions", async () => {
  const oxidevm = new MemoryDirectory("oxidevm"), backend = { kind: "opfs", root: oxidevm } as const;
  const namespace = accelerationKnowledgeNamespace(release, "0.1.0-alpha.274");
  await expect(writeAccelerationKnowledge(backend, namespace, new Uint8Array(KNOWLEDGE_MAX_BYTES + 1))).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  const directory = await oxidevm.getDirectoryHandle("acceleration-knowledge", { create: true });
  const writable = await (await directory.getFileHandle(`${namespace}.bin`, { create: true })).createWritable();
  await writable.write(new Uint8Array(KNOWLEDGE_MAX_BYTES + 1)); await writable.close();
  await expect(readAccelerationKnowledge(backend, namespace)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
});
