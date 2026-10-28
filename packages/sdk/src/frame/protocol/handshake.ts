import { exactKeys, integer, record, string } from "../../runtime/decode.js";
import { VMError, decodeSerializedError, deserializeError } from "../../runtime/errors.js";
import type { SerializedError } from "../../runtime/errors.js";
import { isTrustworthyURL } from "../../trustworthy-url.js";

// The runtime frame (ADR 0021) and the page that embeds it meet in two window messages, then talk
// only over the MessagePort the page transfers. The frame announces itself to its parent with the
// protocol versions it speaks; the page answers, to the frame's origin only, with the version it
// chose and the port. Neither message carries anything secret.

/** The frame protocol version this SDK speaks. Bump it with every wire change. */
export {FRAME_PROTOCOL_VERSION} from "./version.js";
import {FRAME_PROTOCOL_VERSION} from "./version.js";

export const FRAME_READY = "oxidevm-runtime-ready";
export const FRAME_CONNECT = "oxidevm-runtime-connect";

export interface FrameReady {
  readonly kind: typeof FRAME_READY;
  readonly protocol: { readonly min: number; readonly max: number };
}

export interface FrameConnect {
  readonly kind: typeof FRAME_CONNECT;
  readonly protocol: number;
  readonly sdkVersion: string;
}

/** The frame's first message on the port: whether it will serve this page. */
export type FrameConnectReply =
  | { readonly v: number; readonly type: "accepted"; readonly engineReleaseId: string }
  | { readonly v: number; readonly type: "rejected"; readonly error: SerializedError };

const SDK_VERSION = /^[0-9A-Za-z.+-]{1,64}$/u;
const RELEASE_ID = /^[0-9a-f]{64}$/u;

export function frameReady(): FrameReady {
  return { kind: FRAME_READY, protocol: { min: FRAME_PROTOCOL_VERSION, max: FRAME_PROTOCOL_VERSION } };
}

/** `undefined` for any other window message, so a page's unrelated traffic is ignored. */
export function decodeFrameReady(value: unknown): FrameReady | undefined {
  if (!isRecord(value) || value["kind"] !== FRAME_READY) return undefined;
  exactKeys(value, ["kind", "protocol"]);
  const protocol = record(value["protocol"], "frame protocol range");
  exactKeys(protocol, ["min", "max"]);
  const min = integer(protocol["min"], "frame protocol minimum", 1, 0xffff);
  const max = integer(protocol["max"], "frame protocol maximum", min, 0xffff);
  return { kind: FRAME_READY, protocol: { min, max } };
}

/** The version both sides speak, or a typed failure naming both ranges. */
export function negotiateFrameProtocol(ready: FrameReady): number {
  if (ready.protocol.min > FRAME_PROTOCOL_VERSION || ready.protocol.max < FRAME_PROTOCOL_VERSION) {
    throw new VMError("FEATURE_NOT_AVAILABLE", `the runtime frame speaks protocol ${String(ready.protocol.min)}–${String(ready.protocol.max)}; this SDK speaks ${String(FRAME_PROTOCOL_VERSION)}`, { reason: "browser-unsupported" });
  }
  return FRAME_PROTOCOL_VERSION;
}

export function frameConnect(sdkVersion: string): FrameConnect {
  return { kind: FRAME_CONNECT, protocol: FRAME_PROTOCOL_VERSION, sdkVersion };
}

/** `undefined` for other window messages; a connect message must carry exactly one port. */
export function decodeFrameConnect(value: unknown, ports: readonly MessagePort[]): { readonly connect: FrameConnect; readonly port: MessagePort } | undefined {
  if (!isRecord(value) || value["kind"] !== FRAME_CONNECT) return undefined;
  exactKeys(value, ["kind", "protocol", "sdkVersion"]);
  const sdkVersion = string(value["sdkVersion"], "SDK version");
  if (!SDK_VERSION.test(sdkVersion)) throw new VMError("PROTOCOL_ERROR", "SDK version is invalid");
  const port = ports[0];
  if (ports.length !== 1 || port === undefined) throw new VMError("PROTOCOL_ERROR", "frame connect must transfer exactly one port");
  return { connect: { kind: FRAME_CONNECT, protocol: integer(value["protocol"], "frame protocol", 1, 0xffff), sdkVersion }, port };
}

export function decodeFrameConnectReply(value: unknown): FrameConnectReply {
  const reply = record(value, "frame connect reply");
  const v = integer(reply["v"], "frame protocol", 1, 0xffff);
  if (reply["type"] === "accepted") {
    exactKeys(reply, ["v", "type", "engineReleaseId"]);
    const engineReleaseId = string(reply["engineReleaseId"], "engine release");
    if (!RELEASE_ID.test(engineReleaseId)) throw new VMError("PROTOCOL_ERROR", "engine release id is invalid");
    // A frame that accepts in another version would answer requests this page cannot decode.
    if (v !== FRAME_PROTOCOL_VERSION) throw new VMError("FEATURE_NOT_AVAILABLE", `the runtime frame accepted in protocol ${String(v)}; this SDK speaks ${String(FRAME_PROTOCOL_VERSION)}`, { reason: "browser-unsupported" });
    return { v, type: "accepted", engineReleaseId };
  }
  if (reply["type"] !== "rejected") throw new VMError("PROTOCOL_ERROR", "frame connect reply type is invalid");
  exactKeys(reply, ["v", "type", "error"]);
  return { v, type: "rejected", error: decodeSerializedError(reply["error"]) };
}

/** The error a rejected connect carries, as the page's own VMError. */
export function connectRejection(reply: Extract<FrameConnectReply, { readonly type: "rejected" }>): VMError {
  return deserializeError(reply.error);
}

/**
 * Who may embed the frame: a page served over https, or over http from this machine. A page on the
 * frame's own origin is refused, so the frame never serves itself.
 */
export function isAcceptableEmbedder(origin: string, frameOrigin: string): boolean {
  if (origin === frameOrigin || origin === "null") return false;
  let url: URL;
  try { url = new URL(origin); } catch { return false; }
  return url.origin === origin && isTrustworthyURL(url);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
