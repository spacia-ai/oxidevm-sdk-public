import type { KeeperMessage, PreviewKeeperHost } from "../../runtime/preview-keeper.js";
import { keeperCommand } from "../protocol/keepers.js";
import type { KeeperAction } from "../protocol/keepers.js";

export interface FrameKeeperHost extends PreviewKeeperHost {
  /** A keeper's message, relayed by the page. */
  deliver(keeper: number, origin: string, data: unknown): void;
}

/**
 * The runtime frame's preview keeper host: keepers live in the page that embeds the frame, so the
 * keeper and the page's preview iframe share one storage partition and the keeper answers to the
 * page's origin. preview-session.ts drives it exactly like the document host of a self-hosted page.
 */
export function frameKeeperHost(embedderOrigin: string, send: (message: Readonly<Record<string, unknown>>, transfer: readonly Transferable[]) => void): FrameKeeperHost {
  const identities = new Map<number, object>();
  const listeners = new Set<(message: KeeperMessage) => void>();
  let next = 1;
  const command = (keeper: number, action: KeeperAction, transfer: readonly Transferable[] = []) => send(keeperCommand(keeper, action), transfer);
  return {
    origin: embedderOrigin,
    open: url => {
      const keeper = next++;
      const identity = {};
      identities.set(keeper, identity);
      command(keeper, { action: "open", url: url.href });
      return {
        source: identity,
        retire: session => command(keeper, { action: "retire", session }),
        close: () => { identities.delete(keeper); command(keeper, { action: "close" }); },
      };
    },
    listen: listener => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    deliver: (keeper, origin, data) => {
      const identity = identities.get(keeper);
      if (identity === undefined) return;
      const message: KeeperMessage = {
        origin, data,
        source: { identity, postMessage: (posted, options) => command(keeper, { action: "post", message: posted, targetOrigin: options.targetOrigin }, options.transfer) },
      };
      for (const listener of [...listeners]) listener(message);
    },
  };
}
