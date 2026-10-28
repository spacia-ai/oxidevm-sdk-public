import { expect, it, vi, afterEach } from "vitest";
import { decodeAssistanceArtifacts, loadAssistanceArtifact, matchAssistanceArtifacts } from "./assistance-artifacts.js";

afterEach(() => vi.unstubAllGlobals());
const manifest = { version: 4, nextMemoryException: "next16.2.12-memory-observability-v2", httpParser: { sha256: "e".repeat(64), bytes: 54013 }, profile: "node24-next16-v1", compiler: { sha256: "a".repeat(64), bytes: 8 }, runtime: { sha256: "b".repeat(64), bytes: 16 },
  nextCompiler: { version: "16.2.12", bindings: { sha256: "c".repeat(64), bytes: 25324 }, wasm: { sha256: "d".repeat(64), bytes: 34769457 } } };

it("requires the approved memory exception identity and rejects older manifests", () => {
  expect(decodeAssistanceArtifacts(manifest).nextMemoryException).toBe(manifest.nextMemoryException);
  for (const nextMemoryException of [undefined, "none", "next16.2.12-memory-observability-v1"]) {
    expect(() => decodeAssistanceArtifacts({ ...manifest, nextMemoryException })).toThrow();
  }
  expect(() => decodeAssistanceArtifacts({ ...manifest, version: 3 })).toThrow();
});

it("pins both official Next compiler artifacts independently of the runtime transformer", () => {
  const expected = decodeAssistanceArtifacts(manifest);
  for (const role of ["bindings", "wasm"] as const) {
    expect(() => matchAssistanceArtifacts({ ...manifest, nextCompiler: { ...manifest.nextCompiler,
      [role]: { ...manifest.nextCompiler[role], sha256: "e".repeat(64) } } }, expected)).toThrow("identity");
  }
  expect(() => decodeAssistanceArtifacts({ ...manifest, version: 1 })).toThrow();
  expect(() => decodeAssistanceArtifacts({ ...manifest, nextCompiler: { ...manifest.nextCompiler, version: "16.2.11" } })).toThrow();
});

it("cancels failed downloads, preserves the primary error, and releases the reader", async () => {
  for (const status of [200, 503]) {
    const cancel = vi.fn(() => Promise.reject(new Error("cancel failed")));
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(9)); }, cancel,
    });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(body, { status }))));
    await expect(loadAssistanceArtifact(new URL("https://execution.test/compiler.wasm"), manifest.compiler))
      .rejects.toMatchObject({ code: status === 200 ? "PROTOCOL_ERROR" : "CORE_LOAD_FAILED" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  }
});

it("requires build-pinned identities rather than a manifest's self-declared hashes", () => {
  const expected = decodeAssistanceArtifacts(manifest);
  expect(matchAssistanceArtifacts(manifest, expected)).toEqual(expected);
  expect(() => matchAssistanceArtifacts({ ...manifest, runtime: { ...manifest.runtime, sha256: "c".repeat(64) } }, expected)).toThrow("identity");
  expect(() => decodeAssistanceArtifacts({ ...manifest, enabled: true })).toThrow();
  expect(() => decodeAssistanceArtifacts({ ...manifest, runtime: { ...manifest.runtime, bytes: 5 * 1024 * 1024 } })).toThrow();
});

it("verifies bytes before returning an artifact and rejects changed lengths and contents", async () => {
  const bytes = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const identity = { bytes: bytes.length, sha256: Array.from(digest, value => value.toString(16).padStart(2, "0")).join("") };
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(bytes))));
  expect(await loadAssistanceArtifact(new URL("https://execution.test/compiler.wasm"), identity)).toEqual(bytes);
  await expect(loadAssistanceArtifact(new URL("https://execution.test/compiler.wasm"), { ...identity, sha256: "0".repeat(64) })).rejects.toThrow("integrity");
  await expect(loadAssistanceArtifact(new URL("https://execution.test/compiler.wasm"), { ...identity, bytes: 7 })).rejects.toThrow("length");
});

it("pins the HTTP parser independently and rejects obsolete or incomplete manifests", () => {
  const expected = decodeAssistanceArtifacts(manifest);
  expect(() => matchAssistanceArtifacts({ ...manifest, httpParser: { ...manifest.httpParser, sha256: "f".repeat(64) } }, expected)).toThrow("identity");
  expect(() => decodeAssistanceArtifacts({ ...manifest, version: 2 })).toThrow();
  expect(() => decodeAssistanceArtifacts({ ...manifest, httpParser: undefined })).toThrow();
  expect(() => decodeAssistanceArtifacts({ ...manifest, httpParser: { ...manifest.httpParser, bytes: 1024 * 1024 + 1 } })).toThrow();
});
