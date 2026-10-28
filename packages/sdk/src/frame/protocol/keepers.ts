import { exactKeys, integer, string } from "../../runtime/decode.js";
import { VMError } from "../../runtime/errors.js";
import { PREVIEW_SESSION_PATTERN } from "../../runtime/protocol/preview.js";
import { FRAME_PROTOCOL_VERSION } from "./handshake.js";

// Preview keepers in frame mode (ADR 0021). A preview session's keeper registers the session
// origin's Service Worker, so it must share a storage partition with the iframe the page shows
// the preview in: the page, not the runtime frame, embeds it. The frame asks the page to open,
// post to, retire and close keepers; the page relays what each keeper says back. The frame keeps
// the session logic (preview-session.ts) unchanged behind its PreviewKeeperHost seam.

/** A keeper the frame asked for, by the frame's own number. */
export type KeeperCommand =
  | { readonly type: "keeper"; readonly keeper: number; readonly action: "open"; readonly url: string }
  | { readonly type: "keeper"; readonly keeper: number; readonly action: "post"; readonly message: unknown; readonly targetOrigin: string }
  | { readonly type: "keeper"; readonly keeper: number; readonly action: "retire"; readonly session: string }
  | { readonly type: "keeper"; readonly keeper: number; readonly action: "close" };

export type KeeperAction =
  | { readonly action: "open"; readonly url: string }
  | { readonly action: "post"; readonly message: unknown; readonly targetOrigin: string }
  | { readonly action: "retire"; readonly session: string }
  | { readonly action: "close" };

const MAX_KEEPER = 0x7fff_ffff;

export function keeperCommand(keeper: number, action: KeeperAction): Readonly<Record<string, unknown>> {
  return { v: FRAME_PROTOCOL_VERSION, type: "keeper", keeper, ...action };
}

/** A keeper's message as the page relays it to the frame; `id` is the keeper's number. */
export function keeperReport(keeper: number, origin: string, data: unknown): Readonly<Record<string, unknown>> {
  return { v: FRAME_PROTOCOL_VERSION, id: keeper, type: "keeper.message", origin, data };
}

export function decodeKeeperCommand(value: Readonly<Record<string, unknown>>): KeeperCommand {
  const keeper = integer(value["keeper"], "keeper", 1, MAX_KEEPER);
  switch (value["action"]) {
    case "open":
      exactKeys(value, ["v", "type", "keeper", "action", "url"]);
      return { type: "keeper", keeper, action: "open", url: string(value["url"], "keeper URL") };
    case "post":
      exactKeys(value, ["v", "type", "keeper", "action", "message", "targetOrigin"]);
      return { type: "keeper", keeper, action: "post", message: value["message"], targetOrigin: string(value["targetOrigin"], "keeper origin") };
    case "retire": {
      exactKeys(value, ["v", "type", "keeper", "action", "session"]);
      const session = string(value["session"], "preview session");
      if (!PREVIEW_SESSION_PATTERN.test(session)) throw new VMError("PROTOCOL_ERROR", "preview session is invalid");
      return { type: "keeper", keeper, action: "retire", session };
    }
    case "close":
      exactKeys(value, ["v", "type", "keeper", "action"]);
      return { type: "keeper", keeper, action: "close" };
    default:
      throw new VMError("PROTOCOL_ERROR", "keeper action is invalid");
  }
}

/**
 * Whether the frame may have the page open `url` as a keeper: only a preview bootstrap
 * (`/__oxidevm/`) on a session origin below the page's own preview origin, so a frame cannot make
 * the page embed anything else.
 */
export function isKeeperURL(url: string, previewOrigin: string, isolation: "per-session" | "shared"): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.pathname !== "/__oxidevm/" || parsed.hash !== "" || parsed.username !== "" || parsed.password !== "") return false;
  const preview = new URL(previewOrigin);
  if (isolation === "shared") return parsed.origin === preview.origin;
  const [label, ...rest] = parsed.hostname.split(".");
  return label !== undefined && PREVIEW_SESSION_PATTERN.test(label) && rest.join(".") === preview.hostname && parsed.port === preview.port && parsed.protocol === preview.protocol;
}

export function decodeKeeperReport(value: Readonly<Record<string, unknown>>): { readonly keeper: number; readonly origin: string; readonly data: unknown } {
  exactKeys(value, ["v", "id", "type", "origin", "data"]);
  return { keeper: integer(value["id"], "keeper", 1, MAX_KEEPER), origin: string(value["origin"], "keeper origin"), data: value["data"] };
}
