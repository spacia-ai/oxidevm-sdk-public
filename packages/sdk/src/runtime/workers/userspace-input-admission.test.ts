import { expect, it } from "vitest";
import { UserspaceCheckpointGate } from "./userspace-checkpoint-gate.js";
import { UserspaceStdin } from "./userspace-stdin.js";
import { admitUserspaceInput } from "./userspace-input-admission.js";
import { VMError } from "../errors.js";

it("freezes with unaccepted stdin pending and accepts it after the same session resumes", async () => {
  const gate = new UserspaceCheckpointGate(); let capacity = 0, attempts = 0;
  const stdin = new UserspaceStdin((_pid, bytes) => { attempts++; return Math.min(capacity, bytes.length); });
  const input = admitUserspaceInput(gate, () => stdin.write(1, 4, new Uint8Array([7, 8])));
  await gate.freeze(() => Promise.resolve());
  expect(attempts).toBe(1); expect(gate.executionAllowed).toBe(false);
  capacity = 2; gate.resume(); stdin.pump();
  expect(await input).toBe(2);
});

it("rejects a queued browser write when publication retires its original handle", async () => {
  const gate = new UserspaceCheckpointGate(), stdin = new UserspaceStdin(() => 0);
  const input = admitUserspaceInput(gate, () => stdin.write(2, 4, new Uint8Array([7])));
  const rejected = expect(input).rejects.toMatchObject({ code: "ABORTED" });
  await gate.freeze(() => Promise.resolve());
  stdin.rejectProcess(4, new VMError("ABORTED", "replaced")); gate.resume();
  await rejected;
});
