import { RELAY_FAILURES } from "./workers/relay-generated.js";
import { VMError } from "./errors.js";
import type { RelayFailureReason } from "./network-types.js";

export function decodeRelayFailure(value: unknown): RelayFailureReason {
  for (const reason of RELAY_FAILURES) if (value === reason) return reason;
  throw new VMError("PROTOCOL_ERROR", "Invalid relay failure reason");
}
export function relayError(reason: RelayFailureReason): VMError {
  const code = reason === "permission-denied" || reason === "destination-denied" ? "PERMISSION_DENIED"
    : reason === "quota-exceeded" ? "QUOTA_EXCEEDED"
      : reason === "protocol-error" ? "PROTOCOL_ERROR" : "RELAY_ERROR";
  return new VMError(code, `Relay: ${reason}`, { reason });
}
export function relayFailure(error: unknown): RelayFailureReason {
  if (error instanceof DOMException && error.name === "TimeoutError") return "timed-out";
  if (error instanceof DOMException && error.name === "NotAllowedError") return "permission-denied";
  if (error instanceof VMError && error.detail?.["reason"] !== undefined) {
    return decodeRelayFailure(error.detail["reason"]);
  }
  if (error instanceof VMError && error.code === "PROTOCOL_ERROR") return "protocol-error";
  return "disconnected";
}

export function networkErrno(error:unknown):1|4|5|11|104|110|111|101|113 {
  if(error instanceof VMError&&error.code==="ABORTED")return 4;
  switch(relayFailure(error)) {
    case "permission-denied":case "destination-denied":case "authentication-failed":case "approval-denied":return 1;
    case "quota-exceeded":return 11;
    case "timed-out":return 110;
    case "protocol-error":case "version-mismatch":return 5;
    case "relay-not-found":case "connection-refused":return 111;
    case "network-unreachable":return 101;
    case "host-unreachable":return 113;
    case "connection-reset":return 104;
    case "discovery-failed":return 101;
    case "approval-expired":case "disconnected":return 104;
  }
}
