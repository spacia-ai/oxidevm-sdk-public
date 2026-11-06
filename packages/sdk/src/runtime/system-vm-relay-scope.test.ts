import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { decodeNetworkControlConnection, type RelayScope } from "./protocol/network.js";
import { createSystemRuntimeVM } from "./system-vm.js";
import { ScriptedWorker } from "./system-vm.test-support.js";
import { serveNetworkControl } from "./workers/network-control.js";
import { RelayConnectionOwner } from "./workers/network-connection.js";

vi.mock("./assistance-build.js", () => ({ ASSISTANCE_BUILD: "development", ASSISTANCE_ARTIFACTS: undefined }));

beforeEach(() => {
  vi.stubGlobal("Worker", ScriptedWorker);
  vi.stubGlobal("location", new URL("https://run.oxidevm.dev/v/0.1.0/"));
});
afterEach(() => { ScriptedWorker.reset(); vi.unstubAllGlobals(); });

/** The relay scope a VM hands its network worker, decoded and served as the worker does. */
async function relayScopeOf(hosting: { readonly embedderOrigin?: string }): Promise<RelayScope> {
  const vm = await createSystemRuntimeVM({ mode: "system", workspaceId: "default", memoryMiB: 256, vcpus: 1, network: "local", ...hosting });
  const watching = new AbortController();
  const watched = vm.network.watch(() => {}, { signal: watching.signal });
  const message = ScriptedWorker.named("oxidevm-network").messages.find(candidate => candidate["type"] === "connect-network-control");
  if (message === undefined) throw new Error("the VM did not connect its network control");
  const control = decodeNetworkControlConnection(message);
  serveNetworkControl(control.port, new RelayConnectionOwner(control.scope, { setRelay: () => Promise.resolve() }), control.pageUrl);
  watching.abort(); await watched;
  expect(vm.network.state).toEqual({ kind: "off" });
  await vm.dispose();
  return control.scope;
}

it("hands the network worker the page that embeds the runtime frame", async () => {
  expect(await relayScopeOf({ embedderOrigin: "https://one.example" }))
    .toEqual({ origin: "https://run.oxidevm.dev", workspaceId: "default", embedderOrigin: "https://one.example", serverAllowed: true });
});

it("names no embedding page for a VM in its own page", async () => {
  expect(await relayScopeOf({})).toEqual({ origin: "https://run.oxidevm.dev", workspaceId: "default", serverAllowed: true });
});
