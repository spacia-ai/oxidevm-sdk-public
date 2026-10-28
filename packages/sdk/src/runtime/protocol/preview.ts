// The expose-preview-port message: the main thread hands the network worker one preview
// session's transport port, for the listener port it reaches in the VM.
import { exactKeys, integer } from "../decode.js";
import { PROTOCOL_VERSION } from "./common.js";

/** Session identities are 32 lowercase hex characters: they also name the session origin's
 * host label, so no other alphabet is admissible. */
export const PREVIEW_SESSION_PATTERN = /^[a-f0-9]{32}$/u;

export interface ExposePreviewPort {
  readonly runtime: "userspace" | "system";
  /** "shared": the session origin is the preview origin itself (ADR 0015). */
  readonly isolation: "per-session" | "shared";
  readonly session: string;
  readonly port: number;
  readonly sessionPort: MessagePort;
  readonly sessionOrigin: string;
}

export function encodeExposePreviewPort(message: ExposePreviewPort): Readonly<Record<string, unknown>> {
  return {
    version: PROTOCOL_VERSION,
    type: "expose-preview-port",
    runtime: message.runtime,
    isolation: message.isolation,
    session: message.session,
    port: message.port,
    sessionPort: message.sessionPort,
    sessionOrigin: message.sessionOrigin,
  };
}

/** The network worker's reading of an exposure: a per-session origin must be the session's own;
 * a shared one is a bare origin that names no session. */
export function decodeExposePreviewPort(message: Readonly<Record<string, unknown>>): ExposePreviewPort & { readonly origin: URL } {
  exactKeys(message, ["version", "type", "runtime", "isolation", "session", "port", "sessionPort", "sessionOrigin"]);
  const { runtime, isolation, session, sessionOrigin, sessionPort } = message;
  if (message["version"] !== PROTOCOL_VERSION || message["type"] !== "expose-preview-port" || !(sessionPort instanceof MessagePort)
    || (runtime !== "userspace" && runtime !== "system") || (isolation !== "per-session" && isolation !== "shared")
    || typeof session !== "string" || !PREVIEW_SESSION_PATTERN.test(session)
    || typeof sessionOrigin !== "string" || !URL.canParse(sessionOrigin)) {
    throw new TypeError("invalid preview session");
  }
  const origin = new URL(sessionOrigin);
  const named = origin.hostname.startsWith(`${session}.`);
  if (origin.origin !== sessionOrigin || named !== (isolation === "per-session")) throw new TypeError("invalid preview session origin");
  return { runtime, isolation, session, port: integer(message["port"], "preview port", 1, 65_535), sessionPort, sessionOrigin, origin };
}
