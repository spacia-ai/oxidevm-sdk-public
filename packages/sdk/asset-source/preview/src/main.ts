// The preview keeper: one hidden document per session origin, embedded by the SDK. It registers
// this origin's Service Worker, grants it the transport the IDE hands over, keeps it alive, and
// grants a fresh one whenever the worker asks or a ping finds it without one.
import { decodeKeeperBootstrap, Keeper, REPLY_MS, registrationFailure, type KeeperFailure } from "./keeper";
import { registerPreviewWorker } from "./keeper-worker";

const bootstrap = decodeKeeperBootstrap(location.search, location);
const { session, parentOrigin } = bootstrap;
const ownerValue: unknown = window.parent === window ? window.opener : window.parent;
if (!isOwner(ownerValue)) throw new TypeError("preview requires an owning IDE");
const owner = ownerValue;
if (!("serviceWorker" in navigator)) {
  fail("service-worker-blocked");
  throw new TypeError("preview requires a Service Worker");
}
const registration = await registerPreviewWorker(navigator.serviceWorker).catch((error: unknown) => {
  fail(registrationFailure(error));
  throw error;
});
await navigator.serviceWorker.ready;

const keeper = new Keeper(bootstrap, {
  owner,
  worker: () => registration.active ?? registration.waiting ?? registration.installing,
  requestPort,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});
navigator.serviceWorker.addEventListener("message", (event: MessageEvent<unknown>) => { keeper.onWorkerMessage(event.data); });
navigator.serviceWorker.startMessages();
window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.origin !== parentOrigin || event.source !== owner) return;
  const message = event.data;
  if (isKind(message, "oxidevm-preview-retire") && message["session"] === session) keeper.retire();
});

await keeper.attach();
owner.postMessage({ kind: "oxidevm-preview-ready", session }, parentOrigin);
await keeper.run();

/** Tells the owner at once why this session cannot open, instead of letting it wait. */
function fail(reason: KeeperFailure): void {
  owner.postMessage({ kind: "oxidevm-preview-failed", session, reason }, parentOrigin);
}

function requestPort(): Promise<MessagePort> {
  return new Promise<MessagePort>((resolve, reject) => {
    const timeout = setTimeout(() => { window.removeEventListener("message", receive); reject(new TypeError("preview owner did not respond")); }, REPLY_MS * 2);
    const receive = (event: MessageEvent<unknown>) => {
      if (event.origin !== parentOrigin || event.source !== owner) return;
      const message = event.data;
      if (!isKind(message, "oxidevm-preview-port") || Object.keys(message).length !== 3 || message["session"] !== session || !(message["port"] instanceof MessagePort)) return;
      clearTimeout(timeout);
      window.removeEventListener("message", receive);
      resolve(message["port"]);
    };
    window.addEventListener("message", receive);
    owner.postMessage({ kind: "oxidevm-preview-connect", session }, parentOrigin);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isKind(value: unknown, kind: string): value is Record<string, unknown> {
  return isRecord(value) && value["kind"] === kind;
}

function isOwner(value: unknown): value is { postMessage(message: unknown, targetOrigin: string): void } {
  return isRecord(value) && typeof value["postMessage"] === "function";
}
