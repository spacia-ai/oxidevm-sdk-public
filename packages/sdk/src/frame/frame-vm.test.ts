import {decodeSHA256} from "../values.js";
import {VMError} from "../runtime/errors.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserspaceVM, BackupDestination, SystemSnapshots, SystemStart, ListeningPort } from "../contracts.js";
import { PROCESS_STREAM_CREDIT } from "./protocol/process-io.js";
import { closeChannels, connect, fakeProcess, fakeVM, readAll, rejection, snapshot } from "./frame-vm.test-support.js";

afterEach(closeChannels);

describe("runtime frame VM", () => {
  it("prepares the running image through the frame without disposing or recreating the session", async () => {
    const { vm } = fakeVM(), { client } = await connect(vm);
    await client.prepareImage();
    expect(vm.prepareImage).toHaveBeenCalledOnce();
    expect(vm.dispose).not.toHaveBeenCalled();
    await client.dispose();
  });
  it("returns verified update offers over the common hosted API", async () => {
    const {vm}=fakeVM();const offer={...vm.image,version:"new"};
    const check=vi.fn(()=>Promise.resolve(offer));
    const {client}=await connect({...vm,checkForUpdate:check});
    expect(await client.checkForUpdate()).toEqual(offer);
    expect(check).toHaveBeenCalledOnce();
    await client.dispose();
  });
  it("creates the VM in the frame with the page's options and answers synchronous members from its description", async () => {
    const phases: string[] = [];
    const { vm } = fakeVM();
    const { client, created } = await connect(vm, phase => phases.push(phase));
    expect(phases).toEqual(["validate"]);
    expect(created).toEqual([expect.objectContaining({ mode: "system", workspaceId: "ws", ephemeral: false, runtime: { hosting: "self-hosted", baseUrl: "/oxidevm/runtime/" } })]);
    expect(client).toMatchObject({ mode: "system", image: { id: "full" }, workspace: { id: "ws", persistence: { kind: "persistent" } }, start: { kind: "booted", reason: "first-start" } });
    expect(client.network.state).toEqual({ kind: "off" });
    expect(client.license).toMatchObject({ tier: "licensed", commercial: false, validity: "grace", expiresAt: 1_800_000_000, validUntil: 1_800_604_800 });
  });

  it("round-trips workspace files and keeps the frame's error codes", async () => {
    const { client } = await connect(fakeVM().vm);
    await client.workspace.writeText("/a.txt", "hi");
    expect(await client.workspace.readText("/a.txt")).toBe("hi");
    expect(await client.workspace.readFile("/a.txt")).toEqual(new TextEncoder().encode("hi"));
    expect(await client.workspace.list()).toEqual([{ kind: "file", name: "a.txt", path: "/a.txt" }]);
    await client.workspace.remove("/a.txt");
    expect((await rejection(client.workspace.readFile("/a.txt"))).code).toBe("STORAGE_NOT_FOUND");
  });

  it("cancels a request in the frame when the page aborts it", async () => {
    const { client } = await connect(fakeVM().vm);
    const controller = new AbortController();
    const reading = client.workspace.readFile("/slow", controller.signal);
    controller.abort();
    expect((await rejection(reading)).code).toBe("ABORTED");
    // The channel stays usable after a cancellation.
    await client.workspace.writeText("/b", "ok");
  });

  it("runs exec through a spawned process: stdin in, output out, exit status back", async () => {
    const received: Uint8Array[] = [];
    const { vm } = fakeVM({ spawn: () => fakeProcess([new TextEncoder().encode("out")], false, { count: 0 }, received) });
    const { client } = await connect(vm);
    const result = await client.exec({ command: "cat", stdin: new TextEncoder().encode("in") });
    expect(new TextDecoder().decode(result.stdout)).toBe("out");
    expect(result.exit).toEqual({ kind: "exited", code: 0 });
    expect(new TextDecoder().decode(received[0])).toBe("in");
  });

  it("stops reading guest output once the page's credit is used up, and resumes as the page reads", async () => {
    const chunk = new Uint8Array(16 * 1024).fill(65);
    const pulls = { count: 0 };
    const { vm } = fakeVM({ spawn: () => fakeProcess(Array.from({ length: 64 }, () => chunk), true, pulls) });
    const { client } = await connect(vm);
    const terminal = await client.spawn({ command: "yes", terminal: { columns: 80, rows: 24 } });
    // Each round trip lets the frame process everything queued before it, without a wall-clock wait.
    for (let turn = 0; turn < 20; turn++) await client.workspace.writeText("/tick", String(turn));
    expect(pulls.count).toBeGreaterThan(0);
    // The frame may read one chunk ahead of the window, never the whole megabyte.
    expect(pulls.count).toBeLessThanOrEqual(PROCESS_STREAM_CREDIT + chunk.byteLength);
    expect((await readAll(terminal.output)).length).toBe(64 * chunk.byteLength);
    expect(await terminal.exit).toEqual({ kind: "exited", code: 0 });
  });

  it("forwards terminal resize, interrupt and kill to the frame's process", async () => {
    const resize = vi.fn(() => Promise.resolve());
    const interrupt = vi.fn(() => Promise.resolve());
    const kill = vi.fn(() => Promise.resolve());
    const base = fakeProcess([], true, { count: 0 });
    const { vm } = fakeVM({ spawn: () => ({ ...base, kind: "terminal", output: new ReadableStream<Uint8Array>(), resize, interrupt, kill }) });
    const { client } = await connect(vm);
    const terminal = await client.spawn({ command: "sh", terminal: { columns: 80, rows: 24 } });
    await terminal.resize({ columns: 100, rows: 30 });
    await terminal.interrupt();
    await terminal.kill("SIGINT", { scope: "process-group" });
    expect(resize).toHaveBeenCalledWith({ columns: 100, rows: 30 });
    expect(interrupt).toHaveBeenCalled();
    expect(kill).toHaveBeenCalledWith("SIGINT", { scope: "process-group" });
  });

  it("delivers watched ports as events and ends the watch when the page aborts", async () => {
    const { client } = await connect(fakeVM().vm);
    const seen: (readonly ListeningPort[])[] = [];
    const controller = new AbortController();
    const watching = client.watchListeningPorts(ports => { seen.push(ports); controller.abort(); }, { signal: controller.signal });
    await watching;
    expect(seen[0]).toEqual([{ port: 3000, address: "0.0.0.0", program: "node", previewable: true }]);
  });

  it("writes a backup to a destination the page holds", async () => {
    const written: number[] = [];
    const destination: BackupDestination = { kind: "file", createWritable: () => Promise.resolve({ write: bytes => { written.push(bytes.byteLength); return Promise.resolve(); }, close: () => Promise.resolve(), abort: () => Promise.resolve() }) };
    const exportBackup: SystemSnapshots["export"] = async (_snapshot, options) => {
      const writable = await options?.destination?.createWritable();
      await writable?.write(new Uint8Array(10));
      await writable?.close();
      return { kind: "written", bytes: 10 };
    };
    const { client } = await connect(fakeVM({ snapshots: { export: exportBackup } }).vm);
    if (client.mode !== "system") throw new Error("expected System");
    expect(await client.snapshots.export(snapshot.ref, { destination })).toEqual({ kind: "written", bytes: 10 });
    expect(written).toEqual([10]);
    expect(await client.snapshots.list()).toEqual([snapshot]);
    expect((await rejection(client.snapshots.inspect(new Blob(["x"])))).code).toBe("INVALID_ARGUMENT");
  });

  it("attaches a resumed process by key", async () => {
    const attached = fakeProcess([new TextEncoder().encode("again")], false, { count: 0 });
    const start: SystemStart = {
      kind: "resumed", snapshot, appData: null, newerFilesDropped: false, workspace: "in-sync",
      terminals: [{ source: "process", key: "p1", command: "npm run dev", screenTail: new Uint8Array([1]), attach: () => Promise.resolve(attached) }],
    };
    const { client } = await connect(fakeVM({ start }).vm);
    if (client.mode !== "system" || client.start.kind !== "resumed") throw new Error("expected a resumed System VM");
    const terminal = client.start.terminals[0];
    if (terminal?.source !== "process") throw new Error("expected a resumed process");
    const handle = await terminal.attach();
    if (handle.kind !== "process") throw new Error("expected a pipe process");
    expect(await readAll(handle.stdout)).toBe("again");
  });

  it("fails every pending request when the frame goes away, and every later one", async () => {
    const { client, channel } = await connect(fakeVM().vm);
    const reading = client.workspace.readFile("/slow");
    channel.port2.close();
    channel.port1.dispatchEvent(new Event("close"));
    expect((await rejection(reading)).code).toBe("PROTOCOL_ERROR");
    expect((await rejection(client.workspace.readText("/a"))).code).toBe("PROTOCOL_ERROR");
  });

  it("disposes the frame's VM, releases the frame and refuses later calls", async () => {
    const { vm } = fakeVM();
    const { client, release, disposed } = await connect(vm);
    await client.dispose();
    expect(vm.dispose).toHaveBeenCalledTimes(1);
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect((await rejection(client.workspace.readText("/a"))).code).toBe("PROTOCOL_ERROR");
  });
  it("returns the committed suspended point and retires the connection without another VM disposal", async () => {
    const {vm}=fakeVM();
    const {client,release,disposed}=await connect(vm);
    await expect(client.suspend({label:"Saved before closing"})).resolves.toEqual(snapshot);
    expect(vm.suspend).toHaveBeenCalledOnce();
    expect(vm.dispose).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(disposed).toHaveBeenCalledOnce();
    await client.dispose();
    expect(release).toHaveBeenCalledOnce();
    await expect(client.workspace.readText("/a")).rejects.toMatchObject({code:"PROTOCOL_ERROR"});
  });

  it("keeps the frame usable if suspension fails before publication", async () => {
    const {vm}=fakeVM();
    vm.suspend.mockRejectedValueOnce(new VMError("STORAGE_ERROR","not committed"));
    const {client,release,disposed}=await connect(vm);
    await expect(client.suspend({label:"Failed point"})).rejects.toMatchObject({code:"STORAGE_ERROR"});
    expect(release).not.toHaveBeenCalled();
    expect(disposed).not.toHaveBeenCalled();
    await client.workspace.writeText("/still-live","yes");
    expect(await client.workspace.readText("/still-live")).toBe("yes");
    await client.dispose();
  });
});

it("Userspace frames expose common starts and delegate gated snapshots to their owner", async () => {
  const { vm } = fakeVM();
  const capture = vi.fn(() => Promise.reject(new VMError("FEATURE_NOT_AVAILABLE", "Userspace restore points are gated", {reason:"release-gate-open"})));
  const linux: UserspaceVM = {
    ...vm,spawnJS: (): Promise<never> => Promise.reject(new Error("Unused JS worker fake")),mode:"userspace",image:{...vm.image,mode:"userspace"},
    start:{kind:"booted",reason:"first-start",workspaceDetails:{state:"in-sync",conflicts:[],omittedConflicts:0}},
    capabilities:{...vm.capabilities,snapshots:{available:false,reason:"release-gate-open"}},
    snapshots:{...vm.snapshots,capture},
  };
  const {client}=await connect(linux);
  expect(client.start).toEqual(linux.start);
  expect(client.capabilities.snapshots).toEqual({available:false,reason:"release-gate-open"});
  await expect(client.snapshots.capture({label:"point"})).rejects.toMatchObject({code:"FEATURE_NOT_AVAILABLE",detail:{reason:"release-gate-open"}});
  expect(capture).toHaveBeenCalledOnce();
  await client.dispose();
});

it("Userspace frames reattach resumed native process terminals through the common start", async () => {
  const {vm}=fakeVM();
  const process=fakeProcess([],false,{count:0});
  const attach=vi.fn(()=>Promise.resolve(process));
  const linux:UserspaceVM={
    ...vm,spawnJS: (): Promise<never> => Promise.reject(new Error("Unused JS worker fake")),mode:"userspace",image:{...vm.image,mode:"userspace"},
    start:{kind:"resumed",snapshot:{...snapshot,mode:"userspace"},appData:null,newerFilesDropped:false,workspace:"in-sync",terminals:[{source:"process",key:"linux-task",command:"sh",screenTail:new Uint8Array([65]),attach}]},
  };
  const {client}=await connect(linux);
  if(client.start.kind!=="resumed") throw new Error("expected resumed start");
  const terminal=client.start.terminals[0];
  if(terminal?.source!=="process") throw new Error("expected native task terminal");
  const attached=await terminal.attach();
  expect(attached.pid).toBe(process.pid);
  expect(attach).toHaveBeenCalledOnce();
  await client.dispose();
});

it("updates the hosted actual image only with the committed restore reply",async()=>{
 const start:SystemStart={kind:"resumed",snapshot,appData:null,newerFilesDropped:false,workspace:"in-sync",terminals:[]};
 const {vm}=fakeVM();let image=vm.image;
 Object.defineProperty(vm,"image",{get:()=>image});
 vm.snapshots.restore=()=>{image={...image,version:"restored",manifestSHA256:decodeSHA256("b".repeat(64),"restored source")};return Promise.resolve({start});};
 const {client}=await connect(vm);expect(client.image.version).toBe("1");
 await client.snapshots.restore(snapshot.ref);expect(client.image).toEqual(image);
 vm.snapshots.restore=()=>Promise.reject(new VMError("STORAGE_ERROR","refused before publication"));
 await expect(client.snapshots.restore(snapshot.ref)).rejects.toMatchObject({code:"STORAGE_ERROR"});expect(client.image).toEqual(image);
});

it("preserves explicit stable process keys on initial and restored handles",async()=>{
 const process=()=>({...fakeProcess([],false,{count:0}),snapshotKey:"process:12"});
 const start:SystemStart={kind:"resumed",snapshot,appData:null,newerFilesDropped:false,workspace:"in-sync",terminals:[{source:"process",key:"process:12",command:"sh",screenTail:new Uint8Array(),attach:()=>Promise.resolve(process())}]};
 const {client}=await connect(fakeVM({spawn:()=>process(),start}).vm);
 expect((await client.spawn({command:"sh"})).snapshotKey).toBe("process:12");
 if(client.start.kind!=="resumed"||client.start.terminals[0]?.source!=="process")throw new Error("missing resumed process");
 expect((await client.start.terminals[0].attach()).snapshotKey).toBe("process:12");
});
