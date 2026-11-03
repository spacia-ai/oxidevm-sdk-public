import { afterEach, describe, expect, it, vi } from "vitest";
import { VMError } from "./errors.js";
import { MODULE_FRAME_BOOTSTRAP_VERSION } from "./protocol/module-frame.js";
import { openModuleFrame } from "./module-frame.js";

const frame = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("./execution-frame.js", () => ({ openExecutionFrame: frame.open }));
afterEach(() => { frame.open.mockReset(); });

const URL_OF_FRAME = new URL("https://app.test/assets/module-frame/index.html");
const sources = { broker: new Blob(["broker"]), runner: new Blob(["runner"]) };
const PROBE = { documentIsolated: true, opaqueOrigin: true, agentCluster: true, framePolicy: true, brokerIsolated: true, sharedMemory: true, atomicsWait: true, runnerIsolated: true, wasm: true };
const ready = (nonce: string, probe: Readonly<Record<string, boolean>> = PROBE) => ({ version: MODULE_FRAME_BOOTSTRAP_VERSION, type: "module-ready", nonce, probe, liveness: new MessageChannel().port1 });

/** An execution frame that answers its bootstrap with `answer`, decoded by the opener's own decoder. */
function answering(answer: (nonce: string) => unknown) {
  const { port1, port2 } = new MessageChannel(), seen: unknown[] = [];
  frame.open.mockImplementation((url: URL, bootstrap: (port: MessagePort, nonce: string) => object, decode: (input: unknown, nonce: string) => unknown, _signal: unknown, isolation: unknown) => {
    seen.push({ url: url.href, bootstrap: bootstrap(port2, "nonce-1"), isolation });
    return Promise.resolve().then(() => ({ frame: {}, port: port1, receipt: decode(answer("nonce-1"), "nonce-1"), dispose: () => undefined }));
  });
  return seen;
}

describe("opening the module frame (ADR 0028)", () => {
  it("opens an opaque frame on the opener's URL with the broker and runner as Blobs, and keeps its port", async () => {
    const seen = answering(nonce => ready(nonce));
    const opened = await openModuleFrame(URL_OF_FRAME, sources);
    expect([opened.port, opened.liveness]).toEqual([expect.any(MessagePort), expect.any(MessagePort)]);
    expect(seen).toEqual([{ url: URL_OF_FRAME.href, isolation: "opaque", bootstrap: { version: MODULE_FRAME_BOOTSTRAP_VERSION, type: "module-bootstrap", nonce: "nonce-1", port: expect.any(MessagePort) as unknown, broker: sources.broker, runner: sources.runner } }]);
  });

  it("frame-cross-origin-isolation", async () => {
    answering(nonce => ready(nonce, { ...PROBE, documentIsolated: false }));
    await expect(openModuleFrame(URL_OF_FRAME, sources)).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE", detail: { reason: "wasm-module-isolation-unavailable", capability: "frame-cross-origin-isolation" } });
  });

  it("frame-load", async () => {
    // Firefox blocks a frame whose CORP its opaque origin fails; the opener sees only that nothing loaded in time.
    frame.open.mockRejectedValue(new VMError("CORE_LOAD_FAILED", "Execution bootstrap exceeded ten seconds"));
    await expect(openModuleFrame(URL_OF_FRAME, sources)).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE", detail: { reason: "wasm-module-isolation-unavailable", capability: "frame-load" } });
  });

  it("reports the capability the frame names, and each missing fact of its probe", async () => {
    answering(nonce => ({ version: MODULE_FRAME_BOOTSTRAP_VERSION, type: "module-failure", nonce, capability: "blob-workers" }));
    await expect(openModuleFrame(URL_OF_FRAME, sources)).rejects.toMatchObject({ detail: { capability: "blob-workers" } });
    for (const [fact, capability] of [["opaqueOrigin", "separate-origin"], ["agentCluster", "separate-agent-cluster"], ["framePolicy", "frame-policy"], ["runnerIsolated", "blob-workers"], ["sharedMemory", "worker-shared-memory"], ["atomicsWait", "worker-atomics-wait"], ["wasm", "wasm-compilation"]] as const) {
      answering(nonce => ready(nonce, { ...PROBE, [fact]: false }));
      await expect(openModuleFrame(URL_OF_FRAME, sources), fact).rejects.toMatchObject({ detail: { capability } });
    }
  });

  it("frame-policy: a frame served without its CSP refuses modules, whether its document or its probe noticed (bootstrap 2)", async () => {
    // The document's own check (a fetch of a data: URL was answered) ends the bootstrap before any broker starts.
    answering(nonce => ({ version: MODULE_FRAME_BOOTSTRAP_VERSION, type: "module-failure", nonce, capability: "frame-policy" }));
    await expect(openModuleFrame(URL_OF_FRAME, sources)).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE", detail: { reason: "wasm-module-isolation-unavailable", capability: "frame-policy" } });
    // A runner where importScripts of a data: URL worked.
    answering(nonce => ready(nonce, { ...PROBE, framePolicy: false }));
    await expect(openModuleFrame(URL_OF_FRAME, sources)).rejects.toMatchObject({ detail: { capability: "frame-policy" } });
    // A frame of bootstrap 1 says nothing about its policy: its answer is refused, never read as a policy in force.
    const withoutPolicy = Object.fromEntries(Object.entries(PROBE).filter(([key]) => key !== "framePolicy"));
    answering(nonce => ({ ...ready(nonce, withoutPolicy), version: 1 }));
    await expect(openModuleFrame(URL_OF_FRAME, sources)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    answering(nonce => ready(nonce, withoutPolicy));
    await expect(openModuleFrame(URL_OF_FRAME, sources)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  });

  it("refuses another nonce, another version or extra fields as a protocol failure, and passes a cancellation through", async () => {
    for (const answer of [(nonce: string) => ({ ...ready(nonce), nonce: "other" }), (nonce: string) => ({ ...ready(nonce), version: 0 }), (nonce: string) => ({ ...ready(nonce), extra: 1 }), (nonce: string) => ready(nonce, { ...PROBE, extra: true }), (nonce: string) => ({ ...ready(nonce), liveness: null })]) {
      answering(answer);
      await expect(openModuleFrame(URL_OF_FRAME, sources)).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    }
    frame.open.mockRejectedValue(new VMError("ABORTED", "Execution startup was aborted"));
    await expect(openModuleFrame(URL_OF_FRAME, sources)).rejects.toMatchObject({ code: "ABORTED" });
  });
});
