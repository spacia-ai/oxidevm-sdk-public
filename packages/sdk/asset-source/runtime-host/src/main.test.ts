import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VM } from "../../../src/contracts.js";
import type { FrameServerOptions } from "../../../src/frame/host/server.js";
import { frameConnect } from "../../../src/frame/protocol/handshake.js";
import type { PreviewKeeperHost } from "../../../src/runtime/preview-keeper.js";

// The runtime frame's page (main.ts) as a page embeds it: when it registers its offline shell (sw.ts). Installing the
// shell precaches every file of the build at once, so a registration at frame load competed with the cold VM start's
// engine and image downloads and fetched files no start needs. The frame registers it once its VM is ready.

const state = vi.hoisted(() => ({
  createLocalVM: vi.fn<() => Promise<unknown>>(),
  served: Promise.withResolvers<FrameServerOptions>(),
}));
vi.mock("../../../src/local-vm.js", () => ({ createLocalVM: () => state.createLocalVM() }));
vi.mock("../../../src/frame/host/server.js", () => ({ serveFrame: (_port: MessagePort, options: FrameServerOptions) => { state.served.resolve(options); } }));
vi.mock("../../../src/frame/protocol/options.js", () => ({ decodeFrameOptions: () => ({ mode: "userspace" }) }));

const FRAME = "https://run.oxidevm.dev/v/0.0.17/";
const PAGE = "https://app.example.com";
const keepers: PreviewKeeperHost = { origin: PAGE, open: () => { throw new Error("no preview in this test"); }, listen: () => () => undefined };

type MessageListener = (event: { readonly source: unknown; readonly origin: string; readonly data: unknown; readonly ports: readonly MessagePort[] }) => void;
let listeners: MessageListener[] = [];
const parent = { postMessage: vi.fn() };
/**
 * The frame's Service Worker registrations, as script URL and options. A plain function rather than a spy: a spy
 * handles the promises it returns, which would hide a refusal the frame leaves unhandled.
 */
let registered: [string, RegistrationOptions][] = [];
let registration: () => Promise<never> = () => new Promise<never>(() => undefined);
function register(script: URL, options: RegistrationOptions): Promise<never> {
  registered.push([script.href, options]);
  return registration();
}

beforeEach(() => {
  vi.resetModules();
  state.createLocalVM.mockReset();
  state.served = Promise.withResolvers<FrameServerOptions>();
  listeners = [];
  registered = [];
  registration = () => new Promise<never>(() => undefined);
  vi.stubGlobal("OXIDEVM_TELEMETRY_ENDPOINT", "");
  vi.stubGlobal("location", new URL(FRAME));
  vi.stubGlobal("crossOriginIsolated", true);
  vi.stubGlobal("navigator", { serviceWorker: { register } });
  vi.stubGlobal("window", { parent, addEventListener: (type: string, listener: MessageListener) => { if (type === "message") listeners.push(listener); } });
});
afterEach(() => { vi.unstubAllGlobals(); });

/** Loads the frame page and connects to it as the embedding page; resolves with what the frame serves the page. */
async function connected(): Promise<FrameServerOptions> {
  await import("./main.ts");
  const { port1 } = new MessageChannel();
  for (const listener of listeners) listener({ source: parent, origin: PAGE, data: frameConnect("0.0.17"), ports: [port1] });
  const served = await state.served.promise;
  port1.close();
  return served;
}

function create(server: FrameServerOptions): Promise<VM> {
  return server.create({}, new AbortController().signal, () => undefined, keepers);
}

it("registers the offline shell only once its VM is ready, never while the VM starts", async () => {
  const started = Promise.withResolvers<unknown>(), vm = { license: { tier: "free" } };
  state.createLocalVM.mockReturnValue(started.promise);
  const server = await connected();
  expect(registered).toEqual([]);
  const created = create(server);
  await vi.waitFor(() => { expect(state.createLocalVM).toHaveBeenCalledOnce(); });
  expect(registered).toEqual([]);
  started.resolve(vm);
  expect(await created).toBe(vm);
  expect(registered).toEqual([[`${FRAME}sw.js`, { scope: "./" }]]);
});

it("registers nothing when the VM fails to start", async () => {
  state.createLocalVM.mockRejectedValue(new Error("no VM"));
  await expect(create(await connected())).rejects.toThrow("no VM");
  expect(registered).toEqual([]);
});

it("hands the page its VM when the browser refuses the shell's Service Worker", async () => {
  const vm = { license: { tier: "free" } };
  state.createLocalVM.mockResolvedValue(vm);
  registration = () => Promise.reject(new DOMException("refused", "SecurityError"));
  expect(await create(await connected())).toBe(vm);
  expect(registered).toHaveLength(1);
});

it("hands the page its VM in a browser without Service Workers in this frame", async () => {
  const vm = { license: { tier: "free" } };
  state.createLocalVM.mockResolvedValue(vm);
  vi.stubGlobal("navigator", {});
  expect(await create(await connected())).toBe(vm);
});

it("hands the page its VM when reading navigator.serviceWorker throws", async () => {
  const vm = { license: { tier: "free" } };
  state.createLocalVM.mockResolvedValue(vm);
  vi.stubGlobal("navigator", { get serviceWorker(): never { throw new DOMException("The operation is insecure.", "SecurityError"); } });
  expect(await create(await connected())).toBe(vm);
});
