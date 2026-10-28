import type { UserspaceCheckpointGate } from "./userspace-checkpoint-gate.js";

/** Only the synchronous native attempt belongs to a freeze barrier. A zero-byte
 * accepted write remains a browser request and can wait across an ordinary save. */
export async function admitUserspaceInput<T>(gate: UserspaceCheckpointGate, attempt: () => Promise<T>): Promise<T> {
  let pending: Promise<T> | undefined;
  await gate.operation(() => {
    pending = attempt();
    // Attach rejection handling before releasing admission; the caller observes it below.
    void pending.catch(() => {});
    return Promise.resolve();
  });
  if (pending === undefined) throw new Error("Native input admission did not execute");
  return pending;
}
