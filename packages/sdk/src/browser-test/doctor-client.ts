import { engineRelease } from "../engine.generated.js";
import { detectBrowserSupport } from "../runtime/browser-support.js";
import { PROTOCOL_VERSION } from "../runtime/protocol/common.js";
import { record } from "../runtime/decode.js";
import type { DoctorReport } from "../contracts/doctor.js";
import { doctorAssetBase } from "../contracts/doctor-url.js";

const node = document.createElement("output"); node.id = "oxidevm-doctor"; document.body.append(node);
const checks: DoctorReport["checks"][number][] = [];
const base = doctorAssetBase(import.meta.url);
async function check(name: Exclude<DoctorReport["checks"][number]["check"], "preview-origin">, work: () => void | Promise<void>): Promise<void> {
  try { await work(); checks.push({ check: name, status: "passed" }); }
  catch { checks.push({ check: name, status: "failed", message: `${name} probe failed on the deployed origin` }); }
}
function requireCondition(value: boolean): void { if (!value) throw new Error("deployment check failed"); }
function digest(bytes: ArrayBuffer): Promise<string> { return crypto.subtle.digest("SHA-256", bytes).then(value => [...new Uint8Array(value)].map(byte => byte.toString(16).padStart(2, "0")).join("")); }

async function workerLoaded(factory: () => Worker): Promise<void> {
  const worker = factory();
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("worker probe timed out")), 15_000);
      worker.onmessage = (event: MessageEvent<unknown>) => {
        try { const value = record(event.data, "worker probe"); requireCondition(value["id"] === 1 && value["version"] === PROTOCOL_VERSION && value["ok"] === false); clearTimeout(timer); resolve(); }
        catch (error) { clearTimeout(timer); reject(error instanceof Error ? error : new Error("invalid worker reply")); }
      };
      worker.onerror = () => { clearTimeout(timer); reject(new Error("worker script failed")); };
      // The existing strict decoder answers this invalid request. No guest or
      // filesystem is activated; the reply proves the actual worker loaded.
      worker.postMessage({ id: 1, version: PROTOCOL_VERSION, type: "doctor-load-probe" });
    });
  } finally { worker.terminate(); }
}

await check("secure-context", () => { requireCondition(isSecureContext); });
await check("cross-origin-isolation", () => { requireCondition(crossOriginIsolated && typeof SharedArrayBuffer !== "undefined"); });
await check("wasm-features", () => { requireCondition(detectBrowserSupport().supported); });
const wasm: { response: Response; bytes: ArrayBuffer; expected: typeof engineRelease.artifacts[number] }[] = [];
await check("asset-integrity", async () => {
  for (const expected of engineRelease.artifacts) {
    const response = await fetch(new URL(`runtime/${expected.name}`, base), { cache: "no-store" }); requireCondition(response.ok);
    const bytes = await response.arrayBuffer(); requireCondition(bytes.byteLength === expected.bytes && await digest(bytes) === expected.sha256);
    wasm.push({ response, bytes, expected });
  }
});
await check("wasm-mime", () => { requireCondition(wasm.length === engineRelease.artifacts.length && wasm.every(item => item.response.headers.get("Content-Type")?.split(";")[0] === "application/wasm")); });
await check("worker-load", async () => {
  await workerLoaded(() => new Worker(new URL("../runtime/workers/control.worker.js", import.meta.url), { type: "module" }));
  await workerLoaded(() => new Worker(new URL("../runtime/workers/storage.worker.js", import.meta.url), { type: "module" }));
  await workerLoaded(() => new Worker(new URL("../runtime/workers/userspace.worker.js", import.meta.url), { type: "module" }));
});
await check("content-security-policy", async () => {
  requireCondition(wasm.length === engineRelease.artifacts.length);
  for (const item of wasm) await WebAssembly.compile(item.bytes);
  const blob = URL.createObjectURL(new Blob(["self.postMessage('oxidevm-doctor-blob-worker')"], { type: "text/javascript" }));
  const worker = new Worker(blob);
  try { await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CSP blocked the worker")), 5000);
    worker.onmessage = (event: MessageEvent<unknown>) => { clearTimeout(timer); if (event.data === "oxidevm-doctor-blob-worker") resolve(); else reject(new Error("invalid CSP worker reply")); };
    worker.onerror = () => { clearTimeout(timer); reject(new Error("CSP blocked the worker")); };
  }); } finally { worker.terminate(); URL.revokeObjectURL(blob); }
});
await check("storage", async () => {
  const estimate = await navigator.storage.estimate(); requireCondition(typeof estimate.quota === "number" && estimate.quota > 0);
  const root = await navigator.storage.getDirectory(); const name = `oxidevm-doctor-${crypto.randomUUID()}`;
  try { const file = await root.getFileHandle(name, { create: true }); const writer = await file.createWritable(); await writer.write("probe"); await writer.close(); requireCondition(await (await file.getFile()).text() === "probe"); }
  finally { await root.removeEntry(name); }
});
node.textContent = JSON.stringify(checks); node.dataset["done"] = "true";
