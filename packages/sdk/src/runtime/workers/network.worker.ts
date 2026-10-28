/// <reference lib="webworker" />

import { VMError } from "../errors.js";
import { boundedText } from "../protocol/network.js";
import { RelayConnectionOwner } from "./network-connection.js";
import { serveNetworkControl } from "./network-control.js";
import type { UserspaceNetworkServer } from "./userspace-network-channel.js";
import { exactKeys, record } from "../decode.js";
import { decodeNetworkLinkConnection } from "../frame-bridge.js";
import { PROTOCOL_VERSION } from "../protocol/common.js";
import { decodeExposePreviewPort } from "../protocol/preview.js";
import { serveRootfsNetwork } from "./rootfs-network-channel.js";
import { serveUserspaceNetwork } from "./userspace-network-channel.js";
import type { PreviewRuntimeClient } from "./preview-runtime-channel.js";
import { PreviewSessions } from "./preview-sessions.js";
import { SystemNetworkChannel } from "./system-network-channel.js";
import { NetstackConnections } from "./netstack/connections.js";
import { RouterPreviewRuntime } from "./router-preview-runtime.js";
import { SystemPreviewRouting } from "./system-preview-routing.js";

let previewRuntime: PreviewRuntimeClient | undefined;
let linuxNetwork: UserspaceNetworkServer | undefined;
let internet: RelayConnectionOwner | undefined;
const previewSessions = new PreviewSessions();
let systemNetwork: SystemNetworkChannel | undefined;
/** The full-system network link's router while it starts or runs. */
let netstackStarting: Promise<NetstackConnections> | undefined;
/** The started router, which preview routing reads at each open. */
let netstack: NetstackConnections | undefined;
const routerPreview = new RouterPreviewRuntime(() => netstack);
const systemPreview = new SystemPreviewRouting(routerPreview, () => systemNetwork?.preview);

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  const message = record(event.data, "network worker connection");
  if (message["version"] !== PROTOCOL_VERSION) {
    throw new TypeError("invalid network worker connection");
  }
  if (message["type"] === "connect-system") {
    exactKeys(message, ["version", "type", "port"]);
    if (!(message["port"] instanceof MessagePort) || systemNetwork !== undefined) throw new TypeError("invalid system network port");
    systemNetwork = new SystemNetworkChannel(message["port"], (target,policy,representation,signal) => {
      const connection=internet?.connection;
      if(connection===undefined) return Promise.reject(new VMError("RELAY_ERROR","Enable an authorized relay for this registry"));
      return connection.fetch(target,{allowedOrigins:[policy.origin],maximumBytes:policy.maximumBytes,accept:representation==="install"?"application/vnd.npm.install-v1+json":"application/json"},signal);
    });
    void systemNetwork.done.catch((error: unknown) => { queueMicrotask(() => { throw error; }); });
    return;
  }
  if (message["type"] === "connect-link") {
    const connection = decodeNetworkLinkConnection(message);
    if (netstackStarting !== undefined) {
      connection.doorbell.close();
      throw new TypeError("network link already connected");
    }
    const starting = NetstackConnections.start(connection);
    netstackStarting = starting;
    // A failed start has already told the control worker why; a later connect-link may retry.
    starting.then((started) => { netstack = started; started.onRuntimeReset = () => { if (internet !== undefined && internet.state.kind !== "off") void internet.disconnect(); }; }, () => { netstackStarting = undefined; });
    return;
  }
  if (message["type"] === "connect") {
    exactKeys(message, ["version", "type", "port"]);
    if (!(message["port"] instanceof MessagePort)) throw new TypeError("invalid rootfs network port");
    serveRootfsNetwork(message["port"]);
    return;
  }
  if (message["type"] === "connect-userspace") {
    exactKeys(message, ["version", "type", "port"]);
    if (!(message["port"] instanceof MessagePort) || linuxNetwork !== undefined) throw new TypeError("invalid Userspace network port");
    linuxNetwork = serveUserspaceNetwork(message["port"]);
    previewRuntime = linuxNetwork.preview;
    return;
  }
  if (message["type"] === "connect-network-control") {
    exactKeys(message, ["version", "type", "port", "origin", "workspaceId", "pageUrl", "serverAllowed"], ["workspaceName"]);
    if (!(message["port"] instanceof MessagePort) || internet !== undefined) throw new TypeError("invalid network control port");
    const origin = boundedText(message["origin"], "application origin", 4096);
    const pageUrl = boundedText(message["pageUrl"], "application URL", 4096);
    if (new URL(pageUrl).origin !== origin || origin === "null") throw new TypeError("invalid application origin");
    if (typeof message["serverAllowed"] !== "boolean") throw new TypeError("Invalid relay policy");
    const scope = {serverAllowed: message["serverAllowed"], origin, workspaceId: boundedText(message["workspaceId"], "workspace ID", 256), ...(message["workspaceName"] === undefined ? {} : {workspaceName: boundedText(message["workspaceName"], "workspace name", 100)})};
    internet = new RelayConnectionOwner(scope, {setRelay: async (connection, generation) => {
      if (linuxNetwork !== undefined) await linuxNetwork.setRelay(connection, generation);
      else {
        const router = netstack ?? await netstackStarting;
        if (router !== undefined) await router.setRelay(connection, generation);
        else if (connection !== undefined) throw new VMError("FEATURE_NOT_AVAILABLE", "System network link is unavailable");
      }
    }});
    serveNetworkControl(message["port"], internet, pageUrl);
    return;
  }
  if (message["type"] === "expose-preview-port") {
    const exposure = decodeExposePreviewPort(message);
    // Both runtimes share one session owner; only the transport that reaches
    // the listener differs. An unbound runtime fails closed by ending the port.
    const transport = exposure.runtime === "userspace" ? previewRuntime
      : routerPreview.available || systemNetwork?.preview !== undefined ? systemPreview : undefined;
    if (transport === undefined) { exposure.sessionPort.close(); return; }
    previewSessions.expose(exposure.session, exposure.port, exposure.sessionPort, transport, exposure.origin);
    return;
  }
  if (message["type"] === "close-preview-session") {
    exactKeys(message, ["version", "type", "session"]);
    if (typeof message["session"] !== "string") throw new TypeError("invalid preview session");
    previewSessions.close(message["session"]);
    return;
  }
  throw new TypeError("invalid network worker connection");
});
