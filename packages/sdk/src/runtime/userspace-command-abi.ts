import { exactKeys, integer, record, string } from "./decode.ts";
import { TYPESCRIPT } from "./command-interceptor-identity.ts";
import { ESBUILD } from "./esbuild-identity.ts";
import { Reader, Writer, protocol, decodeJSIdentity, type JSProcessIdentity } from "./js-process/codec.ts";

export const NATIVE_EVAL_MAX_UNITS = 256 * 1024;
export const NATIVE_EVAL_ENTRY = "[worker eval]";
export type NativeProcessSource = { readonly kind: "file" } | { readonly kind: "eval"; readonly code: string };

/** Eval source is a JavaScript string, whose unpaired UTF-16 units must survive transport. */
export function encodeNativeEvalSource(value: unknown): Uint8Array {
  if (typeof value !== "string") throw Object.assign(new TypeError("options.eval requires a string worker source"), { code: "ERR_INVALID_ARG_VALUE" });
  if (value.length > NATIVE_EVAL_MAX_UNITS) throw new RangeError("Worker eval source exceeds its code-unit limit");
  const bytes = new Uint8Array(value.length * 2), view = new DataView(bytes.buffer);
  for (let index = 0; index < value.length; index++) view.setUint16(index * 2, value.charCodeAt(index), true);
  return bytes;
}

export function decodeNativeEvalSource(bytes: Uint8Array): string {
  if (bytes.length % 2 !== 0 || bytes.length > NATIVE_EVAL_MAX_UNITS * 2) protocol("Invalid worker eval source length");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let source = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    const length = Math.min(8192, bytes.length - offset) / 2;
    source += String.fromCharCode(...Array.from({ length }, (_, index) => view.getUint16(offset + index * 2, true)));
  }
  return source;
}

function decodeNativeSource(input: unknown): NativeProcessSource {
  const source = record(input, "native program source");
  if (source["kind"] === "file") { exactKeys(source, ["kind"]); return { kind: "file" }; }
  if (source["kind"] !== "eval") protocol("Unknown native program source");
  exactKeys(source, ["kind", "code"]);
  const code = string(source["code"], "native eval source");
  if (code.length > NATIVE_EVAL_MAX_UNITS) protocol("Native eval source exceeds its code-unit limit");
  return { kind: "eval", code };
}

/** A frozen dependency root Rust captured: project `node_modules` or package store entries. */
export type NativeProcessRoot = { readonly kind: "dependencies" | "store"; readonly path: string }
  | { readonly kind: "image"; readonly path: string; readonly sha256: string };
export interface NativeProcessProfile {
  readonly runtime: "node" | "bun";
  readonly executable: "/usr/bin/node" | "/usr/local/bin/bun";
  readonly runtimeSHA256: string;
  readonly identity: "node24-bun1-v1" | "native-parity-fixture-v1";
  /** In Node's lookup order from the entry, then the working directory and links (ADR 0026). */
  readonly roots: readonly NativeProcessRoot[];
  /** Why Rust vouched for the launch: qualified add-ons, or no add-on in any root. */
  readonly basis: "qualified" | "no-addons";
  readonly dependencyGeneration: bigint;
  readonly artifacts: readonly ({ readonly path: string; readonly sha256: string; readonly inode: bigint } & ({ readonly kind: "node-api" } | { readonly kind: "shared-library"; readonly soname: string }))[];
  readonly moduleSearchPaths: readonly string[];
  readonly requiredCapabilities: 0 | 1 | 2 | 3;
}
export interface NativeThreadIdentity { readonly tid: number; readonly parent: bigint; readonly stdio: readonly [number, number, number] }
export type NativeProcessContext = { readonly kind: "main" } | ({ readonly kind: "thread" } & NativeThreadIdentity) | { readonly kind: "fork"; readonly parent: bigint };

function canonicalPath(value: string): boolean {
  return value.startsWith("/") && value.split("/").slice(1).every(part => part !== "" && part !== "." && part !== ".." && !Array.from(part).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127));
}
function workspacePath(value: string): boolean { return value.startsWith("/workspace/") && canonicalPath(value); }
export const NATIVE_MAX_ROOTS = 64;
export const NATIVE_MAX_ARTIFACTS = 256;
/** Whether `path` lies in one of the roots Rust froze for this launch. */
export function insideRoot(path: string, roots: readonly NativeProcessRoot[]): boolean {
  return roots.some(root => path === root.path || path.startsWith(root.path + "/"));
}
export function decodeNativeRoots(input: unknown): readonly NativeProcessRoot[] {
  if (!Array.isArray(input) || input.length > NATIVE_MAX_ROOTS) protocol("Invalid native dependency roots");
  const roots = input.map((value: unknown): NativeProcessRoot => {
    const root = record(value, "native dependency root"); exactKeys(root, ["kind", "path", ...(root["kind"] === "image" ? ["sha256"] : [])]);
    const kind = root["kind"], path = string(root["path"], "native dependency root path"), parts = path.split("/");
    if (kind === "image") {
      const sha256 = string(root["sha256"], "image code identity");
      if (!canonicalPath(path) || path === "/" || path === "/workspace" || path.startsWith("/workspace/") || new TextEncoder().encode(path).byteLength >= 4096 || !/^[a-f0-9]{64}$/u.test(sha256)) protocol("Invalid image code root");
      return { kind, path, sha256 };
    }
    if (kind !== "dependencies" && kind !== "store" || !canonicalPath(path) || new TextEncoder().encode(path).byteLength >= 4096
      || parts.indexOf("node_modules") !== parts.length - 1 || !path.startsWith(kind === "dependencies" ? "/workspace/" : "/home/")) protocol("Invalid native dependency root");
    return { kind, path };
  });
  if (roots.some((root, index) => roots.some((other, otherIndex) => index !== otherIndex && (root.path === other.path || root.path.startsWith(other.path + "/"))))) protocol("Overlapping native dependency roots");
  return roots;
}

export function readNativeRoots(r: Reader): readonly NativeProcessRoot[] {
  const roots = Array.from({ length: integer(r.u32(), "native root count", 0, NATIVE_MAX_ROOTS) }, () => {
    const kind = r.u8(); if (kind > 2) protocol("Unknown native root kind");
    const path = r.text(4095);
    if (kind === 2) return { kind: "image", path, sha256: Array.from(r.raw(32), byte => byte.toString(16).padStart(2, "0")).join("") };
    return { kind: kind === 0 ? "dependencies" : "store", path };
  });
  return decodeNativeRoots(roots);
}

export interface UserspaceCommandHostRequest extends JSProcessIdentity {
  readonly kind: "command";
  readonly pid: number;
  readonly tty: boolean; readonly cwd: string;
  readonly args: readonly string[]; readonly environment: readonly string[];
  readonly program: { readonly kind: "typescript"; readonly entry: string; readonly executable: "/usr/bin/node" | "/usr/local/bin/bun" } | { readonly kind: "worker"; readonly token: bigint } | { readonly kind: "esbuild"; readonly executable: string; readonly version: "0.25.12" } | { readonly kind: "native-node"; readonly entry: string; readonly source: NativeProcessSource; readonly input: number; readonly output: number; readonly profile: NativeProcessProfile; readonly context: NativeProcessContext };
}
export function decodeUserspaceCommandRequest(bytes: Uint8Array): UserspaceCommandHostRequest {
  if (bytes.byteLength > 2 * 1024 * 1024 + NATIVE_EVAL_MAX_UNITS * 2 + 16384) protocol("JS launch record exceeds its limit");
  const r = new Reader(bytes);
  if (new TextDecoder().decode(r.raw(4)) !== "OXCR" || r.u32() !== 17) protocol("JS launch record version mismatch");
  const { generation, id } = decodeJSIdentity(r.u64(), r.u64());
  const pid = r.u32(), tty = r.u8(), cwd = r.text(4095), tag = r.u8();
  let program: UserspaceCommandHostRequest["program"];
  if (tag === 0) {
    const entry = r.text(4095), executable = r.text(4095);
    if (!TYPESCRIPT.entries.some(allowed => allowed === entry) || (executable !== "/usr/bin/node" && executable !== "/usr/local/bin/bun")) protocol("Unqualified TypeScript process");
    program = { kind: "typescript", entry, executable };
  } else if (tag === 1) {
    const token = r.u64(); if (token === 0n || token > 0xffff_ffffn) protocol("Invalid JS worker token"); program = { kind: "worker", token };
  } else if (tag === 2) {
    const sourceTag = r.u8(); if (sourceTag > 1) protocol("Unknown native entry kind");
    const entry = sourceTag === 0 ? r.text(4095) : NATIVE_EVAL_ENTRY;
    const source = sourceTag === 0 ? { kind: "file" } : { kind: "eval", code: decodeNativeEvalSource(r.blob(NATIVE_EVAL_MAX_UNITS * 2)) };
    const input = r.u32(), output = r.u32();
    const runtime = r.u8(), executable = r.text(4095), runtimeSHA256 = r.text(64), identity = r.text(255);
    const roots = readNativeRoots(r);
    const basisCode = r.u8(); if (basisCode > 1) protocol("Unknown native admission basis");
    const basis = basisCode === 0 ? "qualified" : "no-addons", dependencyGeneration = r.u64();
    const count = integer(r.u32(), "native artifact count", 0, NATIVE_MAX_ARTIFACTS);
    const artifacts = Array.from({ length: count }, () => {
      const tag = r.u8(); if (tag > 1) protocol("Unsupported native artifact kind");
      const kind = tag === 0 ? { kind: "node-api" } : { kind: "shared-library", soname: r.text(255) };
      return { ...kind, path: r.text(4095), sha256: r.text(64), inode: r.u64() };
    });
    const moduleSearchPaths = r.strings();
    const requiredCapabilities = r.u32();
    if (runtime > 1) protocol("Unqualified native runtime");
    const tag = r.u8();
    if (tag > 2) protocol("Invalid native environment tag");
    const context = tag === 0 ? { kind: "main" } : tag === 2 ? { kind: "fork", parent: r.u64() } : { kind: "thread", tid: r.u32(), parent: r.u64(), stdio: [r.u32(), r.u32(), r.u32()] };
    program = decodeNativeProcessProgram({ kind: "native-node", entry, source, input, output, profile: { runtime: runtime === 0 ? "node" : "bun", executable, runtimeSHA256, identity, roots, basis, dependencyGeneration, artifacts, moduleSearchPaths, requiredCapabilities }, context });
  } else if (tag === 3) {
    const executable = r.text(4095), version = r.text(64);
    if (!executable.startsWith("/") || executable.includes("\0") || executable.split("/").slice(1).some(part => part === "" || part === "." || part === "..")
      || Array.from(executable).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || version !== ESBUILD.version) protocol("Unqualified esbuild compiler");
    program = { kind: "esbuild", executable, version };
  } else protocol("Unknown JS process program");
  const args = r.strings(), environment = r.strings(); r.end();
  if (program.kind === "esbuild" && (args[1] !== `--service=${ESBUILD.version}` || args.length !== 2 && (args.length !== 3 || args[2] !== "--ping"))) protocol("Invalid esbuild service invocation");
  if (generation === 0n || id === 0n || pid === 0 || tty > 1 || !cwd.startsWith("/") || cwd.includes("\0") || [...args, ...environment].some(value => value.includes("\0"))) protocol("Invalid JS launch identity or metadata");
  return { kind: "command", generation, id, pid, tty: tty === 1, cwd, program, args, environment };
}
export function encodeCommandIo(request: { readonly generation: bigint; readonly id: bigint }, operation: 0 | 4): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(21), view = new DataView(bytes.buffer);
  view.setUint32(0, 1, true); bytes[4] = operation; view.setBigUint64(5, request.generation, true); view.setBigUint64(13, request.id, true); return bytes;
}
export function encodeCommandExit(request: { readonly generation: bigint; readonly id: bigint }, code: number): Uint8Array<ArrayBuffer> {
  return new Writer().raw(new TextEncoder().encode("OXCC")).u32(1).u64(request.generation).u64(request.id).u8(code).finish();
}


export function decodeNativeProcessProgram(input: unknown): Extract<UserspaceCommandHostRequest["program"], { kind: "native-node" }> {
  const program = record(input, "native process program"); exactKeys(program, ["kind", "entry", "source", "input", "output", "profile", "context"]);
  const entry = string(program["entry"], "native process entry"), fdInput = integer(program["input"], "native input", 3, 0x7fff_ffff), output = integer(program["output"], "native output", 3, 0x7fff_ffff);
  const source = decodeNativeSource(program["source"]);
  const p = record(program["profile"], "native compatibility profile"); exactKeys(p, ["runtime", "executable", "runtimeSHA256", "identity", "roots", "basis", "dependencyGeneration", "artifacts", "moduleSearchPaths", "requiredCapabilities"]);
  const requiredCapabilities = p["requiredCapabilities"];
  if (requiredCapabilities !== 0 && requiredCapabilities !== 1 && requiredCapabilities !== 2 && requiredCapabilities !== 3 || requiredCapabilities !== 0 && p["identity"] !== "native-parity-fixture-v1") protocol("Invalid native capability requirements");
  const runtimeSHA256 = string(p["runtimeSHA256"], "native runtime digest");
  if (!/^[a-f0-9]{64}$/u.test(runtimeSHA256)) protocol("Invalid native runtime digest");
  const runtime = p["runtime"], executable = p["executable"], identity = p["identity"], roots = decodeNativeRoots(p["roots"]), basis = p["basis"], dependencyGeneration = p["dependencyGeneration"], values = p["artifacts"];
  if (!Array.isArray(values) || values.length > NATIVE_MAX_ARTIFACTS) protocol("Invalid native artifact list");
  const artifacts = values.map((value: unknown): NativeProcessProfile["artifacts"][number] => {
    const artifact = record(value, "native artifact"), kind = artifact["kind"]; exactKeys(artifact, ["kind", "path", "sha256", "inode", ...(kind === "shared-library" ? ["soname"] : [])]);
    const path = string(artifact["path"], "native artifact path"), sha256 = string(artifact["sha256"], "native artifact digest"), inode = artifact["inode"];
    if (!/^[a-f0-9]{64}$/u.test(sha256) || typeof inode !== "bigint" || inode <= 0n || inode >= 1n << 64n || !canonicalPath(path) || new TextEncoder().encode(path).byteLength >= 4096) protocol("Invalid native artifact identity");
    if (kind === "node-api") {
      if (!insideRoot(path, roots) || !path.endsWith(".node")) protocol("Invalid native addon path");
      return { kind, path, sha256, inode };
    }
    const soname = string(artifact["soname"], "native library SONAME");
    if (kind !== "shared-library" || identity !== "native-parity-fixture-v1" || soname === "" || soname === "." || soname === ".." || soname.includes("/") || new TextEncoder().encode(soname).byteLength > 255 || Array.from(soname).some(character => character.charCodeAt(0) < 33 || character.charCodeAt(0) === 127)
      || !["/lib/", "/usr/lib/", "/usr/local/lib/"].some(directory => path === directory + soname) && !(soname === "libc.musl-x86_64.so.1" && path === "/lib/ld-musl-x86_64.so.1")
        && !(insideRoot(path, roots) && path.endsWith("/" + soname))) protocol("Invalid native library identity");
    return { kind, path, sha256, inode, soname };
  });
  const libraries = artifacts.filter(artifact => artifact.kind === "shared-library"), addons = artifacts.filter(artifact => artifact.kind === "node-api");
  if (libraries.length > 32 || new Set(libraries.map(library => library.soname)).size !== libraries.length || addons.length + libraries.length !== artifacts.length) protocol("Duplicate or excessive native artifacts");
  if (basis !== "qualified" && basis !== "no-addons" || (basis === "qualified") !== (artifacts.length > 0)) protocol("Invalid native admission basis");
  const search = p["moduleSearchPaths"];
  if (!Array.isArray(search) || search.length > 4096) protocol("Invalid native module search paths");
  const moduleSearchPaths = search.map(value => string(value, "native module search path"));
  if (program["kind"] !== "native-node" || (source.kind === "file" ? !(workspacePath(entry) || canonicalPath(entry) && insideRoot(entry, roots.filter(root => root.kind === "image"))) || entry.length >= 4096 : entry !== NATIVE_EVAL_ENTRY) || fdInput === output
    || runtime !== "node" && runtime !== "bun" || executable !== "/usr/bin/node" && executable !== "/usr/local/bin/bun" || executable !== (runtime === "node" ? "/usr/bin/node" : "/usr/local/bin/bun") || identity !== "node24-bun1-v1" && identity !== "native-parity-fixture-v1"
    || typeof dependencyGeneration !== "bigint" || dependencyGeneration <= 0n || dependencyGeneration >= 1n << 62n
    || moduleSearchPaths.some(path => !canonicalPath(path) || new TextEncoder().encode(path).byteLength >= 4096 || !insideRoot(path, roots))
    || new Set(artifacts.map(artifact => artifact.path)).size !== artifacts.length) protocol("Unqualified native JavaScript process");
  const t = record(program["context"], "native environment context");
  let context: NativeProcessContext;
  if (t["kind"] === "main") { exactKeys(t, ["kind"]); context = { kind: "main" }; }
  else if (t["kind"] === "fork") {
    exactKeys(t, ["kind", "parent"]); const parent = t["parent"];
    if (typeof parent !== "bigint" || parent <= 0n || parent >= 1n << 64n) protocol("Invalid native fork parent");
    context = { kind: "fork", parent };
  } else if (t["kind"] === "thread") {
    exactKeys(t, ["kind", "tid", "parent", "stdio"]);
    const tid = integer(t["tid"], "native TID", 1, 0x7fff_ffff), parent = t["parent"], stdio = t["stdio"];
    if (typeof parent !== "bigint" || parent <= 0n || parent >= 1n << 64n || !Array.isArray(stdio) || stdio.length !== 3) protocol("Invalid native thread context");
    const one = integer(stdio[0], "native stdin", 3, 0x7fff_ffff), two = integer(stdio[1], "native stdout", 3, 0x7fff_ffff), three = integer(stdio[2], "native stderr", 3, 0x7fff_ffff);
    if (new Set([fdInput, output, one, two, three]).size !== 5) protocol("Aliased native thread descriptors");
    context = { kind: "thread", tid, parent, stdio: [one, two, three] };
  } else protocol("Unknown native environment context");
  if (source.kind === "eval" && context.kind !== "thread") protocol("Eval source requires a native worker context");
  return { kind: "native-node", entry, source, input: fdInput, output, profile: { runtime, executable, runtimeSHA256, identity, roots, basis, dependencyGeneration, artifacts, moduleSearchPaths, requiredCapabilities }, context };
}
