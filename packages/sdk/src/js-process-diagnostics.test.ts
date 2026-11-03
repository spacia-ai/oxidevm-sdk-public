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
    { ordinal: 1n, pid: 10, parentPid: 1, entry: null, environment: null, tid: 10, addressSpaceId: 9n, subject: "bun", runtime: "bun", profile: null, placement: "linux", reason: "unsupported-invocation" },
    { ordinal: 2n, pid: 11, parentPid: 10, entry: "/workspace/main.cjs", tid: 11, addressSpaceId: 10n, subject: "node", runtime: "node", profile: "node24-bun1-v1", placement: "browser", generation: 2n, incarnationId: 3n, dependencyGeneration: 8n, basis: "no-addons" },
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

/** One OXJT 17 placement row (engine `JsPlacementTraceEvent::encode`): the subject precedes the placement tag. */
function placement17(writer: Writer, row: { readonly ordinal?: bigint; readonly subject: number; readonly tag: number; readonly fields: (writer: Writer) => Writer; readonly entry?: string; readonly profile?: string; readonly environment?: readonly [number, string] }): Writer {
  writer.u64(row.ordinal ?? 1n).u32(42).u32(42).u64(9n).u8(row.subject).u8(row.tag);
  row.fields(writer).u32(20).blob(new TextEncoder().encode(row.entry ?? "/usr/local/bin/typst")).blob(new TextEncoder().encode(row.profile ?? ""));
  if (row.environment === undefined) writer.u8(0); else writer.u8(row.environment[0]).path(row.environment[1]);
  return writer.u32(0);
}
function trace17(...rows: readonly Parameters<typeof placement17>[1][]): Uint8Array {
  const writer = new Writer().raw(new TextEncoder().encode("OXJT")).u32(17).u64(0n).u32(0).u32(rows.length).u32(0);
  for (const [index, row] of rows.entries()) placement17(writer, { ordinal: BigInt(index + 1), ...row });
  return writer.finish();
}
const browserModule = (registration = 3, generation = 7n, incarnation = 8n) => (writer: Writer) => writer.u64(generation).u64(incarnation).u32(registration);
const linuxReason = (reason: number) => (writer: Writer) => writer.u32(reason);

it("reads a module command's browser placement with its registration and its Linux placements with reasons 41 and 42 under trace 17", () => {
  expect(decodeJSProcessTrace(trace17(
    { subject: 2, tag: 2, fields: browserModule() },
    { subject: 2, tag: 0, fields: linuxReason(42) },
    // A copy of the stub elsewhere runs in Linux and names the path it ran from.
    { subject: 2, tag: 0, fields: linuxReason(41), entry: "/tmp/copied-stub" },
    { subject: 2, tag: 0, fields: linuxReason(36) },
  )).placements).toEqual([
    { ordinal: 1n, pid: 42, parentPid: 20, entry: "/usr/local/bin/typst", tid: 42, addressSpaceId: 9n, subject: "module-command", runtime: null, profile: null, codeRoots: [], placement: "browser-module", generation: 7n, incarnationId: 8n, registration: 3 },
    { ordinal: 2n, pid: 42, parentPid: 20, entry: "/usr/local/bin/typst", tid: 42, addressSpaceId: 9n, subject: "module-command", runtime: null, profile: null, codeRoots: [], placement: "linux", reason: "module-command-concurrency", environment: null },
    { ordinal: 3n, pid: 42, parentPid: 20, entry: "/tmp/copied-stub", tid: 42, addressSpaceId: 9n, subject: "module-command", runtime: null, profile: null, codeRoots: [], placement: "linux", reason: "module-command-unregistered", environment: null },
    { ordinal: 4n, pid: 42, parentPid: 20, entry: "/usr/local/bin/typst", tid: 42, addressSpaceId: 9n, subject: "module-command", runtime: null, profile: null, codeRoots: [], placement: "linux", reason: "command-capacity", environment: null },
  ]);
  // The command context gate's reasons reach a module command too.
  for (const [code, reason] of [[1, "unsupported-security"], [4, "mount-namespace"], [10, "user-namespace"]] as const) {
    expect(decodeJSProcessTrace(trace17({ subject: 2, tag: 0, fields: linuxReason(code) })).placements[0]).toMatchObject({ subject: "module-command", reason });
  }
});

it("names the subject of node and bun placements in every readable trace version", () => {
  const node = trace17({ subject: 0, tag: 1, fields: writer => writer.u64(2n).u64(3n).u64(8n).u8(1), entry: "/workspace/main.cjs", profile: "node24-bun1-v1" });
  expect(decodeJSProcessTrace(node).placements[0]).toMatchObject({ subject: "node", runtime: "node", placement: "browser", basis: "no-addons", entry: "/workspace/main.cjs" });
  for (const [code, reason] of [[39, "image-code-unavailable"], [40, "image-code-untrusted"]] as const) {
    expect(decodeJSProcessTrace(trace17({ subject: 1, tag: 0, fields: linuxReason(code), entry: "/usr/lib/tool/main.js" })).placements[0]).toMatchObject({ subject: "bun", runtime: "bun", reason });
  }
  const sixteen = new Writer().raw(new TextEncoder().encode("OXJT")).u32(16).u64(0n).u32(0).u32(1).u32(0)
    .u64(1n).u32(10).u32(10).u64(9n).u8(1).u8(0).u32(11).u32(1).path("/workspace/main.cjs").path("").u8(0).u32(0).finish();
  expect(decodeJSProcessTrace(sixteen).placements[0]).toMatchObject({ subject: "bun", runtime: "bun", placement: "linux", reason: "unsupported-invocation" });
  const fifteen = new Writer().raw(new TextEncoder().encode("OXJT")).u32(15).u64(0n).u32(0).u32(1).u32(0)
    .u64(1n).u32(10).u32(10).u64(9n).u8(0).u8(0).u32(11).u32(1).path("/workspace/main.cjs").path("").u8(0).finish();
  expect(decodeJSProcessTrace(fifteen).placements[0]).toMatchObject({ subject: "node", runtime: "node" });
});

it("reads the signal-disposition service operation (65550) from trace 17 only", () => {
  const service = (version: number) => new Writer().raw(new TextEncoder().encode("OXJT")).u32(version).u64(0n).u32(1).u32(0).u32(0)
    .u64(1n).u64(2n).u64(3n).u64(4n).u32(10).u32(10).u32(65550).u32(1).u32(0).finish();
  expect(decodeJSProcessTrace(service(17)).events[0]).toMatchObject({ operation: { kind: "signal-disposition" }, transition: "completed" });
  expect(() => decodeJSProcessTrace(service(16))).toThrow("Invalid JS service operation");
  const beyond = service(17); new DataView(beyond.buffer).setUint32(28 + 40, 65551, true);
  expect(() => decodeJSProcessTrace(beyond)).toThrow("Invalid JS service operation");
});

it("refuses module command placements Rust cannot record and module reasons before trace 17", () => {
  const sixteen = (subject: number, reason: number) => new Writer().raw(new TextEncoder().encode("OXJT")).u32(16).u64(0n).u32(0).u32(1).u32(0)
    .u64(1n).u32(10).u32(10).u64(9n).u8(subject).u8(0).u32(reason).u32(1).path("/usr/local/bin/typst").path("").u8(0).u32(0).finish();
  expect(decodeJSProcessTrace(sixteen(0, 40)).placements[0]).toMatchObject({ reason: "image-code-untrusted" });
  for (const bytes of [sixteen(2, 41), sixteen(0, 41), sixteen(0, 42)]) expect(() => decodeJSProcessTrace(bytes)).toThrow();
  for (const bytes of [
    // Subject and tag must agree: module commands never take the native browser tag, node and bun never the module one.
    trace17({ subject: 2, tag: 1, fields: writer => writer.u64(2n).u64(3n).u64(8n).u8(1) }), trace17({ subject: 0, tag: 2, fields: browserModule() }),
    trace17({ subject: 3, tag: 0, fields: linuxReason(41) }), trace17({ subject: 2, tag: 3, fields: browserModule() }),
    // Reasons 41 and 42 belong to module commands, and a module command's Linux reasons are the context, capacity and module ones.
    trace17({ subject: 0, tag: 0, fields: linuxReason(41) }), trace17({ subject: 1, tag: 0, fields: linuxReason(42) }),
    trace17({ subject: 2, tag: 0, fields: linuxReason(11) }), trace17({ subject: 2, tag: 0, fields: linuxReason(14) }), trace17({ subject: 2, tag: 0, fields: linuxReason(43) }),
    trace17({ subject: 2, tag: 0, fields: linuxReason(12), environment: [4, "NODE_PATH"] }), trace17({ subject: 2, tag: 0, fields: linuxReason(41), profile: "node24-bun1-v1" }),
    trace17({ subject: 2, tag: 0, fields: linuxReason(41), entry: "" }),
    // A browser module placement names a registration, a live incarnation and the stub at a registered path.
    trace17({ subject: 2, tag: 2, fields: browserModule(0) }), trace17({ subject: 2, tag: 2, fields: browserModule(3, 0n) }), trace17({ subject: 2, tag: 2, fields: browserModule(3, 7n, 0n) }),
    // Each tag's fields well formed for the other subject: only the subject decides which layout a row has.
    trace17({ subject: 0, tag: 2, fields: writer => writer.u64(2n).u64(3n).u64(8n).u8(1), entry: "/workspace/main.cjs", profile: "node24-bun1-v1" }),
    trace17({ subject: 2, tag: 1, fields: browserModule() }),
    trace17({ subject: 2, tag: 2, fields: browserModule(), entry: "/usr/bin/typst" }), trace17({ subject: 2, tag: 2, fields: browserModule(), entry: "/usr/local/bin/Typst" }),
    trace17({ subject: 2, tag: 2, fields: browserModule(), entry: "/opt/local/bin/typst" }),
    trace17({ subject: 2, tag: 2, fields: browserModule(), entry: "/usr/local/bin/oxidevm-x" }), trace17({ subject: 2, tag: 2, fields: browserModule(), entry: "" }),
    trace17({ subject: 2, tag: 2, fields: browserModule(), profile: "node24-bun1-v1" }), trace17({ subject: 2, tag: 2, fields: browserModule(), environment: [1, "X"] }),
    trace17({ subject: 2, tag: 2, fields: browserModule() }).subarray(0, -1),
  ]) expect(() => decodeJSProcessTrace(bytes)).toThrow();
});

/** One OXJT 18 refusal row (engine `JsRefusalTraceEvent::encode`, 59 bytes). */
function refusal({ ordinal = 2n, declared = 1, attempted = 2, family = 2, port = 443, address = [93, 184, 216, 34], reason = 1 } = {}) {
  const writer = new Writer().u64(ordinal).u64(5n).u64(6n).u64(7n).u32(11).u8(reason).u8(declared).u8(attempted);
  const tail = new Uint8Array(20), view = new DataView(tail.buffer);
  view.setUint16(0, family, true); view.setUint16(2, port, true); tail.set(address, 4);
  return writer.raw(tail).finish();
}
function trace18(rows: readonly Uint8Array[], services = 0) {
  const writer = new Writer().raw(new TextEncoder().encode("OXJT")).u32(18).u64(0n).u32(services).u32(0).u32(0).u32(rows.length);
  if (services === 1) writer.u64(1n).u64(5n).u64(6n).u64(7n).u32(11).u32(11).u32(42).u32(1).u32(13);
  for (const row of rows) writer.raw(row);
  return writer.finish();
}

it("reads trace 18's module network reach refusals after the late failures, in the trace's one ordinal sequence (engine ADR 0029)", () => {
  expect(refusal().byteLength).toBe(59);
  const trace = decodeJSProcessTrace(trace18([refusal()], 1));
  expect(trace.events[0]).toMatchObject({ operation: { kind: "syscall", number: 42 }, errno: 13 });
  expect(trace.refusals).toEqual([{ ordinal: 2n, generation: 5n, incarnationId: 6n, requestId: 7n, pid: 11, reason: "module-network-reach", declared: "vm", attempted: "internet",
    destination: { family: "ipv4", address: "93.184.216.34", port: 443 } }]);
  const v6 = new Array<number>(16).fill(0); v6[0] = 0x20; v6[1] = 0x01; v6[15] = 1;
  expect(decodeJSProcessTrace(trace18([refusal({ declared: 0, attempted: 1, family: 10, port: 80, address: v6 })])).refusals[0])
    .toMatchObject({ declared: "none", attempted: "vm", destination: { family: "ipv6", address: "2001:0:0:0:0:0:0:1", port: 80 } });
  expect(decodeJSProcessTrace(trace18([refusal({ declared: 0, attempted: 1, family: 1, port: 0, address: [] })])).refusals[0])
    .toMatchObject({ declared: "none", attempted: "vm", destination: { family: "unix" } });
  // Earlier traces carry no refusal count and no refusals.
  expect(decodeJSProcessTrace(new Writer().raw(new TextEncoder().encode("OXJT")).u32(17).u64(0n).u32(0).u32(0).u32(0).finish()).refusals).toEqual([]);
});

it("refuses trace 18 refusals Rust cannot record", () => {
  for (const row of [
    refusal({ reason: 0 }), refusal({ reason: 2 }), refusal({ declared: 3 }), refusal({ attempted: 0 }), refusal({ attempted: 3 }),
    // A reach that admits the destination was not refused for it.
    refusal({ declared: 2, attempted: 2 }), refusal({ declared: 1, attempted: 1 }),
    refusal({ family: 3 }), refusal({ family: 1, port: 0, address: [1] }), refusal({ family: 1, port: 80, address: [] }), refusal({ ordinal: 0n }),
  ]) expect(() => decodeJSProcessTrace(trace18([row])), Array.from(row).join(",")).toThrow();
  // The refusal ordinal shares the trace's one sequence with the service rows.
  expect(() => decodeJSProcessTrace(trace18([refusal({ ordinal: 1n })], 1))).toThrow();
  expect(() => decodeJSProcessTrace(trace18([refusal(), refusal()]))).toThrow();
  expect(() => decodeJSProcessTrace(trace18([refusal()]).subarray(0, -1))).toThrow();
  expect(() => decodeJSProcessTrace(new Writer().raw(new TextEncoder().encode("OXJT")).u32(19).u64(0n).u32(0).u32(0).u32(0).u32(0).finish())).toThrow("version mismatch");
});
