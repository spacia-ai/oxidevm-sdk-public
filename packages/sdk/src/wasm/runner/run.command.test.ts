import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMAND_DECLARATION, SERVICE_DECLARATION, buildRelease, type Release } from "./fixtures.test-support.js";
import { encodeLaunchArgument } from "./descriptor.js";
import { commandLaunch, launch, records } from "./harness.test-support.js";

afterEach(() => { vi.restoreAllMocks(); Reflect.deleteProperty(globalThis, "verifiedModule"); Reflect.deleteProperty(globalThis, "mintedUrl"); });

const wasm = Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0);
const commandRelease = (adapter: string, extras: Partial<Parameters<typeof buildRelease>[0]> = {}): Promise<Release> =>
  buildRelease({ adapter, artifacts: { "tool.wasm": wasm }, declaration: COMMAND_DECLARATION, ...extras });

describe("command modules", () => {
  it("passes the command's own arguments, environment, working directory and descriptors to main", async () => {
    const release = await commandRelease(`export default host => ({ main: io => {
      host.log("args=" + JSON.stringify(io.args) + " cwd=" + io.cwd + " mode=" + io.env.MODE + " out=" + io.stdout + " same=" + (io.stdout === host.stdio.stdout));
      return 7;
    } });`);
    const running = launch({ release, args: ["in.md", "out.html"], environment: ["MODE=fast", "EMPTY=", "=ignored", "NOEQUALS"], cwd: "/workspace" });
    await expect(running.done).resolves.toBe(7);
    expect(running.linux.stderrLines).toEqual(['args=["in.md","out.html"] cwd=/workspace mode=fast out=1 same=true']);
  });

  it("takes its launch description from the start message, so every argument, even one that looks like a description, is the caller's", async () => {
    const release = await commandRelease(`export default host => ({ main: io => { host.log(JSON.stringify(io.args)); return 0; } });`);
    const lookalike = encodeLaunchArgument(release.descriptor);
    const running = launch({ release, args: [lookalike, "in.md"] });
    await expect(running.done).resolves.toBe(0);
    expect(running.linux.stderrLines).toEqual([JSON.stringify([lookalike, "in.md"])]);
  });

  it("returns the status of host.fail and writes its message", async () => {
    const release = await commandRelease(`export default host => ({ main: () => host.fail(2, "usage: tool <in> <out>") });`);
    const running = launch({ release });
    await expect(running.done).resolves.toBe(2);
    expect(running.linux.stderrLines).toEqual(["usage: tool <in> <out>"]);
  });

  it("compiles a verified artifact, hands over defaults and grants only the declared capabilities", async () => {
    const release = await commandRelease(`export default async host => {
      const compiled = await host.artifacts.compile("tool.wasm");
      const granted = ["fs", "files", "sockets", "process"].filter(name => name in host).join(",");
      host.log("compiled=" + (compiled instanceof WebAssembly.Module) + " granted=" + granted + " frozen=" + Object.isFrozen(host) + " kit=" + typeof host.kit.framing.readFrame);
      return { main: () => 0 };
    };`);
    const running = launch({ release });
    await expect(running.done).resolves.toBe(0);
    expect(running.linux.stderrLines).toEqual(["compiled=true granted=fs frozen=true kit=function"]);
    // The adapter first; then the artifact once to verify it before any module code runs; then once more for the compile.
    const artifact = release.descriptor.artifacts["tool.wasm"]?.url;
    expect(running.fetched).toEqual([release.descriptor.adapter.url, artifact, artifact]);
  });

  it("fetches each pinned file once to verify it and once for all the uses the adapter makes of it", async () => {
    const release = await commandRelease(`export default async host => { await host.artifacts.bytes("tool.wasm"); await host.artifacts.compile("tool.wasm"); await host.artifacts.bytes("tool.wasm"); return { main: () => 0 }; };`);
    const running = launch({ release });
    await running.done;
    expect(running.fetched.filter(url => url.endsWith("tool.wasm"))).toHaveLength(2);
  });

  it("verifies a file the adapter never uses and does not keep it", async () => {
    const release = await commandRelease("export default () => ({ main: () => 0 });");
    const running = launch({ release });
    await expect(running.done).resolves.toBe(0);
    expect(running.fetched).toEqual([release.descriptor.adapter.url, release.descriptor.artifacts["tool.wasm"]?.url]);
  });

  it("calls close after main, even when main fails", async () => {
    const release = await commandRelease(`let closed = 0; export default host => ({ main: () => { throw new Error("boom"); }, close: () => { host.log("closed"); } });`);
    const running = launch({ release });
    await expect(running.done).resolves.toBe(123);
    expect(running.linux.stderrLines[0]).toBe("closed");
    expect(records(running.linux.stderrLines).at(-1)).toMatchObject({ oxidevm: "error", kind: "adapter", message: "boom" });
  });
});

describe("runner failures", () => {
  it("reports exit 120 when the launch descriptor is missing, oversized, not JSON or inconsistent", async () => {
    const release = await commandRelease("export default () => ({ main: () => 0 });");
    for (const argument of [null, "not json", "{}", JSON.stringify({ ...release.descriptor, extra: true })]) {
      const running = launch({ release, argument });
      await expect(running.done, String(argument)).resolves.toBe(120);
      expect(records(running.linux.stderrLines)[0]).toMatchObject({ oxidevm: "error", v: 1, kind: "launch" });
      expect(running.imports.count).toBe(0);
    }
  });

  it("reports exit 120 for options the manifest does not accept", async () => {
    const release = await commandRelease("export default () => ({ main: () => 0 });", { options: { surprise: 1 } });
    await expect(launch({ release }).done).resolves.toBe(120);
  });

  it("reports exit 121 before running any module code when the adapter bytes differ from their pin", async () => {
    const forged = new TextEncoder().encode("export default () => ({ main: () => 99 });");
    const release = await commandRelease("export default () => ({ main: () => 0 });", { tamper: { "adapter.mjs": Uint8Array.from(forged) } });
    const running = launch({ release });
    await expect(running.done).resolves.toBe(121);
    expect(running.imports.count).toBe(0);
    expect(records(running.linux.stderrLines)[0]).toMatchObject({ kind: "integrity" });
  });

  it("reports exit 121 when an artifact is altered, whether its size changes or not", async () => {
    const same = Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 1), longer = Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0);
    for (const bytes of [same, longer, wasm.subarray(0, 4)]) {
      const release = await commandRelease(`export default async host => { await host.artifacts.compile("tool.wasm"); return { main: () => 0 }; };`, { tamper: { "tool.wasm": Uint8Array.from(bytes) } });
      await expect(launch({ release }).done, String(bytes.length)).resolves.toBe(121);
    }
  });

  it("verifies every pinned file before the adapter's code runs, whether or not the adapter ever loads it", async () => {
    const forged = Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 1);
    // The adapter only asks for the file's address, as a loader that fetches its own files does.
    const release = await commandRelease(`export default host => { void host.artifacts.url("tool.wasm"); return { main: () => 0 }; };`, { tamper: { "tool.wasm": Uint8Array.from(forged) } });
    const running = launch({ release });
    await expect(running.done).resolves.toBe(121);
    expect(running.imports.count).toBe(0);
    expect(records(running.linux.stderrLines)[0]).toMatchObject({ kind: "integrity" });
  });

  it("reports exit 122 and names what is missing", async () => {
    const release = await commandRelease("export default () => ({ main: () => 0 });", {
      declaration: { ...COMMAND_DECLARATION, requires: { host: ["files.sync"], browser: ["jspi", "indexeddb"], guest: { executables: ["/usr/bin/python3", "/usr/bin/present"] } } },
    });
    const running = launch({ release, browser: { crossOriginIsolated: true, indexedDB: false, jspi: false, webLocks: true }, paths: { "/usr/bin/present": 0o100755 } });
    await expect(running.done).resolves.toBe(122);
    expect(records(running.linux.stderrLines)[0]).toMatchObject({ kind: "prerequisite", items: ["browser feature indexeddb", "browser feature jspi", "guest executable /usr/bin/python3"] });
    expect(running.imports.count).toBe(0);
  });

  it("treats a guest path that is not an executable file as missing", async () => {
    const release = await commandRelease("export default () => ({ main: () => 0 });", {
      declaration: { ...COMMAND_DECLARATION, requires: { host: ["files.sync"], guest: { executables: ["/usr/bin/data", "/usr/bin/dir"] } } },
    });
    const running = launch({ release, paths: { "/usr/bin/data": 0o100644, "/usr/bin/dir": 0o040755 } });
    await expect(running.done).resolves.toBe(122);
  });

  it("reports exit 123 for every adapter that breaks its contract", async () => {
    const bad: readonly (readonly [string, string])[] = [
      ["factory throws", "export default () => { throw new Error('factory'); };"],
      ["no default export", "export const other = 1;"],
      ["default is not a function", "export default 5;"],
      ["no main", "export default () => ({});"],
      ["unknown member", "export default () => ({ main: () => 0, clsoe: () => {} });"],
      ["returns nothing", "export default () => undefined;"],
      ["main is not a function", "export default () => ({ main: 1 });"],
      ["main returns a runner status", "export default () => ({ main: () => 120 });"],
      ["main returns a negative status", "export default () => ({ main: () => -1 });"],
      ["main returns a fraction", "export default () => ({ main: () => 1.5 });"],
      ["main returns text", "export default () => ({ main: () => '0' });"],
      ["main rejects", "export default () => ({ main: async () => { throw new Error('late'); } });"],
      ["syntax error", "export default (;"],
    ];
    for (const [name, adapter] of bad) {
      const release = await commandRelease(adapter);
      const running = launch({ release });
      await expect(running.done, name).resolves.toBe(123);
      expect(records(running.linux.stderrLines).at(-1), name).toMatchObject({ oxidevm: "error", v: 1, kind: "adapter" });
    }
  });

  it("accepts the whole adapter range and rejects only the runner statuses", async () => {
    for (const status of [0, 1, 119]) {
      const release = await commandRelease(`export default () => ({ main: () => ${String(status)} });`);
      await expect(launch({ release }).done).resolves.toBe(status);
    }
  });

  it("refuses to hand an adapter a status for host.fail outside 1 to 119", async () => {
    const release = await commandRelease(`export default host => ({ main: () => { try { host.fail(0, "x"); } catch { return host.fail(120 - 1, "ok"); } return 50; } });`);
    await expect(launch({ release }).done).resolves.toBe(119);
  });
});

// Engine ADR 0027: a program in the VM ran one of the module's commands, and the runner starts with the copies the
// Userspace worker verified when the commands were turned on.
describe("commands a program in the VM runs", () => {
  const python = { ...COMMAND_DECLARATION, commands: ["python", "python3"] } as const;
  const report = `export default host => ({ main: io => {
    host.log(JSON.stringify({ args: io.args, invocation: io.invocation, terminals: io.terminals, cwd: io.cwd, mode: io.env.MODE }));
    return 3;
  } });`;

  it("passes the arguments after argv[0], the invocation with argv[0], the terminals and the caller's environment and directory to main", async () => {
    const release = await commandRelease(report, { declaration: python });
    const running = launch({ release, command: await commandLaunch(release, "python", { stdin: true, stdout: true, stderr: false }), args: ["python", "x.py", "-v"], environment: ["MODE=fast"], cwd: "/tmp" });
    await expect(running.done).resolves.toBe(3);
    expect(running.linux.stderrLines.map(line => JSON.parse(line) as unknown)).toEqual([{ args: ["x.py", "-v"], invocation: { kind: "command", name: "python", path: "/usr/local/bin/python", argv0: "python" }, terminals: { stdin: true, stdout: true, stderr: false }, cwd: "/tmp", mode: "fast" }]);
    expect(running.fetched).toEqual([]);
    // A caller may run the stub through a link or with any argv[0], or with none at all.
    const aliased = launch({ release, command: await commandLaunch(release, "python3"), args: ["/opt/py"] });
    await aliased.done;
    expect(JSON.parse(aliased.linux.stderrLines[0] ?? "null")).toMatchObject({ args: [], invocation: { kind: "command", name: "python3", path: "/usr/local/bin/python3", argv0: "/opt/py" } });
    const bare = launch({ release, command: await commandLaunch(release, "python"), args: [] });
    await bare.done;
    expect(JSON.parse(bare.linux.stderrLines[0] ?? "null")).toMatchObject({ args: [], invocation: { argv0: "" } });
  });

  it("tells an application start that the host started it, with no terminals, and passes every argument", async () => {
    const release = await commandRelease(report, { declaration: python });
    const running = launch({ release, args: ["in.md"], environment: ["MODE=slow"], cwd: "/workspace" });
    await expect(running.done).resolves.toBe(3);
    expect(running.linux.stderrLines.map(line => JSON.parse(line) as unknown)).toEqual([{ args: ["in.md"], invocation: { kind: "host" }, terminals: { stdin: false, stdout: false, stderr: false }, cwd: "/workspace", mode: "slow" }]);
  });

  it("never fetches or hashes: compile returns the verified module, bytes read the copy, url is a blob: URL revoked at exit", async () => {
    const release = await commandRelease(`export default async host => {
      const first = await host.artifacts.compile("tool.wasm"), second = await host.artifacts.compile("tool.wasm");
      const copy = await host.artifacts.bytes("tool.wasm"); copy.fill(9);
      const url = host.artifacts.url("tool.wasm");
      globalThis.mintedUrl = url;
      host.log(JSON.stringify({ shared: first === second && first === globalThis.verifiedModule, bytes: Array.from(await host.artifacts.bytes("tool.wasm")), blob: url.startsWith("blob:"), stable: url === host.artifacts.url("tool.wasm"), fetched: await (await fetch(url)).arrayBuffer().then(buffer => buffer.byteLength) }));
      return { main: () => 0 };
    };`, { declaration: python });
    const command = await commandLaunch(release, "python");
    Reflect.set(globalThis, "verifiedModule", command.artifacts["tool.wasm"]?.module);
    const compile = vi.spyOn(WebAssembly, "compile"), digest = vi.spyOn(crypto.subtle, "digest"), revoke = vi.spyOn(URL, "revokeObjectURL");
    const running = launch({ release, command, args: ["python"] });
    await expect(running.done).resolves.toBe(0);
    expect(JSON.parse(running.linux.stderrLines[0] ?? "null")).toEqual({ shared: true, bytes: [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0], blob: true, stable: true, fetched: 8 });
    expect(running.fetched).toEqual([]);
    expect(compile).not.toHaveBeenCalled();
    expect(digest).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith(Reflect.get(globalThis, "mintedUrl"));
  });

  it("reports a runner failure as one readable line on standard error, never a JSON record", async () => {
    const throwing = await commandRelease(`export default () => ({ main: () => { throw new Error("first\\nsecond"); } });`, { declaration: python });
    const reaching = await commandRelease(`export default host => ({ main: () => host.process.spawn("/bin/true", []) });`, { declaration: python });
    const needing = await commandRelease("export default () => ({ main: () => 0 });", { declaration: { ...python, requires: { host: ["files.sync"], guest: { executables: ["/usr/bin/python3"] } } } });
    const service = await buildRelease({ adapter: "export default () => ({ protocols: {} });", declaration: { ...SERVICE_DECLARATION, requires: { host: ["files.sync"] } } });
    const stale = await commandLaunch(throwing, "python");
    const cases = [
      [await commandLaunch(service, "python"), service, 120, /^python: cannot start: db is a service and runs no commands$/u],
      [{ ...stale, artifacts: {} }, throwing, 120, /^python: cannot start: The verified copies of the module's files do not match its launch description$/u],
      [await commandLaunch(needing, "python"), needing, 122, /^python: Missing: guest executable \/usr\/bin\/python3$/u],
      [stale, throwing, 123, /^python: the module failed: first second$/u],
      [await commandLaunch(reaching, "python"), reaching, 123, /^python: the module used process\.info, process\.spawn, process\.signals, which its manifest does not declare: /u],
    ] as const;
    for (const [command, release, status, line] of cases) {
      const running = launch({ release, command, args: ["python"] });
      await expect(running.done, String(line)).resolves.toBe(status);
      expect(running.linux.stderrLines, String(line)).toHaveLength(1);
      expect(running.linux.stderrLines[0], String(line)).toMatch(line);
      expect(records(running.linux.stderrLines)).toEqual([]);
    }
  });
});
