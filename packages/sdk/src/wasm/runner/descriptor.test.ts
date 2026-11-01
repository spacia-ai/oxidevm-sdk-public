import { expect, it } from "vitest";
import { VMError } from "../../runtime/errors.js";
import { MAX_DESCRIPTOR_BYTES, decodeLaunchDescriptor, encodeLaunchArgument, parseLaunchArgument } from "./descriptor.js";
import { COMMAND_DECLARATION, SERVICE_DECLARATION, buildRelease } from "./fixtures.test-support.js";

const wasm = Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0);
const release = () => buildRelease({ adapter: "export default () => ({ main: () => 0 });", artifacts: { "tool.wasm": wasm }, declaration: COMMAND_DECLARATION, options: {} });

function thrown(action: () => unknown): unknown {
  try { action(); } catch (error: unknown) { return error; }
  return undefined;
}

it("round-trips a descriptor through its argument form", async () => {
  const { descriptor } = await release();
  const argument = encodeLaunchArgument(descriptor);
  expect(parseLaunchArgument(argument)).toEqual(descriptor);
  const service = await buildRelease({ adapter: "export default () => ({ protocols: {} });", declaration: SERVICE_DECLARATION, options: {}, workspaceId: "ws-1" });
  expect(parseLaunchArgument(encodeLaunchArgument(service.descriptor)).workspaceId).toBe("ws-1");
});

it("accepts a manifest that declares commands and keeps them through the argument form, but not on a service", async () => {
  const { descriptor } = await release();
  const decoded = decodeLaunchDescriptor({ ...descriptor, manifest: { ...descriptor.manifest, commands: ["tool-b", "tool"] } });
  expect(decoded.manifest).toMatchObject({ commands: ["tool", "tool-b"] });
  expect(parseLaunchArgument(encodeLaunchArgument(decoded))).toEqual(decoded);
  const service = await buildRelease({ adapter: "export default () => ({ protocols: {} });", declaration: SERVICE_DECLARATION, options: {}, workspaceId: "ws-1" });
  const refused = thrown(() => decodeLaunchDescriptor({ ...service.descriptor, manifest: { ...service.descriptor.manifest, commands: ["db"] } }));
  expect(refused).toMatchObject({ code: "INVALID_ARGUMENT", detail: { reason: "wasm-manifest-invalid" }, message: expect.stringMatching(/commands: a service cannot declare commands/u) as unknown });
});

it("rejects a pin that disagrees with module.json, a missing pin and an unknown artifact", async () => {
  const { descriptor } = await release();
  const wrongHash = { ...descriptor, artifacts: { "tool.wasm": { ...descriptor.artifacts["tool.wasm"], sha256: "0".repeat(64) } } };
  const wrongSize = { ...descriptor, adapter: { ...descriptor.adapter, bytes: descriptor.adapter.bytes + 1 } };
  const missing = { ...descriptor, artifacts: {} };
  const extra = { ...descriptor, artifacts: { ...descriptor.artifacts, "other.wasm": descriptor.artifacts["tool.wasm"] } };
  for (const bad of [wrongHash, wrongSize, missing, extra]) {
    expect(thrown(() => decodeLaunchDescriptor(bad))).toMatchObject({ code: "INVALID_ARGUMENT", detail: { reason: "wasm-manifest-invalid" } });
  }
});

it("accepts the data URLs a bundler makes of small files, since the pinned digest is what is trusted", async () => {
  const { descriptor } = await release();
  const inlined = `data:text/javascript;base64,${Buffer.from("export default 1").toString("base64")}`;
  const decoded = decodeLaunchDescriptor({ ...descriptor, adapter: { ...descriptor.adapter, url: inlined } });
  expect(decoded.adapter.url).toBe(inlined);
  expect(decodeLaunchDescriptor({ ...descriptor, adapter: { ...descriptor.adapter, url: "data:application/wasm,%00asm" } }).adapter.url).toBe("data:application/wasm,%00asm");
});

it("rejects unknown keys, a wrong version and unsafe URLs or identifiers", async () => {
  const { descriptor } = await release();
  const url = (value: string) => ({ ...descriptor, adapter: { ...descriptor.adapter, url: value } });
  const bad: readonly unknown[] = [
    { ...descriptor, extra: 1 }, { ...descriptor, v: 2 }, { ...descriptor, release: "abc" }, { ...descriptor, options: [] }, { ...descriptor, workspaceId: "../x" },
    url("file:///etc/passwd"), url("javascript:alert(1)"), url("blob:https://app.test/1"), url("https://user:pw@app.test/a.mjs"), url("/relative.mjs"), url("data:"), url("data:text/javascript;base64"), url(`data:text/javascript;base64,${"A".repeat(256 * 1024)}`), null, "text",
  ];
  for (const value of bad) expect(() => decodeLaunchDescriptor(value), JSON.stringify(value).slice(0, 80)).toThrow(VMError);
});

it("refuses a missing, oversized or non-JSON argument before decoding it", () => {
  expect(() => parseLaunchArgument(undefined)).toThrow(/missing/u);
  expect(() => parseLaunchArgument("not json")).toThrow(/not JSON/u);
  expect(() => parseLaunchArgument("x".repeat(MAX_DESCRIPTOR_BYTES + 1))).toThrow(/exceeds/u);
  expect(() => parseLaunchArgument("[]")).toThrow(VMError);
  expect(thrown(() => parseLaunchArgument("{}"))).toMatchObject({ code: "INVALID_ARGUMENT" });
});
