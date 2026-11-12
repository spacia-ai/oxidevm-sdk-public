import { vi } from "vitest";
import type { BlockedSiteSource } from "./preview-blocked-sites.js";

// Windows that preview pages post blocked-site reports to (ADR 0030 D6), for the watch tests.

type MessageListener = (event: MessageEvent<unknown>) => void;

/** What a preview page posts to the document that frames it when its CSP blocked another site. */
export function blockedSiteReport(site: string, directive = "connect"): Readonly<Record<string, unknown>> {
  return { type: "oxidevm-preview-blocked-site", version: 1, site, directive };
}

export interface FakeWindow {
  readonly target: BlockedSiteSource;
  /** The message listeners the window holds now. */
  readonly listeners: ReadonlySet<MessageListener>;
  /** Delivers `data` to every listener as a message from `origin`. */
  post(origin: string, data: unknown): void;
}

export function fakeWindow(): FakeWindow {
  const listeners = new Set<MessageListener>();
  const add = (_type: "message", listener: MessageListener): void => { listeners.add(listener); };
  const remove = (_type: "message", listener: MessageListener): void => { listeners.delete(listener); };
  return {
    target: { addEventListener: add, removeEventListener: remove },
    listeners,
    post: (origin, data) => { for (const listener of [...listeners]) listener(new MessageEvent("message", { origin, data })); },
  };
}

/** Gives `globalThis` a fake window's listeners, as the page that frames the previews has; undo with `vi.unstubAllGlobals()`. */
export function stubPageWindow(): FakeWindow {
  const page = fakeWindow();
  vi.stubGlobal("addEventListener", (type: "message", listener: MessageListener) => { page.target.addEventListener(type, listener); });
  vi.stubGlobal("removeEventListener", (type: "message", listener: MessageListener) => { page.target.removeEventListener(type, listener); });
  return page;
}
