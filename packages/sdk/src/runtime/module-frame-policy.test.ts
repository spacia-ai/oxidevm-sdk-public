import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { documentPolicyHolds, FRAME_POLICY_PROBE_URL, NESTED_FRAME_PROBE } from "./module-frame-policy.js";

/** Runs the nested probe's source against stand-ins for a worker's globals and returns what it posts. */
function nestedReport(importScripts: (url: string) => void, isolated: boolean): unknown {
  const posted: unknown[] = [];
  runInNewContext(NESTED_FRAME_PROBE, { importScripts, postMessage: (message: unknown) => { posted.push(message); }, self: { crossOriginIsolated: isolated }, WebAssembly, Uint8Array });
  // The context's own objects come from another realm; compare their plain JSON.
  return JSON.parse(JSON.stringify(posted));
}

describe("the module frame's check of its own policy (ADR 0028, bootstrap 2)", () => {
  it("holds when the document's fetch of a data: URL is refused, and not when it is answered", async () => {
    const asked: string[] = [];
    await expect(documentPolicyHolds(url => { asked.push(url); return Promise.reject(new TypeError("Refused to connect")); })).resolves.toBe(true);
    await expect(documentPolicyHolds(url => { asked.push(url); return Promise.resolve(new Response("x")); })).resolves.toBe(false);
    expect(asked).toEqual([FRAME_POLICY_PROBE_URL, FRAME_POLICY_PROBE_URL]);
    expect(FRAME_POLICY_PROBE_URL.startsWith("data:")).toBe(true);
  });

  it("a nested runner reports the policy only when importScripts of a data: URL is refused", () => {
    const imported: string[] = [];
    expect(nestedReport(url => { imported.push(url); throw new DOMException("Refused", "NetworkError"); }, true)).toEqual([{ isolated: true, wasm: true, policy: true }]);
    expect(nestedReport(url => { imported.push(url); }, false)).toEqual([{ isolated: false, wasm: true, policy: false }]);
    expect(imported).toEqual(["data:text/javascript,", "data:text/javascript,"]);
  });
});
