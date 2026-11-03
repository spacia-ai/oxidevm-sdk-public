import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserspaceVM } from "../contracts.js";
import type { ModuleStart } from "../runtime/vm-types.js";
import { prepareModuleStart } from "../runtime/workers/js-process/module-artifacts.js";
import { ModuleCopies } from "../runtime/workers/js-process/module-copies.js";
import { commandRelease, fakeLocks, fakeTable, owner, server } from "../runtime/workers/js-process/module-commands.test-support.js";
import { bindFrameOwner } from "../vm-adapter.js";
import { enableModuleCommands } from "../wasm/commands.js";
import { pinsOf, relay } from "../wasm/commands.test-support.js";
import { moduleHandle } from "../wasm/handle.js";
import { spawnModule } from "../wasm/spawn.js";
import { closeChannels, connect, fakeProcess, fakeVM } from "./frame-vm.test-support.js";

afterEach(() => { closeChannels(); vi.unstubAllGlobals(); });

const diagnostics = { readJSProcessTrace: () => Promise.reject(new Error("unused")), watchAccelerationNotices: () => Promise.resolve() };

/**
 * A Userspace VM in the runtime frame whose module owner is backed by a real verified-copy store and registration owner,
 * as the frame's own local VM is (ADR 0028); the page reaches it only through frame protocol 17.
 */
function hostedModules() {
  const { vm } = fakeVM(), copies = new ModuleCopies(), starts: ModuleStart[] = [], table = fakeTable();
  const host: UserspaceVM = { ...vm, mode: "userspace", image: { ...vm.image, mode: "userspace" }, spawnJS: vi.fn(() => Promise.reject(new Error("unused"))) };
  const { commands: registrations } = owner(table, { copies }), link = relay(registrations, copies);
  bindFrameOwner(host, {
    diagnostics,
    modules: {
      missing: pins => Promise.resolve(copies.missing(pins)),
      spawn: async (_spec, start) => {
        (await prepareModuleStart(start.descriptor, start.files, { copies, locks: fakeLocks().locks }, new AbortController().signal)).lease?.release();
        starts.push(start);
        const process = fakeProcess([], false, { count: 0 });
        if (process.kind !== "process") throw new Error("expected a pipe process");
        return process;
      },
    },
    moduleCommands: link.owned,
  });
  return { host, starts, link, registrations, table };
}

describe("modules in the hosted runtime frame (frame protocol 17, ADR 0028)", () => {
  it("only missing files cross the frame: the page reads them from its own origin and the frame checks them", async () => {
    const release = await commandRelease(), files = server(release), { host, starts } = hostedModules();
    vi.stubGlobal("fetch", (url: string, init?: { readonly signal?: AbortSignal | null }) => files.fetch(url, { signal: init?.signal ?? new AbortController().signal }));
    const { client } = await connect(host);
    if (client.mode !== "userspace") throw new Error("expected a Userspace client");
    const handle = moduleHandle(release.manifest, pinsOf(release));
    await spawnModule(client, handle);
    await spawnModule(client, handle);
    // The first start probes with nothing, then sends every file the store lacked; the second sends and fetches nothing.
    expect(starts.map(start => Object.keys(start.files).length)).toEqual([release.served.size, 0]);
    expect(files.fetched).toHaveLength(release.served.size);
    await client.dispose();
  });

  it("a file that differs from its pin is refused by the frame before any process exists", async () => {
    const release = await commandRelease(undefined, { tamper: { "data.bin": Uint8Array.of(9, 9, 9, 9) } }), files = server(release), { host, starts } = hostedModules();
    vi.stubGlobal("fetch", (url: string, init?: { readonly signal?: AbortSignal | null }) => files.fetch(url, { signal: init?.signal ?? new AbortController().signal }));
    const { client } = await connect(host);
    if (client.mode !== "userspace") throw new Error("expected a Userspace client");
    await expect(spawnModule(client, moduleHandle(release.manifest, pinsOf(release)))).rejects.toMatchObject({ code: "GUEST_CRASH", detail: { reason: "wasm-module-integrity", file: "data.bin" } });
    expect(starts).toEqual([]);
    await client.dispose();
  });

  it("a cancelled enable settles, then disables", async () => {
    const release = await commandRelease(), files = server(release), { host, link, registrations, table } = hostedModules();
    vi.stubGlobal("fetch", (url: string, init?: { readonly signal?: AbortSignal | null }) => files.fetch(url, { signal: init?.signal ?? new AbortController().signal }));
    const { client } = await connect(host);
    if (client.mode !== "userspace") throw new Error("expected a Userspace client");
    const controller = new AbortController(), apply = table.runtime.applyTable.bind(table.runtime);
    // The page gives up while Rust applies the table in the frame: past the owner's last check, so it registers and
    // answers, and the page's call waits for that answer instead of rejecting at once.
    table.runtime.applyTable = request => { table.runtime.applyTable = apply; controller.abort(); return apply(request); };
    await expect(enableModuleCommands(client, moduleHandle(release.manifest, pinsOf(release)), { signal: controller.signal })).rejects.toMatchObject({ code: "ABORTED", message: "Turning module commands on was cancelled" });
    // The page saw the registration in the frame's answer and turned it off again: nothing stays on.
    expect(link.requests.at(-1)).toEqual({ operation: "disable", registration: 1 });
    expect(table.tables).toEqual([[{ registration: 1, concurrency: 4, reach: "none", name: "alpha" }, { registration: 1, concurrency: 4, reach: "none", name: "beta" }], []]);
    expect(registrations.launch({ kind: "module-command", registration: 1, name: "alpha", path: "/usr/local/bin/alpha", terminals: { stdin: false, stdout: false, stderr: false } })).toBeUndefined();
    await client.dispose();
  });

  it("turns commands on, reports their status and turns them off through the frame", async () => {
    const release = await commandRelease(), files = server(release), { host, table } = hostedModules();
    vi.stubGlobal("fetch", (url: string, init?: { readonly signal?: AbortSignal | null }) => files.fetch(url, { signal: init?.signal ?? new AbortController().signal }));
    const { client } = await connect(host);
    if (client.mode !== "userspace") throw new Error("expected a Userspace client");
    const commands = await enableModuleCommands(client, moduleHandle(release.manifest, pinsOf(release)));
    expect(commands.commands).toEqual(["alpha", "beta"]);
    await expect(commands.status()).resolves.toEqual({ enabled: true, skipped: [] });
    await commands.disable();
    expect(table.stubs).toEqual(new Set());
    await client.dispose();
  });
});
