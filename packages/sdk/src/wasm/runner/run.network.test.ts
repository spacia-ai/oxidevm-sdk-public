import { describe, expect, it } from "vitest";
import type { Capability } from "../capabilities.js";
import { COMMAND_DECLARATION, buildRelease } from "./fixtures.test-support.js";
import { launch } from "./harness.test-support.js";
import { MemoryNetwork, VM_ADDRESS } from "../net/memory-network.js";
import { rawHttpServer, responseBytes } from "../net/memory-http.js";
import { createModuleNetwork, installNetworkGlobals } from "../net/surface.js";

const release = (host: readonly Capability[], adapter: string) => buildRelease({ adapter, declaration: { ...COMMAND_DECLARATION, requires: { host: [...host] } } });

// Engine ADR 0029: the runner installs the module network before the adapter runs.
describe("the module network in the runner", () => {
  it("a module without a reach has no host.net, and its fetch and WebSocket say the network is not declared", async () => {
    const running = launch({ release: await release(["files.sync"], `export default host => ({ main: () => { host.log("net=" + ("net" in host)); return 0; } });`) });
    await expect(running.done).resolves.toBe(0);
    expect(running.linux.stderrLines).toEqual(["net=false"]);
    const fetch = running.scope["fetch"], WebSocket = running.scope["WebSocket"];
    if (typeof fetch !== "function" || typeof WebSocket !== "function") throw new Error("globals missing");
    await expect(Promise.resolve().then((): unknown => Reflect.apply(fetch, undefined, ["http://vm/"]))).rejects.toMatchObject({ code: "ERR_NETWORK_NOT_DECLARED", message: "network not declared: add net.vm or net.internet to requires.host" });
    expect((): unknown => Reflect.construct(WebSocket, ["ws://vm/"])).toThrow(/network not declared/u);
    // The browser's other network APIs do not exist in a module worker (N-3).
    expect(["XMLHttpRequest", "EventSource"].filter(name => name in running.scope)).toEqual([]);
  });

  it("a VM-only module reaches a VM web server through host.net and the module fetch, and is refused beyond the VM", async () => {
    const network = new MemoryNetwork("vm");
    network.file("/etc/hosts", `${VM_ADDRESS} web\n`);
    network.listen(VM_ADDRESS, 8080, rawHttpServer((_request, connection) => { connection.write(responseBytes(200, [], "inside")); }));
    const adapter = `export default host => ({ main: async () => {
      const [address] = await host.net.resolve("web");
      const connection = await host.net.connect({ host: "web", port: 8080 });
      const writer = connection.writable.getWriter();
      await writer.write(new TextEncoder().encode("GET / HTTP/1.1\\r\\nhost: web\\r\\n\\r\\n"));
      const { value } = await connection.readable.getReader().read();
      await connection.close();
      host.log(address + " " + new TextDecoder().decode(value).split("\\r\\n").at(-1));
      try { await host.net.connect({ host: "93.184.215.14", port: 443 }); } catch (error) { host.log(error.code + " " + error.reason); }
      return 0;
    } });`;
    const running = launch({ release: await release(["net.vm"], adapter), network });
    await expect(running.done).resolves.toBe(0);
    // The refusal also reaches an application as one runner warning, which `oxidevm wasm test` reads (network-declared).
    expect(running.linux.stderrLines).toEqual([
      `${VM_ADDRESS} inside`,
      JSON.stringify({ oxidevm: "warning", v: 1, kind: "network-reach", address: "93.184.215.14", port: 443, protocol: "tcp" }),
      "EACCES module-network-reach",
    ]);
    expect(network.attempts.map(attempt => attempt.errno)).toEqual([0, 13]);
  });

  it("an internet module is local-only until the VM is connected", async () => {
    const adapter = `export default host => ({ main: async () => {
      try { await host.net.connect({ host: "93.184.215.14", port: 443, tls: true }); return 0; } catch (error) { host.log(error.code + " " + error.reason); return 3; }
    } });`;
    const running = launch({ release: await release(["net.internet"], adapter) });
    await expect(running.done).resolves.toBe(3);
    expect(running.linux.stderrLines).toEqual(["EPERM vm-local-only"]);
  });

  it("reports the module's use of the browser's own network, which the frame's policy refuses (N-3)", () => {
    const scope = Object.assign(new EventTarget(), { importScripts: (): undefined => undefined, XMLHttpRequest: {} }), attempts: unknown[] = [];
    const network = createModuleNetwork({ ports: { sockets: new MemoryNetwork("none").sockets(), sync: new MemoryNetwork("none").syncSockets(), tls: null }, reach: "none", signal: new AbortController().signal });
    installNetworkGlobals(scope, network, attempt => { attempts.push(attempt); });
    expect("XMLHttpRequest" in scope).toBe(false);
    scope.dispatchEvent(Object.assign(new Event("securitypolicyviolation"), { blockedURI: "https://example.com/beacon", effectiveDirective: "connect-src" }));
    Reflect.apply(Reflect.get(scope, "importScripts"), scope, ["blob:null/1", "https://cdn.example/lib.js"]);
    expect(attempts).toEqual([{ api: "connect-src", target: "https://example.com/beacon" }, { api: "importScripts", target: "https://cdn.example/lib.js" }]);
  });

  it("does not report data: URLs, which load nothing over the network, and still reports remote ones (N-3)", () => {
    const loaded: unknown[] = [], scope = Object.assign(new EventTarget(), { importScripts: (...urls: unknown[]): undefined => { loaded.push(...urls); return undefined; } }), attempts: unknown[] = [];
    const network = createModuleNetwork({ ports: { sockets: new MemoryNetwork("none").sockets(), sync: new MemoryNetwork("none").syncSockets(), tls: null }, reach: "none", signal: new AbortController().signal });
    installNetworkGlobals(scope, network, attempt => { attempts.push(attempt); });
    // Pyodide probes for a classic worker with importScripts("data:text/javascript,"); the frame's policy refuses it, as
    // a "data" script-src violation.
    Reflect.apply(Reflect.get(scope, "importScripts"), scope, ["data:text/javascript,", "DATA:text/javascript,0", "http://cdn.example/x.js"]);
    for (const blockedURI of ["data", "data:text/javascript,", "https://cdn.example/y.js"]) scope.dispatchEvent(Object.assign(new Event("securitypolicyviolation"), { blockedURI, effectiveDirective: "script-src-elem" }));
    expect(attempts).toEqual([{ api: "importScripts", target: "http://cdn.example/x.js" }, { api: "script-src-elem", target: "https://cdn.example/y.js" }]);
    // The runner only reports: the browser still decides what loads.
    expect(loaded).toEqual(["data:text/javascript,", "DATA:text/javascript,0", "http://cdn.example/x.js"]);
  });
});
