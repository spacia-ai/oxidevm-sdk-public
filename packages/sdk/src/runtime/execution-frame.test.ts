import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openExecutionFrame } from "./execution-frame.js";

const EXECUTION_URL = new URL("https://js.test/v/1/oxidevm-native-process/index.html");

interface Posted { readonly message: unknown; readonly targetOrigin: string }

/** The iframe as `openExecutionFrame` uses it. `deliver` decides what the framed document does with the bootstrap. */
function fakeFrame(deliver: (posted: Posted) => void) {
  return {
    hidden: false, allow: "", src: "", sandbox: { add: vi.fn<(...tokens: string[]) => void>() },
    onload: null as (() => void) | null, onerror: null as (() => void) | null,
    contentWindow: { postMessage: (message: unknown, targetOrigin: string) => { deliver({ message, targetOrigin }); } },
    remove: vi.fn<() => void>(),
  };
}

function install(frame: ReturnType<typeof fakeFrame>, ancestorOrigins?: readonly string[]): void {
  vi.stubGlobal("location", { origin: "https://run.test", ...(ancestorOrigins === undefined ? {} : { ancestorOrigins }) });
  vi.stubGlobal("document", { createElement: () => frame, body: { append: vi.fn<(node: unknown) => void>() } });
}

function bootstrapOf(port: MessagePort, nonce: string): object { return { type: "bootstrap", nonce, port }; }

function portOf(message: unknown): MessagePort {
  if (typeof message !== "object" || message === null || !("port" in message) || !(message.port instanceof MessagePort)) throw new Error("bootstrap carried no port");
  return message.port;
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("opens once the framed document answers its bootstrap", async () => {
  const frame = fakeFrame(posted => { portOf(posted.message).postMessage("ready"); });
  install(frame);

  const opening = openExecutionFrame(EXECUTION_URL, bootstrapOf, input => input);
  frame.onload?.();
  const connection = await opening;

  expect(connection.receipt).toBe("ready");
  connection.dispose();
  expect(frame.remove).toHaveBeenCalledOnce();
});

it("names the execution origin and this page's ancestors when a loaded document never answers", async () => {
  // A document refused by its own frame-ancestors policy still fires `load`, and its bootstrap message is dropped.
  const frame = fakeFrame(() => undefined);
  install(frame, ["https://app.example"]);

  const opening = openExecutionFrame(EXECUTION_URL, bootstrapOf, input => input);
  const failure = expect(opening).rejects.toMatchObject({
    code: "CORE_LOAD_FAILED",
    message: expect.stringMatching(/https:\/\/js\.test.*frame-ancestors/u) as unknown,
    detail: { reason: "execution-document-silent", origin: "https://js.test", ancestors: ["https://app.example"] },
  });
  frame.onload?.();
  await vi.advanceTimersByTimeAsync(10_000);

  await failure;
  expect(frame.remove).toHaveBeenCalledOnce();
});

it("reports a document that never loaded separately, and without ancestors where the browser exposes none", async () => {
  const frame = fakeFrame(() => undefined);
  install(frame);

  const opening = openExecutionFrame(EXECUTION_URL, bootstrapOf, input => input);
  const failure = expect(opening).rejects.toMatchObject({
    code: "CORE_LOAD_FAILED",
    detail: { reason: "execution-document-not-loaded", origin: "https://js.test" },
  });
  await vi.advanceTimersByTimeAsync(10_000);

  await failure;
  await expect(opening).rejects.not.toHaveProperty("detail.ancestors");
});
