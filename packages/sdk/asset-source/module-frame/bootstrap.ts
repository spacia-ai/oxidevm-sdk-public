// The module frame's only script (engine ADR 0028, module frame bootstrap 2). scripts/build-module-frame.ts bundles it
// into one classic inline script whose sha256 the frame's CSP names, so nothing is loaded at run time. It accepts one
// bootstrap from the opener, checks that the document is cross-origin isolated, opaque and under the frame's own policy
// (a fetch of a data: URL is refused), starts the broker from the opener's Blob as a classic blob: worker, forwards the
// broker's probe as `module-ready` (or names the failed capability in `module-failure`) and then hands the opener's
// port to the broker.
import { documentPolicyHolds } from "../../src/runtime/module-frame-policy.ts";

((): void => {
  const VERSION = 2, BROKER_START_MS = 10_000;
  let attached = false;

  /** The opener's one answer: `claim` takes it (false once taken), and `fail` answers `module-failure` with it. */
  interface Answer { readonly port: MessagePort; readonly nonce: string; readonly claim: () => boolean; readonly fail: (capability: string) => void }

  /** Starts the broker and answers the opener once its probe arrives. */
  function startBroker(answer: Answer, broker: Blob, runner: Blob): void {
    const { port, nonce, fail } = answer;
    const channel = new MessageChannel();
    let worker: Worker;
    try { worker = new Worker(URL.createObjectURL(new Blob([broker], { type: "text/javascript" })), { name: "oxidevm-module-broker" }); }
    catch { fail("blob-workers"); return; }
    // WebKit refuses blob: workers in an opaque frame under COEP; the error event, or silence, says so.
    const timer = setTimeout(() => { fail("blob-workers"); worker.terminate(); }, BROKER_START_MS);
    worker.onerror = (failure: ErrorEvent) => { failure.preventDefault(); clearTimeout(timer); fail("blob-workers"); worker.terminate(); };
    channel.port1.onmessage = (message: MessageEvent<unknown>) => {
      const reply: unknown = message.data, probe: unknown = typeof reply === "object" && reply !== null ? Reflect.get(reply, "probe") : undefined;
      if (typeof probe !== "object" || probe === null || !answer.claim()) return;
      clearTimeout(timer);
      const fact = (key: string): boolean => Reflect.get(probe, key) === true;
      // The opener's heartbeat goes to the broker, which answers every ping while it lives: a broker that dies (out of
      // memory, say) while this document stays is a lost frame too.
      const liveness = new MessageChannel();
      port.postMessage({ version: VERSION, type: "module-ready", nonce, liveness: liveness.port2, probe: {
        documentIsolated: true, opaqueOrigin: true, // An opaque origin is always origin-keyed; a browser that says otherwise is refused.
        agentCluster: !("originAgentCluster" in self) || self.originAgentCluster, framePolicy: fact("runnerPolicy"),
        brokerIsolated: fact("brokerIsolated"), sharedMemory: fact("sharedMemory"), atomicsWait: fact("atomicsWait"), runnerIsolated: fact("runnerIsolated"), wasm: fact("wasm"),
      } }, [liveness.port2]);
      channel.port1.postMessage({ version: VERSION, type: "attach", port, liveness: liveness.port1 }, [port, liveness.port1]);
    };
    worker.postMessage({ version: VERSION, type: "broker-init", port: channel.port2, runner }, [channel.port2]);
    addEventListener("pagehide", () => { worker.terminate(); }, { once: true });
  }

  addEventListener("message", (event: MessageEvent<unknown>) => {
    if (attached || event.source !== parent) return;
    const data: unknown = event.data;
    if (typeof data !== "object" || data === null || Object.keys(data).sort().join() !== "broker,nonce,port,runner,type,version") return;
    const field = (key: string): unknown => Reflect.get(data, key);
    const nonce = field("nonce"), port = field("port"), broker = field("broker"), runner = field("runner");
    if (field("version") !== VERSION || field("type") !== "module-bootstrap" || typeof nonce !== "string" || !(port instanceof MessagePort) || !(broker instanceof Blob) || !(runner instanceof Blob)) return;
    attached = true;
    let answered = false;
    const claim = (): boolean => { if (answered) return false; answered = true; return true; };
    const fail = (capability: string): void => {
      if (!claim()) return;
      port.postMessage({ version: VERSION, type: "module-failure", nonce, capability }); port.close();
    };
    if (!crossOriginIsolated) { fail("frame-cross-origin-isolation"); return; }
    if (self.origin !== "null") { fail("separate-origin"); return; }
    // Served without its headers, the frame is still opaque and isolated but has lost its network policy (ADR 0029 N-3).
    void documentPolicyHolds(url => fetch(url)).then(holds => {
      if (holds) startBroker({ port, nonce, claim, fail }, broker, runner); else fail("frame-policy");
    });
  });
})();
