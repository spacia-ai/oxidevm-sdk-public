import type { PreviewOptions } from "../../contracts.js";
import { VMError } from "../../runtime/errors.js";
import { isKeeperURL } from "../protocol/keepers.js";
import type { KeeperCommand } from "../protocol/keepers.js";

/** The page's preview keepers for the runtime frame: opened, posted to and closed on its command. */
export interface PageKeepers {
  handle(command: KeeperCommand, ports: readonly MessagePort[]): void;
  /** Removes every keeper and stops relaying. */
  dispose(): void;
}

/**
 * Embeds the preview keepers the runtime frame asks for, as hidden sandboxed iframes of this page
 * (the same element preview-session.ts embeds in a self-hosted page), and relays each keeper's
 * messages to the frame. Only bootstrap URLs below the page's own preview origin are opened, and
 * a keeper is only ever posted to on its own origin.
 */
export function pageKeepers(preview: PreviewOptions | undefined, report: (keeper: number, origin: string, data: unknown) => void): PageKeepers {
  const keepers = new Map<number, { readonly frame: HTMLIFrameElement; readonly origin: string }>();
  const listener = (event: MessageEvent<unknown>) => {
    for (const [keeper, entry] of keepers) {
      if (event.source === entry.frame.contentWindow && event.origin === entry.origin) { report(keeper, event.origin, event.data); return; }
    }
  };
  // The page starts listening with its first keeper; a VM without previews never touches the window.
  let listening = false;
  return {
    handle: (command, ports) => {
      const entry = keepers.get(command.keeper);
      switch (command.action) {
        case "open": {
          if (preview === undefined) throw new VMError("PROTOCOL_ERROR", "the frame opened a preview keeper, but this page configured no previews");
          if (entry !== undefined || !isKeeperURL(command.url, String(preview.origin), preview.isolation)) throw new VMError("PROTOCOL_ERROR", "the frame asked for a keeper this page does not allow");
          if (!listening) { window.addEventListener("message", listener); listening = true; }
          const frame = document.createElement("iframe");
          frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
          frame.setAttribute("aria-hidden", "true");
          frame.style.display = "none";
          frame.title = "OxideVM preview session keeper";
          frame.src = command.url;
          keepers.set(command.keeper, { frame, origin: new URL(command.url).origin });
          document.body.append(frame);
          return;
        }
        case "post":
          if (entry === undefined || command.targetOrigin !== entry.origin) return;
          entry.frame.contentWindow?.postMessage(command.message, { targetOrigin: entry.origin, transfer: [...ports] });
          return;
        case "retire":
          entry?.frame.contentWindow?.postMessage({ kind: "oxidevm-preview-retire", session: command.session }, entry.origin);
          return;
        case "close":
          entry?.frame.remove();
          keepers.delete(command.keeper);
          return;
      }
    },
    dispose: () => {
      if (listening) window.removeEventListener("message", listener);
      listening = false;
      for (const entry of keepers.values()) entry.frame.remove();
      keepers.clear();
    },
  };
}
