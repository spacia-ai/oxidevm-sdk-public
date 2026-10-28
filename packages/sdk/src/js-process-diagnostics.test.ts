import { expect, it } from "vitest";
import { decodeJSProcessTrace } from "./js-process-diagnostics.js";
import { decodeProcessId } from "./values.js";
import { Writer } from "./runtime/js-process/codec.js";

it("reports the admitted profile and keeps pre-profile rejections unattributed", () => {
  const browser = (profile: string) => new Writer().raw(new TextEncoder().encode("OXJT")).u32(15).u64(0n).u32(0).u32(1).u32(0)
    .u64(1n).u32(10).u32(10).u64(9n).u8(0).u8(1).u64(2n).u64(3n).u64(8n).u8(0)
    .u32(1).path("/workspace/probe.cjs").path(profile).u8(0).finish();
  expect(decodeJSProcessTrace(browser("native-parity-fixture-v1")).placements[0]).toMatchObject({ profile: "native-parity-fixture-v1", placement: "browser" });
  expect(() => decodeJSProcessTrace(browser(""))).toThrow();
  expect(() => decodeJSProcessTrace(browser("arbitrary-profile"))).toThrow();
});

it("reports an environment rejection category and parent without including its value", () => {
  function record(tag = 4, reason = 12) {
    return new Writer().raw(new TextEncoder().encode("OXJT")).u32(15).u64(0n).u32(0).u32(1).u32(0)
      .u64(1n).u32(10).u32(10).u64(9n).u8(1).u8(0).u32(reason).u32(3).path("/workspace/tool.cjs").path("").u8(tag).path("NODE_PATH").finish();
  }
  expect(decodeJSProcessTrace(record()).placements[0]).toMatchObject({ parentPid: 3, entry: "/workspace/tool.cjs", reason: "unsupported-environment", environment: { variable: "NODE_PATH", category: "relative-search-path" } });
  expect(() => decodeJSProcessTrace(record(99))).toThrow();
  expect(() => decodeJSProcessTrace(record(4, 11))).toThrow("unrelated rejection");
});

it.each([[65541, "start-thread"], [65546, "prepare-thread-eval"], [65547, "umask"], [65548, "path-search"], [65549, "poll-pipes"]])("retains native task identity for bridge operation %s without an instruction address", (operation, kind) => {
  const bytes = new Writer().raw(new TextEncoder().encode("OXJT")).u32(15).u64(0n).u32(1).u32(0).u32(0)
    .u64(1n).u64(2n).u64(3n).u64(4n).u32(10).u32(11).u32(operation).u32(1).u32(0).finish();
  expect(decodeJSProcessTrace(bytes).events[0]).toMatchObject({ pid: 10, tid: 11, operation: { kind } });
  const stale = bytes.slice(); new DataView(stale.buffer).setUint32(4, 1, true);
  expect(() => decodeJSProcessTrace(stale)).toThrow("version mismatch");
  new DataView(stale.buffer).setUint32(4, 9, true);
  expect(() => decodeJSProcessTrace(stale)).toThrow("version mismatch");
  new DataView(stale.buffer).setUint32(4, 10, true);
  expect(() => decodeJSProcessTrace(stale)).toThrow("version mismatch");
});

it("reports profile placement and native rejection without fabricating a JS incarnation", () => {
  const bytes = new Writer().raw(new TextEncoder().encode("OXJT")).u32(15).u64(0n).u32(0).u32(2).u32(0)
    .u64(1n).u32(10).u32(10).u64(9n).u8(1).u8(0).u32(11).u32(1).path("").path("").u8(0)
    .u64(2n).u32(11).u32(11).u64(10n).u8(0).u8(1).u64(2n).u64(3n).u64(8n).u8(1).u32(10).path("/workspace/main.cjs").path("node24-bun1-v1").u8(0).finish();
  expect(decodeJSProcessTrace(bytes).placements).toEqual([
    { ordinal: 1n, pid: 10, parentPid: 1, entry: null, environment: null, tid: 10, addressSpaceId: 9n, runtime: "bun", profile: null, placement: "linux", reason: "unsupported-invocation" },
    { ordinal: 2n, pid: 11, parentPid: 10, entry: "/workspace/main.cjs", tid: 11, addressSpaceId: 10n, runtime: "node", profile: "node24-bun1-v1", placement: "browser", generation: 2n, incarnationId: 3n, dependencyGeneration: 8n, basis: "no-addons" },
  ]);
});

it("retains a distinct runtime qualification rejection", () => {
  const bytes = new Writer().raw(new TextEncoder().encode("OXJT")).u32(15).u64(0n).u32(0).u32(1).u32(0)
    .u64(1n).u32(10).u32(10).u64(9n).u8(1).u8(0).u32(31).u32(1)
    .path("/workspace/main.cjs").path("native-parity-fixture-v1").u8(0).finish();
  expect(decodeJSProcessTrace(bytes).placements[0]).toMatchObject({ runtime: "bun", reason: "native-runtime-not-qualified", profile: "native-parity-fixture-v1" });
});

it("rejects unknown placement reasons, stale boundaries, invalid identities and over-capacity traces", () => {
  function rejected(reason = 11, ordinal = 1n, addressSpace = 9n, runtime = 1) {
    return new Writer().raw(new TextEncoder().encode("OXJT")).u32(15).u64(0n).u32(0).u32(1).u32(0)
      .u64(ordinal).u32(10).u32(10).u64(addressSpace).u8(runtime).u8(0).u32(reason).u32(1).path("/workspace/main.cjs").path("node24-bun1-v1").u8(0).finish();
  }
  for (const [offset, reason] of ["library-unavailable", "library-hash-mismatch", "dependency-metadata-invalid", "dependency-closure-mismatch", "native-promise-predicate-unavailable", "native-error-predicate-unavailable"].entries()) expect(decodeJSProcessTrace(rejected(25 + offset)).placements[0]).toMatchObject({ reason });
  for (const bytes of [rejected(0), rejected(39), rejected(11, 0n), rejected(11, 1n, 0n), rejected(11, 1n, 9n, 2), rejected().subarray(0, -1)]) expect(() => decodeJSProcessTrace(bytes)).toThrow();
  const stale = rejected().slice(); new DataView(stale.buffer).setUint32(4, 3, true);
  expect(() => decodeJSProcessTrace(stale)).toThrow("version mismatch");
  new DataView(stale.buffer).setUint32(4, 11, true);
  expect(() => decodeJSProcessTrace(stale)).toThrow("version mismatch");
  new DataView(stale.buffer).setUint32(4, 12, true);
  expect(() => decodeJSProcessTrace(stale)).toThrow("version mismatch");
  new DataView(stale.buffer).setUint32(4, 13, true);
  expect(() => decodeJSProcessTrace(stale)).toThrow("version mismatch");
  new DataView(stale.buffer).setUint32(4, 14, true);
  expect(() => decodeJSProcessTrace(stale)).toThrow("version mismatch");
  const excessive = rejected().slice(); new DataView(excessive.buffer).setUint32(20, 4097, true);
  expect(() => decodeJSProcessTrace(excessive)).toThrow("capacity");
  const trailing = new Uint8Array(rejected().length + 1); trailing.set(rejected());
  expect(() => decodeJSProcessTrace(trailing)).toThrow();
});

it("pins every placement reason to its Rust code", () => {
  const codes = {
    1: "unsupported-security", 2: "unsupported-filesystem", 3: "unsupported-cgroup", 4: "mount-namespace", 5: "pid-namespace", 6: "uts-namespace",
    7: "ipc-namespace", 8: "net-namespace", 9: "cgroup-namespace", 10: "user-namespace", 11: "unsupported-invocation", 12: "unsupported-environment",
    13: "entry-unavailable", 14: "entry-outside-workspace", 15: "profile-unavailable", 16: "profile-invalid", 17: "dependency-unavailable",
    18: "dependency-escape", 19: "runtime-unavailable", 20: "runtime-hash-mismatch", 21: "host-unavailable", 22: "host-hash-mismatch",
    23: "addon-unavailable", 24: "addon-hash-mismatch", 25: "library-unavailable", 26: "library-hash-mismatch", 27: "dependency-metadata-invalid",
    28: "dependency-closure-mismatch", 29: "native-promise-predicate-unavailable", 30: "native-error-predicate-unavailable",
    31: "native-runtime-not-qualified", 32: "host-untrusted", 33: "root-capture-limit", 34: "root-capture-unsupported", 35: "addon-unqualified",
    36: "command-capacity", 37: "remembered-failure", 38: "placement-override",
  } as const;
  for (const [code, reason] of Object.entries(codes)) {
    const bytes = new Writer().raw(new TextEncoder().encode("OXJT")).u32(15).u64(0n).u32(0).u32(1).u32(0)
      .u64(1n).u32(10).u32(10).u64(9n).u8(0).u8(0).u32(Number(code)).u32(1).path("/workspace/main.cjs").path("").u8(0).finish();
    expect(decodeJSProcessTrace(bytes).placements[0]).toMatchObject({ placement: "linux", reason });
  }
});

it("reports why the fast path vouched for an admitted launch", () => {
  const browser = (basis: number) => new Writer().raw(new TextEncoder().encode("OXJT")).u32(15).u64(0n).u32(0).u32(1).u32(0)
    .u64(1n).u32(10).u32(10).u64(9n).u8(0).u8(1).u64(2n).u64(3n).u64(8n).u8(basis)
    .u32(1).path("/workspace/probe.cjs").path("node24-bun1-v1").u8(0).finish();
  expect(decodeJSProcessTrace(browser(0)).placements[0]).toMatchObject({ placement: "browser", basis: "qualified" });
  expect(decodeJSProcessTrace(browser(1)).placements[0]).toMatchObject({ placement: "browser", basis: "no-addons" });
  expect(() => decodeJSProcessTrace(browser(2))).toThrow();
});

it("reports immutable image code roots with exact content identities under trace 16", () => {
  const bytes = new Writer().raw(new TextEncoder().encode("OXJT")).u32(16).u64(0n).u32(0).u32(1).u32(0)
    .u64(1n).u32(10).u32(10).u64(9n).u8(0).u8(1).u64(2n).u64(3n).u64(8n).u8(1)
    .u32(1).path("/usr/lib/tool/main.js").path("node24-bun1-v1").u8(0)
    .u32(1).u8(2).path("/usr/lib/tool").raw(new Uint8Array(32).fill(0xaa)).finish();
  expect(decodeJSProcessTrace(bytes).placements[0]).toMatchObject({
    placement: "browser", entry: "/usr/lib/tool/main.js",
    codeRoots: [{ kind: "image", path: "/usr/lib/tool", contentSHA256: "aa".repeat(32) }],
  });
  expect(() => decodeJSProcessTrace(bytes.subarray(0, -1))).toThrow();
});

it("reads historical installed-tool Linux placement without claiming image admission", () => {
  const bytes = new Writer().raw(new TextEncoder().encode("OXJT")).u32(15).u64(0n).u32(0).u32(1).u32(0)
    .u64(1n).u32(10).u32(10).u64(9n).u8(0).u8(0).u32(14).u32(1)
    .path("/usr/lib/node_modules/npm/bin/npm-cli.js").path("node24-bun1-v1").u8(0).finish();
  expect(decodeJSProcessTrace(bytes).placements[0]).toMatchObject({ placement: "linux", reason: "entry-outside-workspace", entry: "/usr/lib/node_modules/npm/bin/npm-cli.js" });
});

it.each([15, 16])("rejects an undeclared browser image entry under trace %s", version => {
  const record = new Writer().raw(new TextEncoder().encode("OXJT")).u32(version).u64(0n).u32(0).u32(1).u32(0)
    .u64(1n).u32(10).u32(10).u64(9n).u8(0).u8(1).u64(2n).u64(3n).u64(8n).u8(1)
    .u32(1).path("/usr/lib/undeclared/main.js").path("node24-bun1-v1").u8(0);
  if (version === 16) record.u32(0);
  expect(() => decodeJSProcessTrace(record.finish())).toThrow();
});

it("reports each late fast-path failure Rust remembered, in the trace's one ordinal sequence", () => {
  const failure = (kind: number, detail: string, session = 40, ordinal = 2n) => new Writer().raw(new TextEncoder().encode("OXJT")).u32(15).u64(0n).u32(0).u32(1).u32(1)
    .u64(1n).u32(42).u32(42).u64(9n).u8(0).u8(1).u64(2n).u64(3n).u64(8n).u8(1).u32(40).path("/workspace/app/main.cjs").path("node24-bun1-v1").u8(0)
    .u64(ordinal).u32(42).u32(session).u64(2n).u64(3n).u8(kind).u8(detail.length).raw(new TextEncoder().encode(detail)).finish();
  expect(decodeJSProcessTrace(failure(1, "node:sqlite")).failures).toEqual([
    { ordinal: 2n, pid: decodeProcessId(42), session: decodeProcessId(40), generation: 2n, incarnationId: 3n, kind: "unavailable-builtin", detail: "node:sqlite" },
  ]);
  expect(decodeJSProcessTrace(failure(4, "", 0)).failures[0]).toMatchObject({ kind: "eval-worker", session: null });
  for (const bytes of [failure(0, "x"), failure(5, "x"), failure(9, "x"), failure(1, "a\nb"), failure(1, "x", 40, 1n), failure(1, "x").subarray(0, -1)]) {
    expect(() => decodeJSProcessTrace(bytes)).toThrow();
  }
});
