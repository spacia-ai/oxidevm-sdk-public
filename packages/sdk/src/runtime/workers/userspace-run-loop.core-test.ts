import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { HostAttention, postCounted } from "../host-attention.js";
import { decodeUserspacePendingWork } from "../userspace-abi.js";
import { admitJSProcess } from "./js-process/admission.js";
import { engineModulePath } from "./engine-wasm.test-support.js";
import { callUserspaceU32 as call } from "./userspace-exports.js";
import { RUN_ACTIONS_PER_SLICE, runUserspaceSlice, type UserspaceSlicePorts } from "./userspace-run-loop.js";
import { RUN_SLICE_MILLISECONDS } from "./userspace-run-slices.js";
import type { UserspaceAttentionChannel } from "../protocol/userspace-slices.js";
import { instantiateRuntime } from "./userspace-runtime.js";
import { mountTestRuntime, spawnRing, traceRingElf, type TestRuntime } from "./userspace-tier2.test-support.js";
import { newRuntimeState, type RuntimeState } from "./userspace-worker-state.js";

/** Every action of the fake clock takes this long, so a slice's length counts its actions. */
const ACTION_MICROSECONDS = 100;
const ACTION_MILLISECONDS = ACTION_MICROSECONDS / 1000;
const RING_ITERATIONS = 0xffff_fff0;

const runtimes: TestRuntime[] = [];
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.jitRuntime.dispose(); });

async function cpuLoop(): Promise<RuntimeState> {
  const bytes = new Uint8Array(await readFile(engineModulePath("oxidevm_userspace.wasm")));
  const runtime = await instantiateRuntime(await WebAssembly.compile(bytes.buffer), "run-loop-core-test", { kind: "disabled" }, "immediate");
  runtimes.push(runtime);
  mountTestRuntime(runtime, 1);
  spawnRing(runtime, traceRingElf(RING_ITERATIONS));
  return newRuntimeState(runtime, "ready", undefined, undefined);
}

function counter(): Int32Array<SharedArrayBuffer> {
  return new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
}

/** A fake clock that advances one action per reading after a slice's first, with a hook per action. */
function slicePorts(attention: HostAttention<UserspaceAttentionChannel>, onAction: (action: number) => void = () => {}) {
  const clock = { micros: 0, action: -1 };
  const calls = { servicePendingWork: 0, serviceHostRequests: [] as number[], finishResult: 0, scheduleRun: 0 };
  const ports: UserspaceSlicePorts = {
    // The first reading starts the slice; each later one follows one action.
    now: () => {
      if (clock.action >= 0) clock.micros += ACTION_MICROSECONDS;
      clock.action += 1;
      if (clock.action > 0) onAction(clock.action);
      return clock.micros / 1000;
    },
    interactiveUntil: () => 0,
    attention,
    servicePendingWork: () => { calls.servicePendingWork += 1; },
    serviceHostRequests: () => { calls.serviceHostRequests.push(clock.action); },
    finishResult: () => { calls.finishResult += 1; },
    scheduleRun: () => { calls.scheduleRun += 1; },
  };
  /** Runs one slice from the clock's current time; returns the actions it took. */
  const slice = (active: RuntimeState): number => {
    clock.action = -1;
    runUserspaceSlice(active, ports);
    return clock.action;
  };
  return { clock, calls, slice };
}

describe("Userspace run slices with host attention", () => {
  it("ends a guest CPU loop's slice at the first action boundary after a counted host message", async () => {
    const active = await cpuLoop();
    const attention = new HostAttention<UserspaceAttentionChannel>(), control = counter();
    attention.watch("control", control);
    const arrival = 7;
    const { calls, slice } = slicePorts(attention, action => { if (action === arrival) postCounted(control, () => undefined); });
    // Without host attention this slice would run its full 32 ms: 320 actions of the fake clock.
    expect(RUN_SLICE_MILLISECONDS / ACTION_MILLISECONDS).toBeGreaterThan(300);
    expect(slice(active)).toBe(arrival);
    expect(active.slices.ends["host-attention"]).toBe(1);
    expect(active.slices.hostAttention.control).toBe(1);
    expect(calls).toMatchObject({ servicePendingWork: 1, finishResult: 0, scheduleRun: 1 });
  });

  it("runs the full slice when no producer posts", async () => {
    const active = await cpuLoop();
    const attention = new HostAttention<UserspaceAttentionChannel>();
    attention.watch("control", counter());
    const { slice } = slicePorts(attention);
    expect(slice(active)).toBe(Math.round(RUN_SLICE_MILLISECONDS / ACTION_MILLISECONDS));
    expect(active.slices.ends).toMatchObject({ deadline: 1, "host-attention": 0 });
    expect(RUN_ACTIONS_PER_SLICE).toBeGreaterThan(RUN_SLICE_MILLISECONDS / ACTION_MILLISECONDS);
  });

  it("keeps the guest at least the service gap it just waited, under continuous host attention", async () => {
    const active = await cpuLoop();
    const attention = new HostAttention<UserspaceAttentionChannel>(), control = counter();
    attention.watch("control", control);
    // One message the worker never receives keeps attention pending for every slice.
    postCounted(control, () => undefined);
    const { clock, slice } = slicePorts(attention);
    const minimum = slice(active);
    expect(minimum * ACTION_MILLISECONDS).toBeGreaterThanOrEqual(0.25);
    let guest = 0, host = 0;
    for (const gap of [2, 0.05, 5, 1]) {
      clock.micros += gap * 1000; host += gap;
      const actions = slice(active);
      guest += actions * ACTION_MILLISECONDS;
      // The slice runs at least as long as the worker just spent serving the host.
      expect(actions * ACTION_MILLISECONDS).toBeGreaterThanOrEqual(Math.max(0.25, gap) - 1e-9);
      expect(actions * ACTION_MILLISECONDS).toBeLessThan(Math.max(0.25, gap) + 2 * ACTION_MILLISECONDS);
    }
    expect(guest).toBeGreaterThanOrEqual(host);
    expect(active.slices.ends["host-attention"]).toBe(5);
    expect(active.slices.attentionDeferrals).toBeGreaterThan(0);
  });

  it("serves a host request the runtime raised mid-slice without ending the slice", async () => {
    const active = await cpuLoop();
    // A JS process launch is a command host request that waits for the worker.
    admitJSProcess(active, 1, [], [], "/");
    expect(decodeUserspacePendingWork(call(active.instance, "oxidevm_userspace_pending_work")).hostRequest).toBe(true);
    const attention = new HostAttention<UserspaceAttentionChannel>();
    const { calls, slice } = slicePorts(attention);
    expect(slice(active)).toBe(Math.round(RUN_SLICE_MILLISECONDS / ACTION_MILLISECONDS));
    // The inline service runs every 0.25 ms of slice time while the runtime reports host work.
    expect(calls.serviceHostRequests[0]).toBeLessThanOrEqual(3);
    expect(calls.serviceHostRequests.length).toBeGreaterThan(100);
    expect(active.slices.inlinePendingWorkPolls).toBeGreaterThanOrEqual(calls.serviceHostRequests.length);
    expect(active.slices.ends.deadline).toBe(1);
  });
});
