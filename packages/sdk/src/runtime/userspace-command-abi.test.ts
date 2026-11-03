import { expect, it } from "vitest";
import { decodeJSIdentity, Writer } from "./js-process/codec.js";
import { VMError } from "./errors.js";
import { decodeCommandNotice, decodeUserspaceCommandRequest, decodeNativeProcessProgram, decodeNativeEvalSource, encodeCommandNoticeRequest, encodeCommandSignalExit, encodeNativeEvalSource, NATIVE_EVAL_MAX_UNITS } from "./userspace-command-abi.js";

it("preserves required capabilities and rejects absent, unknown and forged capability records", () => {
  const program = decodeUserspaceCommandRequest(launch()).program;
  if (program.kind !== "native-node") throw new Error("Expected native profile");
  const exact = { ...program, profile: { ...program.profile, identity: "native-parity-fixture-v1", requiredCapabilities: 1 } };
  for (const requiredCapabilities of [0, 1, 2, 3]) expect(decodeNativeProcessProgram({ ...exact, profile: { ...exact.profile, requiredCapabilities } }).profile).toMatchObject({ requiredCapabilities });
  for (const requiredCapabilities of [undefined, null, -1, 4, 0.5, "1", 1n]) expect(() => decodeNativeProcessProgram({ ...exact, profile: { ...exact.profile, requiredCapabilities } })).toThrow();
  expect(() => decodeNativeProcessProgram({ ...exact, profile: { ...exact.profile, identity: "node24-bun1-v1" } })).toThrow();
});

it("preserves every eval source code unit across decoder chunk boundaries", () => {
  const source = "x".repeat(4095) + String.fromCharCode(0xd800, 0, 0xdc00, 0xd83d, 0xde00) + "tail";
  expect(decodeNativeEvalSource(encodeNativeEvalSource(source))).toBe(source);
  expect(decodeNativeEvalSource(encodeNativeEvalSource(""))).toBe("");
});

it("rejects invalid and oversized eval source before encoding or evaluation", () => {
  expect(() => encodeNativeEvalSource(new URL("file:///workspace/source.js"))).toThrow(TypeError);
  expect(() => encodeNativeEvalSource("x".repeat(NATIVE_EVAL_MAX_UNITS + 1))).toThrow(RangeError);
  expect(() => decodeNativeEvalSource(Uint8Array.of(0))).toThrow(/source length/u);
  expect(() => decodeNativeEvalSource(new Uint8Array(NATIVE_EVAL_MAX_UNITS * 2 + 2))).toThrow(/source length/u);
});

it("binds captured eval source to a worker context and rejects forged origins", () => {
  const code = "/*\0" + String.fromCharCode(0xd800) + "*/require('node:fs');";
  const bytes = new Writer().raw(new TextEncoder().encode("OXCR")).u32(19).u64(7n).u64(19n)
    .u32(23).u8(0).path("/workspace").u8(2).u8(1).blob(encodeNativeEvalSource(code)).u32(3).u32(4)
    .u8(0).path("/usr/bin/node").path("af89883ff1f2dbe825aa7fd55004276e752da3c84391f2709692759bbb61a7ab").path("native-parity-fixture-v1").u32(1).u8(0).path("/workspace/node_modules").u8(1).u64(11n)
    .u32(0).strings([]).u32(0).u8(16).u8(1).u32(24).u64(17n).u32(5).u32(6).u32(7)
    .strings(["node", "[worker eval]"]).strings([]).finish();
  const program = decodeUserspaceCommandRequest(bytes).program;
  expect(program).toMatchObject({ kind: "native-node", entry: "[worker eval]", source: { kind: "eval", code }, context: { kind: "thread", tid: 24, parent: 17n } });
  if (program.kind !== "native-node") throw new Error("Expected native worker");
  for (const source of [{ kind: "file", code }, { kind: "script", code }, { kind: "eval", code: 1 }, { kind: "eval", code, extra: true }]) expect(() => decodeNativeProcessProgram({ ...program, source })).toThrow();
  expect(() => decodeNativeProcessProgram({ ...program, context: { kind: "main" } })).toThrow(/worker context/u);
  expect(() => decodeNativeProcessProgram({ ...program, entry: "/workspace/fake.cjs" })).toThrow();
  const stale = bytes.slice(); new DataView(stale.buffer).setUint32(4, 11, true);
  expect(() => decodeUserspaceCommandRequest(stale)).toThrow(/version mismatch/u);
  new DataView(stale.buffer).setUint32(4, 14, true);
  expect(() => decodeUserspaceCommandRequest(stale)).toThrow(/version mismatch/u);
  new DataView(stale.buffer).setUint32(4, 15, true);
  expect(() => decodeUserspaceCommandRequest(stale)).toThrow(/version mismatch/u);
});

it("binds generic native artifacts to hashes, canonical inode identity and dependency generation", () => {
  const path = "/workspace/node_modules/unrelated/addon.node", sha256 = "a".repeat(64);
  const bytes = new Writer().raw(new TextEncoder().encode("OXCR")).u32(19).u64(7n).u64(19n)
    .u32(23).u8(0).path("/workspace").u8(2).u8(0).path("/workspace/probe.cjs").u32(3).u32(4)
    .u8(0).path("/usr/bin/node").path("af89883ff1f2dbe825aa7fd55004276e752da3c84391f2709692759bbb61a7ab").path("native-parity-fixture-v1").u32(1).u8(0).path("/workspace/node_modules").u8(0).u64(11n)
    .u32(1).u8(0).path(path).path(sha256).u64(71n).strings([]).u32(0).u8(16).u8(0)
    .strings(["node", "probe.cjs"]).strings([]).finish();
  const program = decodeUserspaceCommandRequest(bytes).program;
  expect(program).toMatchObject({ profile: { identity: "native-parity-fixture-v1", dependencyGeneration: 11n, artifacts: [{ kind: "node-api", path, sha256, inode: 71n }] } });
  if (program.kind !== "native-node") throw new Error("Expected native process");
  for (const patch of [{ sha256: "modified" }, { inode: 0n }, { kind: "v8" }, { path: "/workspace/escaped.node" }, { extra: true }]) {
    expect(() => decodeNativeProcessProgram({ ...program, profile: { ...program.profile, artifacts: [{ kind: "node-api", path, sha256, inode: 71n, ...patch }] } })).toThrow();
  }
});

it("decodes only the pinned compiler service and rejects malformed compiler launches", () => {
  const compiler = (executable = "/workspace/esbuild", version = "0.25.12", args = [executable, "--service=0.25.12", "--ping"], protocol = 19) => new Writer()
    .raw(new TextEncoder().encode("OXCR")).u32(protocol).u64(7n).u64(19n).u32(23).u8(0).path("/workspace")
    .u8(3).path(executable).path(version).strings(args).strings(["PATH=/usr/bin:/bin"]).finish();
  expect(decodeUserspaceCommandRequest(compiler())).toMatchObject({ program: { kind: "esbuild", executable: "/workspace/esbuild", version: "0.25.12" }, args: ["/workspace/esbuild", "--service=0.25.12", "--ping"] });
  for (const bytes of [compiler("/workspace/esbuild", "0.25.11"), compiler("relative"), compiler("/workspace/../esbuild"),
    compiler("/workspace/esbuild", "0.25.12", ["esbuild", "--service=0.25.11"]), compiler("/workspace/esbuild", "0.25.12", ["esbuild", "--service=0.25.12", "--bundle"]),
    compiler("/workspace/esbuild", "0.25.12", ["esbuild", "--service=0.25.12"], 7), compiler().subarray(0, -1)]) {
    expect(() => decodeUserspaceCommandRequest(bytes)).toThrow();
  }
});

it("keeps shared-library identities separate from loadable addons and rejects stale launch peers", () => {
  const bytes = new Writer().raw(new TextEncoder().encode("OXCR")).u32(19).u64(7n).u64(19n)
    .u32(23).u8(0).path("/workspace").u8(2).u8(0).path("/workspace/probe.cjs").u32(3).u32(4)
    .u8(0).path("/usr/bin/node").path("af89883ff1f2dbe825aa7fd55004276e752da3c84391f2709692759bbb61a7ab").path("native-parity-fixture-v1").u32(1).u8(0).path("/workspace/node_modules").u8(0).u64(11n)
    .u32(1).u8(1).path("libuv.so.1").path("/usr/lib/libuv.so.1").path("a".repeat(64)).u64(71n)
    .strings([]).u32(0).u8(16).u8(0).strings(["node", "probe.cjs"]).strings([]).finish();
  const program = decodeUserspaceCommandRequest(bytes).program; if (program.kind !== "native-node") throw new Error("Missing native program");
  const library = program.profile.artifacts[0]; expect(library).toMatchObject({ kind: "shared-library", soname: "libuv.so.1", path: "/usr/lib/libuv.so.1", inode: 71n });
  const vendored = { ...library, path: "/workspace/node_modules/.pnpm/bundle/lib/libuv.so.1" };
  expect(decodeNativeProcessProgram({ ...program, profile: { ...program.profile, artifacts: [vendored] } }).profile.artifacts).toEqual([vendored]);
  for (const patch of [{ soname: "../libuv.so.1" }, { path: "/workspace/node_modules-other/libuv.so.1" }, { path: "/workspace/node_modules/../libuv.so.1" }, { path: "/workspace/node_modules/bundle/other.so" }, { kind: "node-api" }, { extra: true }]) expect(() => decodeNativeProcessProgram({ ...program, profile: { ...program.profile, artifacts: [{ ...library, ...patch }] } })).toThrow();
  expect(() => decodeNativeProcessProgram({ ...program, profile: { ...program.profile, artifacts: [library, library] } })).toThrow();
  expect(() => decodeNativeProcessProgram({ ...program, profile: { ...program.profile, identity: "node24-bun1-v1" } })).toThrow();
  const stale = bytes.slice(); new DataView(stale.buffer).setUint32(4, 10, true); expect(() => decodeUserspaceCommandRequest(stale)).toThrow(/version mismatch/u);
});

function launch({ version = 19, bridge = 16, fork = false, input = 3, output = 4, entry = "/workspace/scripts/custom.cjs", runtime = 1, executable = "/usr/local/bin/bun", profile = "node24-bun1-v1", generation = 11n, moduleSearchPaths = ["/workspace/node_modules/.pnpm/node_modules"], addon = "/workspace/node_modules/@next/swc-linux-x64-musl/next-swc.linux-x64-musl.node" } = {}, runtimeSHA256?: string) {
  const writer = new Writer().raw(new TextEncoder().encode("OXCR")).u32(version).u64(7n).u64(19n)
    .u32(23).u8(1).path("/workspace").u8(2).u8(0).path(entry).u32(input).u32(output)
    .u8(runtime).path(executable).path(runtimeSHA256 ?? (runtime === 0 ? "af89883ff1f2dbe825aa7fd55004276e752da3c84391f2709692759bbb61a7ab" : "500e6edbf321ddf490adcc55a6a01639993a07924616ab67492e1256c15557e2")).path(profile).u32(1).u8(0).path("/workspace/node_modules").u8(0).u64(generation).u32(1).u8(0).path(addon).path("a".repeat(64)).u64(71n).strings(moduleSearchPaths).u32(0).u8(bridge).u8(fork ? 2 : 0);
  if (fork) writer.u64(8n);
  return writer.strings(["node", "scripts/custom.cjs"]).strings(["PATH=/usr/bin:/bin"]).finish();
}
it("carries the host helper's bridge version from the acceleration profile (OXCR 19): 15 or 16, anything else refused", () => {
  for (const bridge of [15, 16]) expect(decodeUserspaceCommandRequest(launch({ bridge })).program).toMatchObject({ kind: "native-node", profile: { bridgeVersion: bridge } });
  for (const bridge of [0, 14, 17, 255]) expect(() => decodeUserspaceCommandRequest(launch({ bridge }))).toThrow(/bridge version/u);
  expect(() => decodeUserspaceCommandRequest(launch({ version: 18 }))).toThrow(/version mismatch/u);
  const program = decodeUserspaceCommandRequest(launch()).program;
  if (program.kind !== "native-node") throw new Error("Expected native profile");
  for (const bridgeVersion of [undefined, 14, 17, "16", 16n]) expect(() => decodeNativeProcessProgram({ ...program, profile: { ...program.profile, bridgeVersion } })).toThrow();
});
it("retains Rust-admitted fork parent identity separately from a thread environment", () => {
  expect(decodeUserspaceCommandRequest(launch({ fork: true })).program).toMatchObject({ context: { kind: "fork", parent: 8n } });
});
it("preserves the authenticated runtime digest and rejects missing, malformed and stale identities", () => {
  const program = decodeUserspaceCommandRequest(launch()).program;
  if (program.kind !== "native-node") throw new Error("Expected native profile");
  expect(program.profile.runtimeSHA256).toBe("500e6edbf321ddf490adcc55a6a01639993a07924616ab67492e1256c15557e2");
  for (const runtimeSHA256 of [undefined, "", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), 3]) {
    expect(() => decodeNativeProcessProgram({ ...program, profile: { ...program.profile, runtimeSHA256 } })).toThrow();
  }
  expect(() => decodeUserspaceCommandRequest(launch({}, "changed"))).toThrow();
  expect(() => decodeUserspaceCommandRequest(launch({ version: 12 }))).toThrow(/version mismatch/u);
});
it("validates ordered module search paths at binary and worker bootstrap boundaries", () => {
  const moduleSearchPaths = ["/workspace/node_modules/missing", "/workspace/node_modules", "/workspace/node_modules/extra"];
  const program = decodeUserspaceCommandRequest(launch({ moduleSearchPaths })).program;
  expect(program).toMatchObject({ profile: { moduleSearchPaths } });
  if (program.kind !== "native-node") throw new Error("Expected native profile");
  for (const paths of [
    ["relative"], ["/workspace/escape"], ["/workspace/node_modules/../node_modules"],
    ["/workspace/node_modules//extra"], ["/workspace/node_modules/\0secret"],
    ["/workspace/node_modules/" + "é".repeat(2040)], Array.from({ length: 4097 }, () => "/workspace/node_modules"),
  ]) {
    expect(() => decodeUserspaceCommandRequest(launch({ moduleSearchPaths: paths }))).toThrow();
    expect(() => decodeNativeProcessProgram({ ...program, profile: { ...program.profile, moduleSearchPaths: paths } })).toThrow();
  }
  for (const paths of [undefined, {}, [1]]) {
    expect(() => decodeNativeProcessProgram({ ...program, profile: { ...program.profile, moduleSearchPaths: paths } })).toThrow();
  }
});
it("preserves editable module placement, runtime identity, generation and private descriptors", () => {
  expect(decodeUserspaceCommandRequest(launch())).toMatchObject({ generation: 7n, id: 19n, pid: 23, tty: true,
    cwd: "/workspace", args: ["node", "scripts/custom.cjs"], program: { kind: "native-node", entry: "/workspace/scripts/custom.cjs", input: 3, output: 4,
      profile: { runtime: "bun", executable: "/usr/local/bin/bun", identity: "node24-bun1-v1", roots: [{ kind: "dependencies", path: "/workspace/node_modules" }], basis: "qualified", dependencyGeneration: 11n } } });
  for (const bytes of [launch({ version: 7 }), launch({ version: 8 }), launch({ input: 1 }), launch({ output: 3 }), launch({ entry: "/other.cjs" }), launch({ entry: "/workspace/../other.cjs" }), launch({ runtime: 9 }), launch({ executable: "/usr/bin/node" }), launch({ profile: "unqualified" }), launch({ generation: 0n }), launch({ addon: "/workspace/other.node" }), launch().subarray(0, -1)]) {
    expect(() => decodeUserspaceCommandRequest(bytes)).toThrow();
  }
});

type Root = readonly [kind: number, path: string];
function rootsLaunch(roots: readonly Root[], { basis = 1, artifacts = [] as readonly string[], moduleSearchPaths = [] as readonly string[], entry = "/workspace/app/main.cjs" } = {}) {
  const writer = new Writer().raw(new TextEncoder().encode("OXCR")).u32(19).u64(7n).u64(19n)
    .u32(23).u8(0).path("/workspace/app").u8(2).u8(0).path(entry).u32(3).u32(4)
    .u8(0).path("/usr/bin/node").path("af89883ff1f2dbe825aa7fd55004276e752da3c84391f2709692759bbb61a7ab").path("node24-bun1-v1").u32(roots.length);
  for (const [kind, path] of roots) writer.u8(kind).path(path);
  writer.u8(basis).u64(11n).u32(artifacts.length);
  for (const path of artifacts) writer.u8(0).path(path).path("a".repeat(64)).u64(71n);
  return writer.strings(moduleSearchPaths).u32(0).u8(16).u8(0).strings(["node", "main.cjs"]).strings([]).finish();
}

it("decodes Rust's ordered dependency and store roots with the admission basis", () => {
  const store = "/home/user/.local/share/pnpm/store/v10/links/dep/1.0.0/abc/node_modules";
  const program = decodeUserspaceCommandRequest(rootsLaunch([[0, "/workspace/app/node_modules"], [0, "/workspace/node_modules"], [1, store]], {
    basis: 0, artifacts: [`${store}/dep/dep.node`], moduleSearchPaths: ["/workspace/node_modules/.pnpm/node_modules"],
  })).program;
  expect(program).toMatchObject({ kind: "native-node", profile: {
    roots: [{ kind: "dependencies", path: "/workspace/app/node_modules" }, { kind: "dependencies", path: "/workspace/node_modules" }, { kind: "store", path: store }],
    basis: "qualified", artifacts: [{ kind: "node-api", path: `${store}/dep/dep.node` }],
  } });
  expect(decodeUserspaceCommandRequest(rootsLaunch([])).program).toMatchObject({ profile: { roots: [], basis: "no-addons", artifacts: [] } });
});

it("rejects roots, add-ons and search paths Rust cannot have admitted", () => {
  const many = Array.from({ length: 65 }, (_, index): Root => [0, `/workspace/p${String(index)}/node_modules`]);
  for (const bytes of [
    rootsLaunch([[2, "/workspace/app/node_modules"]]), rootsLaunch([[0, "/workspace/app/node_modules"]], { basis: 2 }), rootsLaunch(many),
    rootsLaunch([[0, "/workspace/app/node_modules"], [0, "/workspace/app/node_modules"]]),
    rootsLaunch([[0, "/workspace/app/node_modules"], [0, "/workspace/app/node_modules/x/node_modules"]]),
    rootsLaunch([[0, "/workspace/app/modules"]]), rootsLaunch([[0, "/home/user/node_modules"]]), rootsLaunch([[1, "/workspace/app/node_modules"]]),
    rootsLaunch([[1, "/srv/store/node_modules"]]), rootsLaunch([[0, "/workspace/app/../node_modules"]]),
    rootsLaunch([[0, "/workspace/app/node_modules"]], { basis: 0, artifacts: ["/workspace/other/node_modules/x.node"] }),
    rootsLaunch([[0, "/workspace/app/node_modules"]], { basis: 1, artifacts: ["/workspace/app/node_modules/x/x.node"] }),
    rootsLaunch([[0, "/workspace/app/node_modules"]], { basis: 0 }),
    rootsLaunch([[0, "/workspace/app/node_modules"]], { moduleSearchPaths: ["/workspace/other/node_modules"] }),
  ]) expect(() => decodeUserspaceCommandRequest(bytes)).toThrow();
  const program = decodeUserspaceCommandRequest(rootsLaunch([[0, "/workspace/app/node_modules"]])).program;
  if (program.kind !== "native-node") throw new Error("Expected native profile");
  for (const roots of [undefined, [{ kind: "dependencies" }], [{ kind: "dependencies", path: "/workspace/app/node_modules", extra: true }]]) {
    expect(() => decodeNativeProcessProgram({ ...program, profile: { ...program.profile, roots } })).toThrow();
  }
  expect(() => decodeNativeProcessProgram({ ...program, profile: { ...program.profile, basis: "verified" } })).toThrow();
});

/** An OXCR 19 module command launch (ADR 0027): tag 4 with the registration, name, stub path and terminal bits, then the full argv. */
function moduleLaunch({ version = 19, registration = 3, name = "typst", path = `/usr/local/bin/${name}`, terminals = 0b011, tty = 1, args = ["typst", "compile", "a.typ"] }: { readonly version?: number; readonly registration?: number; readonly name?: string; readonly path?: string; readonly terminals?: number; readonly tty?: number; readonly args?: readonly string[] } = {}) {
  return new Writer().raw(new TextEncoder().encode("OXCR")).u32(version).u64(7n).u64(19n).u32(23).u8(tty).path("/workspace/doc")
    .u8(4).u32(registration).blob(new TextEncoder().encode(name)).blob(new TextEncoder().encode(path)).u8(terminals)
    .strings(args).strings(["PATH=/usr/local/bin:/usr/bin:/bin"]).finish();
}

it("decodes a module command launch (OXCR 19 tag 4) with its registration, stub path, terminals and the caller's whole argv", () => {
  expect(decodeUserspaceCommandRequest(moduleLaunch())).toEqual({
    kind: "command", generation: 7n, id: 19n, pid: 23, tty: true, cwd: "/workspace/doc",
    program: { kind: "module-command", registration: 3, name: "typst", path: "/usr/local/bin/typst", terminals: { stdin: true, stdout: true, stderr: false } },
    args: ["typst", "compile", "a.typ"], environment: ["PATH=/usr/local/bin:/usr/bin:/bin"],
  });
  // Each descriptor's bit stands alone, argv[0] is whatever the caller passed, and an exec with no arguments stays empty.
  expect(decodeUserspaceCommandRequest(moduleLaunch({ terminals: 0b101, tty: 0, args: ["./py", "-c", "pass"] }))).toMatchObject({ tty: false, program: { terminals: { stdin: true, stdout: false, stderr: true } }, args: ["./py", "-c", "pass"] });
  expect(decodeUserspaceCommandRequest(moduleLaunch({ terminals: 0, tty: 0, args: [] }))).toMatchObject({ program: { terminals: { stdin: false, stdout: false, stderr: false } }, args: [] });
  const longest = "a".repeat(64);
  expect(decodeUserspaceCommandRequest(moduleLaunch({ name: longest, registration: 0xffff_ffff })).program).toMatchObject({ name: longest, path: `/usr/local/bin/${longest}`, registration: 0xffff_ffff });
});

it("refuses OXCR 18 and module command launches Rust cannot have admitted", () => {
  expect(() => decodeUserspaceCommandRequest(moduleLaunch({ version: 18 }))).toThrow(/version mismatch/u);
  expect(() => decodeUserspaceCommandRequest(launch({ version: 17 }))).toThrow(/version mismatch/u);
  for (const bytes of [
    moduleLaunch({ registration: 0 }),
    ...["Typst", "oxidevm-tool", "", "a".repeat(65), "a/b", "-x", ".x", "x y", "é"].map(name => moduleLaunch({ name })),
    moduleLaunch({ path: "/usr/local/bin/other" }), moduleLaunch({ path: "/usr/bin/typst" }), moduleLaunch({ path: "/usr/local/bin/typst/" }), moduleLaunch({ path: "/usr/local/bin//typst" }),
    moduleLaunch({ terminals: 0b1011 }), moduleLaunch({ terminals: 0xff }),
    // The process's terminal flag is descriptor 1's terminal bit, read from the same descriptor table.
    moduleLaunch({ tty: 0 }), moduleLaunch({ tty: 1, terminals: 0b001 }),
    moduleLaunch().subarray(0, -1),
  ]) expect(() => decodeUserspaceCommandRequest(bytes)).toThrow();
  const trailing = new Uint8Array(moduleLaunch().byteLength + 1); trailing.set(moduleLaunch());
  expect(() => decodeUserspaceCommandRequest(trailing)).toThrow(/Unexpected/u);
});

const NOTICE_HEADER = [1, 0, 0, 0, 6, ...new Array<number>(16).fill(0)];
/** OXCS 2 (50 bytes): the OXCS 1 fields, then i32 si_code, u32 si_pid, u32 si_uid and u64 si_value. */
function notice({ magic = "OXCS", version = 2, generation = 7n, id = 19n, pid = 23, signal = 2, flags = 0b11, code = 0, sender = 41, uid = 1000, value = 0n } = {}) {
  const tail = new Uint8Array(4); new DataView(tail.buffer).setInt32(0, code, true);
  return new Writer().raw(new TextEncoder().encode(magic)).u32(version).u64(generation).u64(id).u32(pid).u8(signal).u8(flags).raw(tail).u32(sender).u32(uid).u64(value).finish();
}
/** OXCS 1, which the engine no longer writes: 30 bytes without the siginfo fields. */
function noticeVersion1() {
  return new Writer().raw(new TextEncoder().encode("OXCS")).u32(1).u64(7n).u64(19n).u32(23).u8(2).u8(0b11).finish();
}

it("asks Rust for the next caught-signal notice (command operation 6) and decodes OXCS 2 or no notice", () => {
  expect(Array.from(encodeCommandNoticeRequest())).toEqual(NOTICE_HEADER);
  expect(notice().byteLength).toBe(50);
  expect(decodeCommandNotice(notice())).toEqual({ generation: 7n, id: 19n, pid: 23, signal: 2, restart: true, interrupt: true, code: 0, sender: 41, uid: 1000, value: 0n });
  expect(decodeCommandNotice(notice({ code: -1, sender: 9, uid: 0, value: 0xffff_ffff_ffff_ffffn }))).toMatchObject({ code: -1, sender: 9, uid: 0, value: 0xffff_ffff_ffff_ffffn });
  expect(decodeCommandNotice(notice({ flags: 0 }))).toMatchObject({ restart: false, interrupt: false });
  expect(decodeCommandNotice(notice({ flags: 0b10 }))).toMatchObject({ restart: false, interrupt: true });
  for (const signal of [1, 2, 3, 10, 12, 15]) expect(decodeCommandNotice(notice({ signal, flags: 1 }))).toMatchObject({ signal, restart: true, interrupt: false });
  expect(decodeCommandNotice(new Uint8Array())).toBeNull();
});

it("refuses OXCS 1 with the typed version error, and a malformed, untrappable or stale caught-signal notice", () => {
  let refusal: unknown;
  try { decodeCommandNotice(noticeVersion1()); } catch (error: unknown) { refusal = error; }
  expect(refusal).toBeInstanceOf(VMError);
  expect(refusal).toMatchObject({ code: "PROTOCOL_ERROR", message: "Signal notice version mismatch" });
  for (const bytes of [
    notice({ magic: "OXCR" }), notice({ version: 0 }), notice({ version: 1 }), notice({ version: 3 }), notice({ generation: 0n }), notice({ id: 0n }), notice({ pid: 0 }),
    ...[0, 4, 9, 11, 13, 14, 17, 19, 32, 33, 34, 65, 255].map(signal => notice({ signal })), notice({ flags: 0b100 }), notice({ flags: 0xff }),
    notice().subarray(0, 49), new Uint8Array(1),
  ]) expect(() => decodeCommandNotice(bytes)).toThrow();
  const trailing = new Uint8Array(51); trailing.set(notice());
  expect(() => decodeCommandNotice(trailing)).toThrow();
});

it("ends a JS process killed by a trappable signal (command operation 7) with an exact request", () => {
  const identity = decodeJSIdentity(7n, 19n);
  expect(Array.from(encodeCommandSignalExit(identity, 2))).toEqual([1, 0, 0, 0, 7, 7, 0, 0, 0, 0, 0, 0, 0, 19, 0, 0, 0, 0, 0, 0, 0, 2]);
  for (const signal of [1, 3, 10, 12, 15, 35, 64]) expect(encodeCommandSignalExit(identity, signal).at(-1)).toBe(signal);
  for (const signal of [0, 9, 19, 32, 34, 65, 1.5]) expect(() => encodeCommandSignalExit(identity, signal)).toThrow();
});
