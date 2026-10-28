import { exactKeys, integer, record, string } from "../decode.js";
import { relayError } from "../relay-errors.js";

import { RELAY_VERSION, RELAY_HEADER_BYTES, RELAY_MAX_FRAME, RELAY_MAX_CREDIT, RelayKind } from "./relay-generated.js";
export { RELAY_VERSION, RELAY_HEADER_BYTES, RELAY_MAX_FRAME, RELAY_MAX_CREDIT, RELAY_BUFFER_LIMIT, RELAY_STREAM_LIMIT, RelayKind } from "./relay-generated.js";

export interface RelayIdentity { readonly workspaceId: string; readonly browserSessionId: string }
export interface RelayTicket { readonly webSocketUrl: string; readonly ticket: string; readonly expiresAt: number }
export interface RelayFrame {
  readonly kind: number;
  readonly session: bigint;
  readonly stream: bigint;
  readonly sequence: bigint;
  readonly window: number;
  readonly payload: Uint8Array;
}

export function encodeRelayFrame(frame: RelayFrame): ArrayBuffer {
  if (frame.payload.byteLength > RELAY_MAX_FRAME || [frame.session,frame.stream,frame.sequence].some(value => value < 0n || value > 0xffffffffffffffffn)) throw relayError("protocol-error");
  const bytes = new Uint8Array(RELAY_HEADER_BYTES + frame.payload.byteLength);
  const view = new DataView(bytes.buffer);
  bytes.set([79, 88, 82, 76]);
  view.setUint16(4, RELAY_VERSION, true);
  view.setUint8(6, frame.kind);
  view.setBigUint64(8, frame.session, true);
  view.setBigUint64(16, frame.stream, true);
  view.setBigUint64(24, frame.sequence, true);
  view.setUint32(32, frame.payload.byteLength, true);
  view.setUint32(36, frame.window, true);
  bytes.set(frame.payload, RELAY_HEADER_BYTES);
  return bytes.buffer;
}

export function decodeRelayFrame(bytes: ArrayBuffer, session: bigint): RelayFrame {
  if (bytes.byteLength < RELAY_HEADER_BYTES || bytes.byteLength > RELAY_HEADER_BYTES + RELAY_MAX_FRAME) throw relayError("protocol-error");
  const view = new DataView(bytes);
  if (view.getUint32(0, false) !== 0x4f58524c || view.getUint8(7) !== 0 || view.getBigUint64(8, true) !== session) throw relayError("protocol-error");
  if (view.getUint16(4,true) !== RELAY_VERSION) throw relayError("version-mismatch");
  const kind = view.getUint8(6);
  const stream = view.getBigUint64(16, true);
  const length = view.getUint32(32, true);
  const window = view.getUint32(36, true);
  const payload = new Uint8Array(bytes, RELAY_HEADER_BYTES);
  if (length !== payload.byteLength || window > RELAY_MAX_CREDIT) throw relayError("protocol-error");
  let valid = false;
  switch (kind) {
    case RelayKind.OPEN: valid = length === 20; break;
    case RelayKind.OPENED: valid = length === 0; break;
    case RelayKind.DATA: valid = length > 0 && window === 0; break;
    case RelayKind.HALF_CLOSE: valid = length === 1 && payload[0] !== undefined && payload[0] <= 2 && window === 0; break;
    case RelayKind.RESET: valid = length >= 1 && length <= 64 && window === 0; break;
    case RelayKind.WINDOW: valid = length === 0 && window > 0; break;
    case RelayKind.PING: case RelayKind.PONG: valid = length === 0 && stream === 0n && window === 0; break;
    case RelayKind.FETCH: valid = length > 0 && length <= 8192; break;
    case RelayKind.FETCH_HEADERS: valid = length > 0 && length <= 16384 && window === 0; break;
  }
  if (!valid || (kind !== RelayKind.PING && kind !== RelayKind.PONG && stream === 0n)) throw relayError("protocol-error");
  return { kind, session, stream, sequence: view.getBigUint64(24, true), window, payload };
}

export function decodeRelayTicket(value: unknown, endpoint: URL): RelayTicket {
  const data = record(value, "relay ticket");
  exactKeys(data, ["version", "webSocketUrl", "ticket", "expiresAt"]);
  if (integer(data["version"], "relay version") !== RELAY_VERSION) throw relayError("version-mismatch");
  const url = new URL(string(data["webSocketUrl"], "relay socket"));
  const local = endpoint.protocol === "http:" && endpoint.hostname === "127.0.0.1" && url.protocol === "ws:";
  if ((!local && url.protocol !== "wss:") || endpoint.host !== url.host || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") throw relayError("protocol-error");
  const ticket = string(data["ticket"], "relay ticket");
  if (!/^[0-9a-f]{64}$/.test(ticket)) throw relayError("authentication-failed");
  const expiresAt = integer(data["expiresAt"], "ticket expiry", Date.now() + 1, Date.now() + 31000);
  return { webSocketUrl: url.href, ticket, expiresAt };
}

export function decodeRelayReady(value: unknown): { readonly session: bigint; readonly expiresAt: number } {
  const data = record(value, "relay authentication");
  exactKeys(data, ["version", "sessionId", "expiresAt"]);
  if (data["version"] !== RELAY_VERSION) throw relayError("version-mismatch");
  const id = string(data["sessionId"], "relay session");
  if (!/^[1-9][0-9]{0,19}$/.test(id) || BigInt(id) > 0xffffffffffffffffn) throw relayError("protocol-error");
  return { session: BigInt(id), expiresAt: integer(data["expiresAt"], "session expiry", Date.now() + 1, Date.now() + 43201000) };
}
