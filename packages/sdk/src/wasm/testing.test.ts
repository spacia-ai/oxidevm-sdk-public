import { describe, expect, it } from "vitest";
import { defineModule } from "./define.js";
import { kit } from "./kit/index.js";
import { MODULE_EXIT } from "./exit-codes.js";
import { testHost, type TestNet } from "./testing/index.js";

const ADD_WASM = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0, 1, 7, 1, 96, 2, 127, 127, 1, 127, 3, 2, 1, 0, 7, 7, 1, 3, 97, 100, 100, 0, 0, 10, 9, 1, 7, 0, 32, 0, 32, 1, 106, 11]);

const add = defineModule({
  manifest: {
    id: "add", version: "0.1.0", abi: "raw", artifacts: [{ name: "add.wasm", from: "upstream/add.wasm" }], process: { kind: "command" }, commands: ["add"],
    requires: { host: ["files.sync"] }, license: { spdx: "Apache-2.0" }, options: { verbose: { type: "boolean", default: false } },
  },
  adapter: async host => {
    const instance = await WebAssembly.instantiate(await host.artifacts.compile("add.wasm"));
    const exported = instance.exports["add"];
    return {
      main: io => {
        if (typeof exported !== "function" || io.args.length !== 2) return host.fail(2, `usage: ${io.invocation.kind === "command" ? io.invocation.argv0 : "add"} <a> <b>`);
        const sum: unknown = Reflect.apply(exported, undefined, io.args.map(Number));
        host.fs.writeAll(io.stdout, new TextEncoder().encode(`${String(sum)}${host.options.verbose ? " (verbose)" : ""}\n`));
        host.fs.writeFile("/workspace/last.txt", new TextEncoder().encode(String(sum)));
        return 0;
      },
    };
  },
});

const fetcher = defineModule({
  manifest: { id: "fetcher", version: "0.1.0", abi: "raw", artifacts: [], process: { kind: "command" }, requires: { host: ["net.internet"] }, license: { spdx: "Apache-2.0" } },
  adapter: host => ({
    main: async io => {
      try {
        const response = await host.net.connect({ host: "api.example.com", port: 443, tls: true });
        await response.close();
        const answer = await fetchVia(host.net, io.args[0] ?? "https://api.example.com/");
        host.log(answer);
        return 0;
      } catch (error: unknown) { host.log(kit.net.describe(error, "fetcher")); return MODULE_EXIT.unavailable; }
    },
  }),
});

/** A request over host.net as module code would make it, so the test does not depend on the global fetch. */
async function fetchVia(net: { connect: (options: { readonly host: string; readonly port: number; readonly tls?: boolean }) => Promise<{ readonly readable: ReadableStream<Uint8Array>; readonly writable: WritableStream<Uint8Array>; close(): Promise<void> }> }, url: string): Promise<string> {
  const target = new URL(url), connection = await net.connect({ host: target.hostname, port: 443, tls: true }), writer = connection.writable.getWriter();
  await writer.write(new TextEncoder().encode(`GET ${target.pathname} HTTP/1.1\r\nhost: ${target.host}\r\nconnection: close\r\n\r\n`));
  const reader = connection.readable.getReader();
  let text = "";
  for (let part = await reader.read(); !part.done; part = await reader.read()) text += new TextDecoder().decode(part.value);
  await connection.close();
  return text.split("\r\n\r\n")[1] ?? "";
}

describe("testHost (ADR 0029, N-9)", () => {
  it("runs the module through the real runner: status, stdout, files and options", async () => {
    const result = await testHost(add, { args: ["2", "3"], artifacts: { "add.wasm": ADD_WASM }, options: { verbose: true } }).run();
    expect(result).toMatchObject({ status: 0, stdout: "5 (verbose)\n", stderr: "" });
    expect(new TextDecoder().decode(result.files["/workspace/last.txt"])).toBe("5");
    const usage = await testHost(add, { args: ["2"], artifacts: { "add.wasm": ADD_WASM }, invocation: { kind: "command", name: "add", argv0: "/usr/local/bin/add" } }).run();
    expect(usage).toMatchObject({ status: 2, stderr: "usage: /usr/local/bin/add <a> <b>\n" });
  });

  it("refuses invalid options and missing artifacts as the runner does", async () => {
    expect((await testHost(add, { args: ["1", "2"], artifacts: { "add.wasm": ADD_WASM }, options: { verbose: "yes" } }).run()).status).toBe(MODULE_EXIT.launch);
    await expect(testHost(add, { args: ["1", "2"] }).run()).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("an undeclared member is absent, and the runner reports it", async () => {
    const sneaky = defineModule({
      manifest: { id: "sneaky", version: "0.1.0", abi: "raw", artifacts: [], process: { kind: "command" }, requires: { host: [] }, license: { spdx: "MIT" } },
      adapter: host => ({ main: () => ("fs" in host || Reflect.get(host, "net") !== undefined ? 1 : 0) }),
    });
    const result = await testHost(sneaky, {}).run();
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("undeclared-capability");
  });

  it("is local-only by default: the module fails with one line and status 69", async () => {
    const result = await testHost(fetcher, {}).run();
    expect(result).toMatchObject({ status: 69, stderr: "fetcher: network unavailable: this VM is not connected to the internet\n" });
  });

  it("serves a connected module from a request handler keyed by origin, with the same reach checks", async () => {
    const result = await testHost(fetcher, { args: ["https://api.example.com/hello"], net: { connected: true, http: { "https://api.example.com": request => new Response(`hi ${new URL(request.url).pathname}`) } } }).run();
    expect(result).toMatchObject({ status: 0, stderr: "hi /hello\n" });
    const vmOnly = defineModule({ manifest: { ...fetcher.manifest, id: "vm-only", requires: { host: ["net.vm"] } }, adapter: host => ({ main: async () => { try { await host.net.connect({ host: "93.184.216.10", port: 443 }); return 0; } catch (error: unknown) { host.log(kit.net.describe(error)); return 69; } } }) });
    const refused = await testHost(vmOnly, { net: { connected: true } }).run();
    expect(refused.status).toBe(69);
    // The runner's warning for an application comes first, then the module's own line.
    expect(refused.stderr.split("\n")).toEqual([JSON.stringify({ oxidevm: "warning", v: 1, kind: "network-reach", address: "93.184.216.10", port: 443, protocol: "tcp" }), "network refused: 93.184.216.10 is beyond this module's declared network reach", ""]);
  });

  it("gives module code the global fetch of its network for the run, and restores the test's own after it", async () => {
    const original = globalThis.fetch;
    const globalFetcher = defineModule({
      manifest: { id: "global-fetcher", version: "0.1.0", abi: "raw", artifacts: [], process: { kind: "command" }, requires: { host: ["net.internet"] }, license: { spdx: "MIT" } },
      adapter: host => ({ main: async () => { try { host.log(await (await fetch("https://api.example.com/a?b=1")).text()); return 0; } catch (error: unknown) { host.log(kit.net.describe(error)); return 69; } } }),
    });
    const served = await testHost(globalFetcher, { net: { connected: true, http: { "https://api.example.com": request => new Response(new URL(request.url).search) } } }).run();
    expect(served).toMatchObject({ status: 0, stderr: "?b=1\n" });
    expect(await testHost(globalFetcher, {}).run()).toMatchObject({ status: 69, stderr: "network unavailable: this VM is not connected to the internet\n" });
    expect(globalThis.fetch).toBe(original);
  });

  it("ends with the signal a module raised with its default action", async () => {
    const raiser = defineModule({
      manifest: { id: "raiser", version: "0.1.0", abi: "raw", artifacts: [], process: { kind: "command" }, requires: { host: ["process.signals"] }, license: { spdx: "MIT" } },
      adapter: host => ({ main: async () => { await host.process.signals.raise("SIGTERM"); return 0; } }),
    });
    expect(await testHost(raiser, {}).run()).toMatchObject({ status: 143, signal: "SIGTERM" });
  });
});

describe("testHost types", () => {
  it("takes a module definition and typed inputs", () => {
    // @ts-expect-error a module definition is required
    void testHost();
    // @ts-expect-error artifacts are bytes
    void testHost(add, { artifacts: { "add.wasm": "not bytes" } });
    // @ts-expect-error the network is described, not a boolean
    void testHost(add, { net: true });
  });
});

describe("testHost blocking sockets (ADR 0029, N-9)", () => {
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  /** Sends its first argument on a blocking connection and logs what one read answers; the second argument is a timeout. */
  const blocking = defineModule({
    manifest: { id: "blocking", version: "0.1.0", abi: "raw", artifacts: [], process: { kind: "command" }, requires: { host: ["net.internet"] }, license: { spdx: "MIT" } },
    adapter: host => ({
      main: io => {
        const [message = "", timeout] = io.args, connection = host.net.connectSync({ host: "slow.example.com", port: 80 });
        try {
          connection.write(encoder.encode(message));
          const bytes = connection.read(64, timeout === undefined ? undefined : { timeoutMs: Number(timeout) });
          host.log(bytes.length === 0 ? "<end>" : decoder.decode(bytes));
          return 0;
        } catch (error: unknown) {
          host.log(error instanceof Error ? `${error.name} ${String(Reflect.get(error, "code"))}: ${error.message}` : "unknown");
          return 1;
        } finally { connection.close(); }
      },
    }),
  });
  /** A TCP service that answers at once, after 50 ms of the network's clock, by ending, or never. */
  const net: TestNet = {
    connected: true,
    tcp: {
      "slow.example.com:80": {
        data: (connection, bytes) => {
          const text = decoder.decode(bytes);
          if (text === "now") connection.write(encoder.encode("now!"));
          else if (text === "later") connection.after(50, () => { connection.write(encoder.encode("later!")); });
          else if (text === "bye") connection.end();
        },
      },
    },
  };

  it("blocks a read until the server's bytes or end of stream arrive, as the browser's host does", async () => {
    expect(await testHost(blocking, { args: ["now"], net }).run()).toMatchObject({ status: 0, stderr: "now!\n" });
    expect(await testHost(blocking, { args: ["later"], net }).run()).toMatchObject({ status: 0, stderr: "later!\n" });
    expect(await testHost(blocking, { args: ["bye"], net }).run()).toMatchObject({ status: 0, stderr: "<end>\n" });
    expect(await testHost(blocking, { args: ["later", "100"], net }).run()).toMatchObject({ status: 0, stderr: "later!\n" });
  });

  it("times a read out on the network's clock, and refuses a read that nothing can ever answer instead of hanging", async () => {
    expect(await testHost(blocking, { args: ["later", "10"], net }).run()).toMatchObject({ status: 1, stderr: "NetError ETIMEDOUT: read slow.example.com: no bytes arrived within 10 ms\n" });
    const never = await testHost(blocking, { args: ["silence"], net }).run();
    expect(never.status).toBe(1);
    expect(never.stderr).toMatch(/^VMError FEATURE_NOT_AVAILABLE: testHost: a blocking read from 93\.184\.216\.\d+:80 would wait forever/u);
  });
});

describe("testHost synchronous artifacts", () => {
  it("serves host.artifacts.blob and bytesSync from the bytes the test supplies", async () => {
    const reader = defineModule({
      manifest: { id: "reader", version: "0.1.0", abi: "raw", artifacts: [{ name: "lib.zip", from: "upstream/lib.zip" }], process: { kind: "command" }, requires: { host: ["files.sync"] }, license: { spdx: "MIT" } },
      adapter: host => {
        // An interpreter that installs a package on import reads it synchronously, with no await between.
        const blob = host.artifacts.blob("lib.zip"), bytes = host.artifacts.bytesSync("lib.zip");
        return { main: () => { host.log(`${String(blob.size)} ${new TextDecoder().decode(bytes)}`); return 0; } };
      },
    });
    expect(await testHost(reader, { artifacts: { "lib.zip": new TextEncoder().encode("PK-data") } }).run()).toMatchObject({ status: 0, stderr: "7 PK-data\n" });
  });
});
