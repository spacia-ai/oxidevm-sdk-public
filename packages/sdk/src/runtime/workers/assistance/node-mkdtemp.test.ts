import * as native from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { Buffer } from "buffer";
import type { AssistanceOperation } from "../../protocol/assistance.js";
import type { AssistanceResult } from "../../protocol/assistance-reply.js";
import { record } from "../../decode.js";
import { createAsyncContext } from "./async-context.js";
import { mkdtemp } from "./node-file-mkdtemp.js";
import { createAsyncFiles, createSyncFiles } from "./node-files.js";
import { nodeUtil } from "./node-util.js";

const control = record(JSON.parse(native.readFileSync(new URL("./node-mkdtemp.controls.json", import.meta.url), "utf8")), "mkdtemp controls");
const recorder = fileURLToPath(new URL("../../../../../../tests/fixtures/assistance/node-mkdtemp.cjs", import.meta.url));
const previousMask = process.umask(0o022);
afterEach(() => { process.umask(0o022); });
process.on("exit", () => { process.umask(previousMask); });

/** Linux mkdir over the host, relative paths resolved in `cwd` as the authenticated helper does. */
function linux(cwd: () => string) {
  return (operation: AssistanceOperation): AssistanceResult => {
    if (operation.kind !== "mkdir") throw new Error(`Unexpected ${operation.kind}`);
    const path = isAbsolute(operation.path) ? operation.path : join(cwd(), operation.path);
    try { native.mkdirSync(path, operation.mode); return { kind: "unit" }; } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string" || !("errno" in error) || typeof error.errno !== "number") throw error;
      return { kind: "error", code: error.code, errno: -error.errno, syscall: "mkdir", path: operation.path, destination: null };
    }
  };
}
function failure(error: unknown, root: string, full: boolean): Record<string, unknown> {
  if (!(error instanceof Error)) throw error;
  const field = (name: string): unknown => Object.hasOwn(error, name) ? Reflect.get(error, name) : null;
  const relative = (value: unknown): unknown => typeof value === "string" ? value.split(root).join("<root>") : value;
  return full ? { error: { name: error.name, code: field("code"), errno: field("errno"), syscall: field("syscall"), path: relative(field("path")), message: relative(error.message) } }
    : { error: { code: field("code"), errno: field("errno"), syscall: field("syscall"), path: relative(field("path")), message: relative(error.message) } };
}
function outcome(run: () => unknown, root: string, cwd: () => string): Record<string, unknown> {
  try {
    const value = run();
    if (Buffer.isBuffer(value)) return { buffer: value.toString().split(root).join("<root>").replace(/[A-Pa-p]{6}$/u, "<name>") };
    if (typeof value === "object" && value !== null) return { ...value };
    if (typeof value !== "string") return { value: typeof value };
    const stat = native.statSync(isAbsolute(value) ? value : join(cwd(), value));
    return { path: value.split(root).join("<root>").replace(/[A-Pa-p]{6}$/u, "<name>"), suffixMatches: /[A-Pa-p]{6}$/u.test(value), mode: (stat.mode & 0o7777).toString(8), directory: stat.isDirectory() };
  } catch (error) { return failure(error, root, true); }
}

it("replays the recorder the controls came from", () => {
  expect(createHash("sha256").update(native.readFileSync(recorder)).digest("hex")).toBe(control["recorderSHA256"]);
  expect(record(control["node"], "pinned Node")).toEqual({ binarySHA256: "af89883ff1f2dbe825aa7fd55004276e752da3c84391f2709692759bbb61a7ab", version: "v24.18.1" });
});

it("makes temporary directories in all three forms as pinned Node does, errors included", async () => {
  const host = native.mkdtempSync(join(tmpdir(), "oxidevm-mkdtemp-")), root = `${host}/record-x`;
  native.mkdirSync(root);
  let directory = host;
  const cwd = () => directory, call = linux(cwd);
  const inspect = (value: unknown, options: { readonly depth: -1 }): string => nodeUtil.inspect(value, options);
  const sync = createSyncFiles(call, cwd, undefined, inspect), asynchronous = createAsyncFiles(operation => Promise.resolve(call(operation)), cwd, createAsyncContext(), () => () => {}, undefined, { inspect });
  native.writeFileSync(`${root}/file`, "");
  try {
    const cases: [string, () => unknown][] = [
      ["string", () => sync.mkdtempSync(`${root}/a-`)],
      ["no-dash", () => sync.mkdtempSync(`${root}/b`)],
      ["directory-prefix", () => sync.mkdtempSync(`${root}/`)],
      ["buffer-prefix", () => sync.mkdtempSync(Buffer.from(`${root}/c-`))],
      ["url-prefix", () => sync.mkdtempSync(pathToFileURL(`${root}/d-`))],
      ["encoding-buffer", () => sync.mkdtempSync(`${root}/e-`, "buffer")],
      ["encoding-option-buffer", () => sync.mkdtempSync(`${root}/f-`, { encoding: "buffer" })],
      ["encoding-utf8", () => sync.mkdtempSync(`${root}/g-`, { encoding: "utf8" })],
      ["encoding-invalid", () => sync.mkdtempSync(`${root}/h-`, { encoding: "nope" })],
      ["missing-parent", () => sync.mkdtempSync(`${root}/none/x-`)],
      ["parent-is-file", () => sync.mkdtempSync(`${root}/file/x-`)],
      ["number-prefix", () => sync.mkdtempSync(1)],
      ["undefined-prefix", () => sync.mkdtempSync(undefined)],
      ["null-byte", () => sync.mkdtempSync(`${root}/\u0000x`)],
      ["relative", () => { directory = root; try { const name = sync.mkdtempSync("rel-"); if (typeof name !== "string") throw new TypeError("name"); return { relativeName: /^rel-[A-Pa-p]{6}$/u.test(name), directory: native.statSync(join(root, name)).isDirectory() }; } finally { directory = host; } }],
    ];
    const rows = cases.map(([name, run]) => ({ name, ...outcome(run, root, cwd) }));
    const callback = await new Promise<unknown>(resolve => { asynchronous.mkdtemp(`${root}/cb-`, (error: unknown, value: unknown) => { resolve(error === null ? outcome(() => value, root, cwd) : failure(error, root, false)); }); });
    const callbackMissing = await new Promise<unknown>(resolve => { asynchronous.mkdtemp(`${root}/none/cb-`, (error: unknown) => { resolve(failure(error, root, false)); }); });
    const noCallback = outcome(() => { asynchronous.mkdtemp(`${root}/nc-`, undefined); }, root, cwd);
    const promise = outcome(() => undefined, root, cwd), made = await asynchronous.promises.mkdtemp(`${root}/p-`);
    const promiseMissing = await asynchronous.promises.mkdtemp(`${root}/none/p-`).then(() => ({}), (error: unknown) => failure(error, root, false));
    expect({ rows, callback, callbackMissing, noCallback, promise: outcome(() => made, root, cwd), promiseMissing,
      lengths: [sync.mkdtempSync.length, asynchronous.mkdtemp.length, asynchronous.promises.mkdtemp.length] })
      .toEqual({ rows: control["rows"], callback: control["callback"], callbackMissing: control["callbackMissing"], noCallback: control["noCallback"],
        promise: control["promise"], promiseMissing: control["promiseMissing"], lengths: control["lengths"] });
    expect(promise).toEqual({ value: "undefined" });
  } finally { native.rmSync(host, { recursive: true }); }
});

it("names a directory with musl's letters and retries a name that exists", () => {
  const seeds = [0, 0xffffffff, 0x12345678];
  const seen: AssistanceOperation[] = [];
  const program = mkdtemp("/tmp/x-", undefined, value => String(value), () => seeds.shift() ?? 0);
  let step = program.next();
  while (step.done !== true) {
    seen.push(step.value);
    step = program.next(seen.length < 3 ? { kind: "error", code: "EEXIST", errno: 17, syscall: "mkdir", path: "", destination: null } : { kind: "unit" });
  }
  // Five bits per letter, low bits first: 0 gives six A, all ones six p ('A' + 15 + 16 * 2), and 0x12345678 has the
  // groups 24, 19, 21, 8, 3, 9: i, d, f, I, D, J.
  expect(seen.map(operation => operation.kind === "mkdir" ? [operation.path, operation.mode] : [])).toEqual([["/tmp/x-AAAAAA", 0o700], ["/tmp/x-pppppp", 0o700], ["/tmp/x-idfIDJ", 0o700]]);
  expect(step.value).toBe("/tmp/x-idfIDJ");
});

it("refuses mkdtemp with a typed late failure where the worker gives no inspect, as esbuild's Go host does", async () => {
  const sync = createSyncFiles(() => ({ kind: "unit" }), () => "/"), asynchronous = createAsyncFiles(() => Promise.resolve({ kind: "unit" }), () => "/", createAsyncContext(), () => () => {});
  const refusal = { code: "FEATURE_NOT_AVAILABLE", detail: { lateFailure: "unavailable-builtin" } };
  let thrown: unknown;
  try { sync.mkdtempSync("/tmp/x-"); } catch (error) { thrown = error; }
  expect(thrown).toMatchObject(refusal);
  await expect(asynchronous.promises.mkdtemp("/tmp/x-")).rejects.toMatchObject(refusal);
});
