import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import * as esbuild from "esbuild";

const results: Record<string, unknown> = {};
const starting = process.cwd();
mkdirSync("esbuild-parity", { recursive: true });
process.chdir("esbuild-parity");
const root = process.cwd();
const step = (name: string): void => { process.stderr.write(`esbuild-parity:${name}\n`); };
const outputs = (files: readonly esbuild.OutputFile[] | undefined) => files?.map(file => ({ path: relative(root, file.path), contents: Buffer.from(file.contents).toString("base64"), hash: file.hash }));
function diagnostic(error: unknown) {
  assert(typeof error === "object" && error !== null && "errors" in error && Array.isArray(error.errors));
  return error.errors.map((message: unknown) => {
    assert(typeof message === "object" && message !== null && "text" in message && typeof message.text === "string" && "location" in message);
    return { text: message.text, location: message.location };
  });
}

async function compile(): Promise<void> {
  step("synchronous-pipes");
  const pipeInput = Buffer.alloc(131072, 97);
  const pipeOutput = execFileSync("/bin/sh", ["-c", "head -c 131072 /dev/zero; head -c 131072 /dev/zero >&2; cat"], { input: pipeInput, maxBuffer: 524288 });
  assert.deepEqual(pipeOutput, Buffer.concat([Buffer.alloc(131072), pipeInput]));
  results["pipes"] = { bytes: pipeOutput.byteLength, partialIO: true };
  step("transform");
  const input = "export const value: number = 42; // π";
  const options = { loader: "ts", sourcemap: "external", sourcefile: "input.ts", minify: true } as const;
  results["transform"] = await esbuild.transform(input, options);
  assert.deepEqual(esbuild.transformSync(input, options), results["transform"]);
  const formatted = [{ text: "fixture diagnostic", location: { file: "input.ts", line: 1, column: 7, length: 1, lineText: "const x=" } }];
  results["format"] = await esbuild.formatMessages(formatted, { kind: "error", color: false });
  assert.deepEqual(esbuild.formatMessagesSync(formatted, { kind: "error", color: false }), results["format"]);

  step("filesystem");
  mkdirSync("src", { recursive: true }); mkdirSync("assets", { recursive: true });
  writeFileSync("src/entry.ts", "import { value } from './link'; import data from './data.json'; import raw from './raw.txt'; import './style.css'; console.log(value, data.name, raw)");
  writeFileSync("src/value.ts", "export const value: number = 42;");
  rmSync("src/link.ts", { force: true }); symlinkSync("value.ts", "src/link.ts");
  writeFileSync("src/data.json", '{"name":"π"}'); writeFileSync("src/raw.txt", "raw π");
  writeFileSync("src/style.css", "body { background: url('../assets/pixel.bin'); color: red }");
  writeFileSync("assets/pixel.bin", Uint8Array.of(0, 1, 2, 255));
  writeFileSync("tsconfig.json", '{"compilerOptions":{"target":"ES2020","strict":true}}');
  const buildOptions: esbuild.BuildOptions = { absWorkingDir: root, entryPoints: ["src/entry.ts"], outdir: "dist", bundle: true, write: false, metafile: true, sourcemap: true,
    loader: { ".txt": "text", ".bin": "file" }, logLevel: "silent" };
  const build = await esbuild.build(buildOptions);
  results["build"] = { files: outputs(build.outputFiles), metafile: build.metafile, warnings: build.warnings };
  const synchronous = esbuild.buildSync(buildOptions);
  assert.deepEqual({ files: outputs(synchronous.outputFiles), metafile: synchronous.metafile, warnings: synchronous.warnings }, results["build"]);
  assert(build.metafile !== undefined);
  results["analysis"] = await esbuild.analyzeMetafile(build.metafile);
  assert.equal(esbuild.analyzeMetafileSync(build.metafile), results["analysis"]);
  await esbuild.build({ ...buildOptions, write: true });
  assert.deepEqual(readFileSync("dist/entry.js"), Buffer.from(build.outputFiles?.find(file => file.path.endsWith("entry.js"))?.contents ?? []));
  results["diagnostic"] = await esbuild.transform("const =", { sourcefile: "invalid.ts", logLevel: "silent" }).then(
    () => { throw new Error("Invalid source compiled successfully"); },
    diagnostic);
  try { esbuild.transformSync("const =", { sourcefile: "invalid.ts", logLevel: "silent" }); throw new Error("Invalid synchronous source compiled successfully"); }
  catch (error) { assert.deepEqual(diagnostic(error), results["diagnostic"]); }
  writeFileSync("src/private.ts", "export const secret = 1"); chmodSync("src/private.ts", 0);
  try {
    results["permission"] = await esbuild.build({ absWorkingDir: root, entryPoints: ["src/private.ts"], write: false, logLevel: "silent" }).then(
      () => { throw new Error("The compiler read a denied file"); }, diagnostic);
  } finally { chmodSync("src/private.ts", 0o600); }

  step("plugins");
  const calls: string[] = [];
  const disposed = Promise.withResolvers<undefined>();
  const plugin: esbuild.Plugin = { name: "original-process", setup(build) {
    build.onStart(async () => { calls.push("start"); await Promise.resolve(); });
    build.onResolve({ filter: /^virtual:/ }, async args => {
      const resolved = await build.resolve("./src/value.ts", { resolveDir: root, kind: "import-statement" });
      assert.equal(resolved.errors.length, 0);
      assert.equal(resolved.path, join(root, "src/value.ts"));
      calls.push("resolve"); return { path: args.path, namespace: "virtual", pluginData: "preserved" };
    });
    build.onLoad({ filter: /.*/, namespace: "virtual" }, args => {
      assert.equal(args.pluginData, "preserved"); calls.push("load");
      return { contents: "export default 41 + 1", loader: "js", watchFiles: [join(root, "src/value.ts")] };
    });
    build.onEnd(result => { assert.equal(result.errors.length, 0); calls.push("end"); });
    build.onDispose(() => { calls.push("dispose"); disposed.resolve(undefined); });
  } };
  const context = await esbuild.context({ absWorkingDir: root, stdin: { contents: "import n from 'virtual:input'; console.log(n)", resolveDir: root }, bundle: true, write: false, plugins: [plugin], logLevel: "silent" });
  try {
    const first = await context.rebuild(), next = await context.rebuild();
    results["plugin"] = outputs(first.outputFiles);
    assert.deepEqual(outputs(next.outputFiles), results["plugin"]);
    assert.deepEqual(calls, ["start", "resolve", "load", "end", "start", "resolve", "load", "end"]);
  } finally { await context.dispose(); await disposed.promise; }

  step("cancel");
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>();
  const cancellable = await esbuild.context({ absWorkingDir: root, stdin: { contents: "import 'pending:input'" }, bundle: true, write: false, logLevel: "silent",
    plugins: [{ name: "cancellation", setup(build) {
      build.onResolve({ filter: /^pending:/ }, async args => { entered.resolve(undefined); await release.promise; return { path: args.path, namespace: "pending" }; });
      build.onLoad({ filter: /.*/, namespace: "pending" }, () => ({ contents: "export default 1" }));
    } }] });
  try {
    const pending = cancellable.rebuild().then(() => "completed", (error: unknown) => {
      assert(error instanceof Error); return error.message.includes("canceled") ? "cancelled" : error.message;
    });
    await entered.promise;
    const cancelled = cancellable.cancel(); release.resolve(undefined); await cancelled;
    assert.equal(await pending, "cancelled");
    assert.equal((await cancellable.rebuild()).errors.length, 0);
    results["cancellation"] = "cancelled-and-rebuilt";
  } finally { release.resolve(undefined); await cancellable.dispose(); }

  step("watch");
  const changed = Promise.withResolvers<undefined>();
  writeFileSync("src/watched.js", "console.log('initial-watch')");
  const watch = await esbuild.context({ absWorkingDir: root, entryPoints: ["src/watched.js"], write: false, logLevel: "silent",
    plugins: [{ name: "watch", setup(build) { build.onEnd(result => { if (result.outputFiles?.some(file => file.text.includes("updated-watch")) === true) changed.resolve(undefined); }); } }] });
  try {
    await watch.watch();
    await watch.rebuild();
    writeFileSync("src/watched.js", "console.log('updated-watch')");
    const timeout = setTimeout(() => changed.reject(new Error("Watch did not observe the file edit")), 30_000);
    try { await changed.promise; results["watch"] = "updated"; } finally { clearTimeout(timeout); }
  } finally { await watch.dispose(); }
}

function request(port: number, path: string, secure: boolean, method = "GET", host = "localhost", hostname = "127.0.0.1") {
  return new Promise<{ status: number; body: string; type: string | undefined; cors: string | undefined }>((resolve, reject) => {
    const call = (secure ? https : http).request({ hostname, port, path, method, headers: { Host: host, Origin: "https://allowed.example" }, agent: false,
      ...(secure ? { rejectUnauthorized: false } : {}) }, response => {
      const chunks: Uint8Array[] = [];
      response.on("data", (value: unknown) => { assert(value instanceof Uint8Array); chunks.push(value); });
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString(), type: response.headers["content-type"], cors: response.headers["access-control-allow-origin"] }));
    });
    call.on("error", reject); call.setTimeout(30_000, () => { call.destroy(new Error("HTTP response timeout")); }); call.end();
  });
}

async function eventStream(port: number, secure: boolean) {
  const opened = Promise.withResolvers<undefined>(), changed = Promise.withResolvers<unknown>();
  void changed.promise.catch(() => undefined);
  const call = (secure ? https : http).request({ hostname: "127.0.0.1", port, path: "/esbuild", headers: { Host: "localhost", Accept: "text/event-stream" }, agent: false,
    ...(secure ? { rejectUnauthorized: false } : {}) }, response => {
    assert.equal(response.statusCode, 200); assert.equal(response.headers["content-type"], "text/event-stream");
    let text = "";
    response.on("data", (bytes: unknown) => {
      assert(bytes instanceof Uint8Array); text += Buffer.from(bytes).toString(); assert(text.length < 65536);
      const message = /event: change\ndata: ([^\n]*)\n\n/u.exec(text)?.[1];
      if (message !== undefined) changed.resolve(JSON.parse(message) as unknown);
    });
    response.on("error", changed.reject); opened.resolve(undefined);
  });
  const timer = setTimeout(() => { const error = new Error("Event stream timeout"); opened.reject(error); changed.reject(error); call.destroy(error); }, 30_000);
  call.on("error", error => { opened.reject(error); changed.reject(error); }); call.end();
  try { await opened.promise; }
  catch (error) { clearTimeout(timer); call.destroy(); throw error; }
  return { change: changed.promise, close(): void { clearTimeout(timer); call.destroy(); } };
}

async function serve(): Promise<void> {
  const identity: unknown = JSON.parse(readFileSync(join(starting, "esbuild-identity.json"), "utf8"));
  assert(typeof identity === "object" && identity !== null && "key" in identity && typeof identity.key === "string" && "cert" in identity && typeof identity.cert === "string");
  writeFileSync("key.pem", identity.key); writeFileSync("cert.pem", identity.cert);
  mkdirSync("public", { recursive: true }); writeFileSync("public/static.txt", "static π"); writeFileSync("public/fallback.html", "fallback π");
  for (const secure of [false, true]) {
    step(secure ? "https" : "http");
    writeFileSync("serve-entry.js", "console.log('served-build')");
    const seen: string[] = [];
    const context = await esbuild.context({ absWorkingDir: root, entryPoints: ["serve-entry.js"], bundle: true, outdir: "public/generated", logLevel: "silent" });
    let port: number | undefined;
    try {
      const server = await context.serve({ host: "127.0.0.1", port: 0, servedir: "public", fallback: "public/fallback.html", cors: { origin: ["https://allowed.example"] },
        onRequest(args) { seen.push(`${args.method}:${args.path}:${String(args.status)}`); }, ...(secure ? { keyfile: "key.pem", certfile: "cert.pem" } : {}) });
      port = server.port;
      step(`${secure ? "https" : "http"}:listening`);
      assert(server.hosts.includes("127.0.0.1"));
      const compiled = await request(port, "/generated/serve-entry.js", secure);
      step(`${secure ? "https" : "http"}:compiled`);
      assert.equal(compiled.status, 200); assert(compiled.body.includes("served-build"));
      const staticFile = await request(port, "/static.txt", secure);
      step(`${secure ? "https" : "http"}:static`);
      assert.equal(staticFile.status, 200); assert.equal(staticFile.body, "static π"); assert.equal(staticFile.cors, "https://allowed.example");
      assert.equal((await request(port, "/static.txt", secure, "HEAD")).body, "");
      step(`${secure ? "https" : "http"}:head`);
      assert.equal((await request(port, "/missing", secure)).body, "fallback π");
      assert.equal((await request(port, "/", secure, "GET", "untrusted.example")).status, 403);
      const stream = await eventStream(port, secure);
      try {
        writeFileSync("serve-entry.js", "console.log('updated-served-build')");
        await context.rebuild();
        const event = await stream.change;
        assert(typeof event === "object" && event !== null && "updated" in event && Array.isArray(event.updated));
        assert(event.updated.includes("/generated/serve-entry.js"));
        results[secure ? "https" : "http"] = { compiled, staticFile, hostChecks: true, event };
      } finally { stream.close(); }
      assert(seen.length >= 3);
    } finally { step(`${secure ? "https" : "http"}:disposing`); await context.dispose(); step(`${secure ? "https" : "http"}:disposed`); }
    await assert.rejects(request(port, "/", secure), /ECONNREFUSED|socket|reset/iu);
  }
}

async function serveBindings(): Promise<void> {
  mkdirSync("bindings", { recursive: true }); writeFileSync("bindings/index.html", "binding-response");
  const bindings: string[] = [];
  for (const host of [undefined, "localhost"]) {
    const context = await esbuild.context({ absWorkingDir: root, logLevel: "silent" });
    try {
      const server = await context.serve({ port: 0, servedir: "bindings", ...(host === undefined ? {} : { host }) });
      const address = server.hosts.find(value => value === "127.0.0.1" || value === "::1");
      assert(address !== undefined, "Default and localhost binds must include a loopback endpoint");
      const response = await request(server.port, "/", false, "GET", "localhost", address);
      assert.equal(response.status, 200); assert.equal(response.body, "binding-response");
      assert.equal((await request(server.port, "/", false, "GET", "untrusted.example", address)).status, 403);
      bindings.push(host ?? "default");
    } finally { await context.dispose(); }
  }
  results["bindings"] = bindings;
}

async function main(): Promise<void> {
  try {
    if (process.argv.includes("--bindings")) await serveBindings();
    else { await compile(); if (process.argv.includes("--serve")) { await serve(); await serveBindings(); } }
    process.stdout.write(`${JSON.stringify(results)}\n`);
  } finally { await esbuild.stop(); }
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
