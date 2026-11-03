import { expect, it } from "vitest";
import { callUserspaceU32 as call } from "../userspace-exports.js";
import { Writer, noValue, operation } from "../../js-process/codec.js";
import { dispositionOperation, interruptView, maskOperation, pendingOperation, signalBuffer, signalSet, takeArrivals } from "../../js-process/signals.js";
import { Trap } from "../../../wasm/runner/signal-trap.js";
import { TaskSignals } from "./task-signals.js";
import { fixture, operations } from "./bridge-fixture.test-support.js";
import type { CommandSignalNotice } from "../../userspace-command-abi.js";

/** What the driver does with a notice, then what the runner's trap yields for it. */
async function trapped(notice: CommandSignalNotice): Promise<unknown> {
  const task = new TaskSignals();
  task.deliver({ signal: notice.signal, interrupt: notice.interrupt, details: { code: notice.code, sender: notice.sender, uid: notice.uid, value: notice.value } });
  const trap = new Trap(interruptView(task.buffer), () => Promise.resolve());
  for (const arrival of takeArrivals(signalBuffer(task.buffer))) trap.deliver(arrival);
  return (await trap[Symbol.asyncIterator]().next()).value;
}

it("keeps a trapped SIGINT pending while the process blocks it, and delivers it once when unblocked (OXJR 14 and 127, Userspace API 146)", async () => {
  const f = await fixture();
  try {
    const { send } = operations(f);
    expect(send(dispositionOperation(2, "caught"))).toBe("default");
    expect(send(maskOperation("block", signalSet([2])))).toBe(0n);
    // Ctrl+C at the process's terminal: SIGINT to the process.
    expect(call(f.runtime.instance, "oxidevm_userspace_process_signal", f.pid, 2)).toBe(0);
    expect(call(f.runtime.instance, "oxidevm_userspace_run", 10_000, 0)).toBe(0);
    expect(f.notice()).toBeNull();
    expect(send(pendingOperation())).toBe(signalSet([2]));
    expect(send(maskOperation("unblock", signalSet([2])))).toBe(signalSet([2]));
    expect(call(f.runtime.instance, "oxidevm_userspace_run", 10_000, 0)).toBe(0);
    const notice = f.notice();
    expect(notice).toMatchObject({ signal: 2, interrupt: true });
    expect(f.notice()).toBeNull();
    expect(send(pendingOperation())).toBe(0n);
    if (notice === null) throw new Error("SIGINT did not arrive after unblock");
    expect(await trapped(notice)).toBe("SIGINT");
  } finally { await f.runtime.jitRuntime.dispose(); }
});

it("delivers a trapped real-time signal 36 sent by kill as an arrival with its code, sender pid and uid", async () => {
  const f = await fixture();
  try {
    const { send } = operations(f);
    expect(send(dispositionOperation(36, "caught"))).toBe("default");
    // kill(getpid(), 36), as `kill -s 36 <pid>` from a program of uid 1000 in the VM does.
    send(operation(62, new Writer().u32(f.pid).u8(36), noValue));
    expect(call(f.runtime.instance, "oxidevm_userspace_run", 10_000, 0)).toBe(0);
    const notice = f.notice();
    expect(notice).toMatchObject({ signal: 36, code: 0, sender: f.pid, uid: 1000, value: 0n });
    if (notice === null) throw new Error("signal 36 did not arrive");
    expect(await trapped(notice)).toEqual({ signal: 36, value: 0n, code: 0, pid: f.pid, uid: 1000 });
  } finally { await f.runtime.jitRuntime.dispose(); }
});
