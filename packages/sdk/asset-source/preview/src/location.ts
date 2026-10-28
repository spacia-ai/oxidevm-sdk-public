// Reports the preview page's location to the Playground and obeys its back, forward and reload.
// The worker injects this classic script into every proxied HTML page, ahead of the app's own
// scripts and with the Playground's origin in data-oxidevm-parent, so the history wrappers see
// every change the app makes.
import { previewProgress } from "./progress";

const LOCATION = "oxidevm-preview-location";
const NAVIGATE = "oxidevm-preview-navigate";

const parentOrigin = scriptParent();
if (parentOrigin !== null && window.parent !== window) {
  const parent = window.parent;
  const progress = previewProgress(parent, parentOrigin);
  const report = (): void => {
    parent.postMessage({ type: LOCATION, href: window.location.href }, parentOrigin);
  };
  const history = window.history;
  const pushState = history.pushState.bind(history);
  const replaceState = history.replaceState.bind(history);
  history.pushState = (data: unknown, unused: string, url?: string | URL | null) => {
    pushState(data, unused, url);
    report();
  };
  history.replaceState = (data: unknown, unused: string, url?: string | URL | null) => {
    replaceState(data, unused, url);
    report();
  };
  window.addEventListener("popstate", report);
  window.addEventListener("hashchange", report);
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.origin !== parentOrigin || event.source !== parent) return;
    progress(event.data);
    const action = navigation(event.data);
    if (action === "back") history.back();
    else if (action === "forward") history.forward();
    else if (action === "reload") window.location.reload();
  });
  report();
}

/** The Playground origin from this script's tag, read structurally: https, or http on this machine. */
function scriptParent(): string | null {
  const script: unknown = document.currentScript;
  if (typeof script !== "object" || script === null || !("dataset" in script)) return null;
  const dataset: unknown = script.dataset;
  if (typeof dataset !== "object" || dataset === null || !("oxidevmParent" in dataset)) return null;
  const value: unknown = dataset.oxidevmParent;
  if (typeof value !== "string" || !URL.canParse(value)) return null;
  const url = new URL(value);
  const localHttp = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  return (url.protocol === "https:" || localHttp) && url.origin === value ? value : null;
}

/** The Playground's navigation request: exactly {type, action}. */
function navigation(value: unknown): "back" | "forward" | "reload" | null {
  if (typeof value !== "object" || value === null) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !("type" in value) || !("action" in value) || value.type !== NAVIGATE) return null;
  const action = value.action;
  return action === "back" || action === "forward" || action === "reload" ? action : null;
}
