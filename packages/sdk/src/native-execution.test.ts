import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nativeExecutionURL, openNativeExecution } from "./native-execution.js";
import { sdkVersion } from "./sdk-version.js";

const frame = vi.hoisted(() => ({
  open: vi.fn<(url: URL) => Promise<{ readonly port: MessagePort; dispose(): void }>>(),
}));
vi.mock("./runtime/execution-frame.js", () => ({ openExecutionFrame: frame.open }));

const fetchMock = vi.fn<(input: URL | string, init?: RequestInit) => Promise<Response>>();
const RUNTIME_BASE = "/runtime/";
const DESCRIPTOR_URL = "https://app.test/runtime/native-node-api.json";

beforeEach(() => {
  vi.stubGlobal("crossOriginIsolated", true);
  vi.stubGlobal("location", { href: "https://app.test/editor/", origin: "https://app.test" });
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  frame.open.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function descriptor(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 });
}

it("pairs hosted execution assets with this SDK and retains self-hosted descriptors", () => {
  expect(nativeExecutionURL({ version: 2, origin: "https://js.test" }, "https://run.test").href)
    .toBe(`https://js.test/v/${sdkVersion}/oxidevm-native-process/index.html`);
  expect(nativeExecutionURL({ version: 1, origin: "https://js.test" }, "https://run.test").pathname)
    .toBe("/oxidevm-native-process/index.html");
  for (const invalid of [
    { version: 3, origin: "https://js.test" }, { version: 2, origin: "https://run.test" },
    { version: 2, origin: "http://js.test" }, { version: 2, origin: "https://js.test/path" },
    { version: 2, origin: "https://js.test", extra: true },
  ]) expect(() => nativeExecutionURL(invalid, "https://run.test")).toThrow();
});

it("reads a missing descriptor as a runtime without native execution, not as a failure", async () => {
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));

  await expect(openNativeExecution(RUNTIME_BASE)).resolves.toEqual({ status: "absent", reason: "descriptor-absent" });
  expect(String(fetchMock.mock.calls[0]?.[0])).toBe(DESCRIPTOR_URL);
  expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: "omit" });
  expect(frame.open).not.toHaveBeenCalled();
});

it.each([403, 410, 500])("fails closed on HTTP %i, because only 404 means no native execution", async status => {
  fetchMock.mockResolvedValueOnce(new Response(null, { status }));

  await expect(openNativeExecution(RUNTIME_BASE)).rejects.toMatchObject({
    code: "FEATURE_NOT_AVAILABLE",
    detail: { reason: "descriptor-unavailable", status },
  });
});

it("maps a network failure to a typed unreachable-descriptor error", async () => {
  fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

  await expect(openNativeExecution(RUNTIME_BASE)).rejects.toMatchObject({
    code: "FEATURE_NOT_AVAILABLE",
    detail: { reason: "descriptor-unreachable" },
  });
});

it("maps the descriptor timeout to a typed timeout error, not a DOMException", async () => {
  fetchMock.mockRejectedValueOnce(new DOMException("The operation timed out.", "TimeoutError"));

  await expect(openNativeExecution(RUNTIME_BASE)).rejects.toMatchObject({
    code: "FEATURE_NOT_AVAILABLE",
    detail: { reason: "descriptor-timeout" },
  });
});

it("keeps a caller's cancellation as ABORTED rather than a feature failure", async () => {
  const controller = new AbortController();
  fetchMock.mockImplementationOnce(() => {
    controller.abort();
    return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
  });

  await expect(openNativeExecution(RUNTIME_BASE, controller.signal)).rejects.toMatchObject({ code: "ABORTED" });
});

it("rejects a descriptor that is not JSON with a typed protocol error", async () => {
  fetchMock.mockResolvedValueOnce(new Response("<!doctype html><title>app</title>", { status: 200 }));

  await expect(openNativeExecution(RUNTIME_BASE)).rejects.toMatchObject({
    code: "PROTOCOL_ERROR",
    detail: { reason: "descriptor-malformed" },
  });
});

it("bounds the descriptor size before parsing it", async () => {
  fetchMock.mockResolvedValueOnce(new Response("x".repeat(4097), { status: 200 }));

  await expect(openNativeExecution(RUNTIME_BASE)).rejects.toMatchObject({
    code: "PROTOCOL_ERROR",
    detail: { reason: "descriptor-too-large" },
  });
});

it.each<[unknown, string, string]>([
  [[], "descriptor-malformed", "PROTOCOL_ERROR"],
  [{ version: 2 }, "descriptor-malformed", "PROTOCOL_ERROR"],
  [{ version: 2, origin: "https://js.test", extra: true }, "descriptor-malformed", "PROTOCOL_ERROR"],
  [{ version: "2", origin: "https://js.test" }, "descriptor-version", "INVALID_ARGUMENT"],
  [{ version: 3, origin: "https://js.test" }, "descriptor-version", "INVALID_ARGUMENT"],
  [{ version: 2, origin: "not a url" }, "descriptor-origin-invalid", "INVALID_ARGUMENT"],
  [{ version: 2, origin: "https://js.test/path" }, "descriptor-origin-invalid", "INVALID_ARGUMENT"],
  [{ version: 2, origin: "http://js.test" }, "descriptor-origin-untrusted", "INVALID_ARGUMENT"],
  [{ version: 2, origin: "https://app.test" }, "descriptor-origin-runtime", "INVALID_ARGUMENT"],
])("rejects descriptor %j as %s before opening any frame", async (value, reason, code) => {
  fetchMock.mockResolvedValueOnce(descriptor(value));

  await expect(openNativeExecution(RUNTIME_BASE)).rejects.toMatchObject({ code, detail: { reason } });
  expect(frame.open).not.toHaveBeenCalled();
});

it("refuses native execution without cross-origin isolation before any request", async () => {
  vi.stubGlobal("crossOriginIsolated", false);

  await expect(openNativeExecution(RUNTIME_BASE)).rejects.toMatchObject({
    code: "FEATURE_NOT_AVAILABLE",
    detail: { reason: "cross-origin-isolation" },
  });
  expect(fetchMock).not.toHaveBeenCalled();
});

it("opens the paired execution frame for a valid descriptor", async () => {
  fetchMock.mockResolvedValueOnce(descriptor({ version: 2, origin: "https://js.test" }));
  const channel = new MessageChannel();
  frame.open.mockResolvedValueOnce({
    port: channel.port1,
    dispose: () => { channel.port1.close(); channel.port2.close(); },
  });

  const result = await openNativeExecution(RUNTIME_BASE);

  expect(result.status).toBe("open");
  if (result.status === "open") {
    expect(result.port).toBe(channel.port1);
    result.dispose();
  }
  expect(String(frame.open.mock.calls[0]?.[0]))
    .toBe(`https://js.test/v/${sdkVersion}/oxidevm-native-process/index.html`);
});

/** A 200 answer whose body is an HTML app shell, which self-hosted hosts serve for unknown paths. */
function htmlShell(status = 200): Response {
  return new Response("<!doctype html><title>app</title>", { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

it("treats an HTML page answered with 200 as an absent descriptor, like a 404", async () => {
  fetchMock.mockResolvedValueOnce(htmlShell());

  await expect(openNativeExecution(RUNTIME_BASE)).resolves.toEqual({ status: "absent", reason: "descriptor-absent" });
  expect(frame.open).not.toHaveBeenCalled();
});

it("does not read an HTML error page as an absent descriptor", async () => {
  fetchMock.mockResolvedValueOnce(htmlShell(500));

  await expect(openNativeExecution(RUNTIME_BASE)).rejects.toMatchObject({
    code: "FEATURE_NOT_AVAILABLE",
    detail: { reason: "descriptor-unavailable", status: 500 },
  });
});

it.each([
  { name: "text/plain", make: (): Response => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/plain" } }) },
  { name: "application/json", make: (): Response => new Response("<!doctype html>", { status: 200, headers: { "content-type": "application/json" } }) },
  { name: "no content type", make: (): Response => new Response(new TextEncoder().encode("<!doctype html>"), { status: 200 }) },
])("keeps $name answers on the malformed path rather than the absent one", async ({ make }) => {
  fetchMock.mockResolvedValueOnce(make());

  await expect(openNativeExecution(RUNTIME_BASE)).rejects.toMatchObject({
    code: "PROTOCOL_ERROR",
    detail: { reason: "descriptor-malformed" },
  });
  expect(frame.open).not.toHaveBeenCalled();
});

it("accepts a descriptor of exactly 4096 bytes and refuses 4097 bytes as too large", async () => {
  const json = JSON.stringify({ version: 2, origin: "https://js.test" });
  // Trailing JSON whitespace pads the body to the exact byte count without changing the descriptor.
  const padded = (bytes: number): string => `${json}${" ".repeat(bytes - json.length)}`;
  const channel = new MessageChannel();
  frame.open.mockResolvedValueOnce({
    port: channel.port1,
    dispose: () => { channel.port1.close(); channel.port2.close(); },
  });
  fetchMock.mockResolvedValueOnce(new Response(padded(4096), { status: 200 }));

  const result = await openNativeExecution(RUNTIME_BASE);

  expect(result.status).toBe("open");
  if (result.status === "open") result.dispose();
  fetchMock.mockResolvedValueOnce(new Response(padded(4097), { status: 200 }));
  await expect(openNativeExecution(RUNTIME_BASE)).rejects.toMatchObject({
    code: "PROTOCOL_ERROR",
    detail: { reason: "descriptor-too-large" },
  });
});

it("counts UTF-8 bytes rather than UTF-16 units against the limit", async () => {
  // 2048 two-byte characters are exactly 4096 bytes: the size check passes and the text fails to parse.
  fetchMock.mockResolvedValueOnce(new Response("é".repeat(2048), { status: 200 }));
  await expect(openNativeExecution(RUNTIME_BASE)).rejects.toMatchObject({
    code: "PROTOCOL_ERROR",
    detail: { reason: "descriptor-malformed" },
  });
  // 2049 characters are 4098 bytes: over the limit, though under 4096 UTF-16 units.
  fetchMock.mockResolvedValueOnce(new Response("é".repeat(2049), { status: 200 }));
  await expect(openNativeExecution(RUNTIME_BASE)).rejects.toMatchObject({
    code: "PROTOCOL_ERROR",
    detail: { reason: "descriptor-too-large" },
  });
});

it("refuses bytes that are not UTF-8 as a malformed descriptor", async () => {
  fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([0x7b, 0xff, 0x7d]), { status: 200 }));

  await expect(openNativeExecution(RUNTIME_BASE)).rejects.toMatchObject({
    code: "PROTOCOL_ERROR",
    detail: { reason: "descriptor-malformed" },
  });
});
