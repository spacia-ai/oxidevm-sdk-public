/**
 * The module frame's check of its own policy (engine ADR 0028, module frame bootstrap 2). The frame's `frame.json`
 * headers carry a content security policy with `connect-src blob:` and `script-src` without `data:`, which leaves module
 * code no network of the browser's own (ADR 0029 N-3). A deployment that serves the frame without those headers still
 * gets an opaque, cross-origin isolated frame, so no other check notices that this layer is missing; these do.
 * Both use a `data:` URL, so neither reaches a server whatever the outcome.
 */

/** What the frame document fetches: refused under `connect-src blob:`, answered without the policy. */
export const FRAME_POLICY_PROBE_URL = "data:text/plain,oxidevm-frame-policy";

/** Whether the document's policy is in force: its fetch of a `data:` URL is refused. */
export async function documentPolicyHolds(fetcher: (url: string) => Promise<unknown>): Promise<boolean> {
  try { await fetcher(FRAME_POLICY_PROBE_URL); } catch { return true; }
  return false;
}

/**
 * A nested classic blob: worker's report, the scope module code runs in: whether it is cross-origin isolated, may
 * compile WebAssembly, and runs under the frame's policy, which refuses `importScripts` of a `data:` URL (Pyodide's
 * classic-worker probe does exactly that).
 */
export const NESTED_FRAME_PROBE = "\"use strict\";let wasm=false,policy=false;try{new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));wasm=true}catch{}"
  + "try{importScripts(\"data:text/javascript,\")}catch{policy=true}postMessage({isolated:self.crossOriginIsolated===true,wasm,policy})";
