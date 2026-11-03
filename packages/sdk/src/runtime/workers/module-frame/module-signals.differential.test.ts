import { describe, expect, it } from "vitest";
import { JS_PROCESS_PROTOCOL_VERSION } from "../../js-process/codec.js";
import { signalBuffer, takeArrivals, TRAPPABLE_SIGNALS, type SignalDetails, type TrappableSignalNumber } from "../../js-process/signals.js";
import { Random } from "../../fuzz.test-support.js";
import { TaskSignals } from "../js-process/task-signals.js";
import { brokerWith, spawn } from "./broker.test-support.js";

// Differential evidence for signals (engine ADR 0028, plan SL-I12): a module process's signal buffer (JS process
// protocol 5: pending bits, the interrupt word at byte 8 and the ring of real-time arrivals) is owned by the module
// frame's broker, which receives each notice as a message (relayed); a local JS process's buffer is set by the Userspace
// worker's driver itself (direct, `TaskSignals`). For the same seeded schedule of notices and of the module taking its
// arrivals and its interrupt word, both must show the module the same buffer after every step, and hand it the same
// arrivals, with the same details, in the same order.

const SEEDS = 16, STEPS = 120;

type Step =
  | { readonly kind: "notice"; readonly signal: TrappableSignalNumber; readonly interrupt: boolean; readonly details: SignalDetails }
  | { readonly kind: "take-pending" }
  | { readonly kind: "take-interrupt" };

function schedule(random: Random): Step[] {
  return Array.from({ length: STEPS }, (): Step => {
    const roll = random.below(10);
    if (roll < 5) {
      const details = { code: random.next() | 0, sender: random.below(0x8000_0000), uid: random.next(), value: BigInt(random.next()) << 32n | BigInt(random.next()) };
      return { kind: "notice", signal: random.pick(TRAPPABLE_SIGNALS), interrupt: random.chance(0.6), details };
    }
    return roll < 8 ? { kind: "take-pending" } : { kind: "take-interrupt" };
  });
}

/** The module's side of one step, on its signal buffer: what it took. */
function take(step: Step, buffer: SharedArrayBuffer): string {
  const source = signalBuffer(buffer);
  if (step.kind === "take-pending") {
    return `pending ${takeArrivals(source).map(({ signal, details }) => details === null ? String(signal) : `${String(signal)}(${String(details.code)} ${String(details.sender)} ${String(details.uid)} ${String(details.value)})`).join(",")}`;
  }
  if (step.kind === "take-interrupt") return `interrupt ${String(Atomics.exchange(source.words, 2, 0))}`;
  return "";
}

/** The whole buffer, so the pending words, the interrupt word, both ring counts and every slot are compared. */
const same = (left: SharedArrayBuffer, right: SharedArrayBuffer): boolean => {
  const a = new Uint8Array(left), b = new Uint8Array(right);
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
};
const words = (buffer: SharedArrayBuffer): string => `[${Array.from(new Int32Array(buffer, 0, 5), String).join(", ")}]`;

describe("signals relayed through the module broker match the driver's direct delivery (ADR 0028)", () => {
  it(`agree after every step (${String(SEEDS)} seeds x ${String(STEPS)} steps)`, async () => {
    let interruptsSeen = 0, deferred = 0, ringed = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const steps = schedule(new Random(seed)), direct = new TaskSignals(), directWords = new Int32Array(direct.buffer);
      const { port, runners } = brokerWith(), relayed = await spawn(port, runners, seed), relayedBuffer = relayed.words.buffer;
      const nudges: unknown[] = [];
      relayed.port.addEventListener("message", event => { nudges.push(event.data); });
      relayed.port.start();
      const takenDirect: string[] = [], takenRelayed: string[] = [];
      for (const [index, step] of steps.entries()) {
        if (step.kind === "notice") {
          // Direct: the driver's command loop delivers the notice, then reconciles on its next pass.
          direct.deliver({ signal: step.signal, interrupt: step.interrupt, details: step.details });
          if (step.interrupt && Atomics.load(directWords, 2) !== step.signal) deferred++;
          // Relayed: the notice travels on the service port; the broker applies it and nudges the runner once.
          const before = nudges.length;
          relayed.service.postMessage({ version: JS_PROCESS_PROTOCOL_VERSION, type: "signal-notice", signal: step.signal, interrupt: step.interrupt, ...step.details });
          await waitFor(() => nudges.length === before + 1, `seed ${String(seed)} step ${String(index)}: no nudge`);
          expect(nudges.at(-1)).toEqual({ version: JS_PROCESS_PROTOCOL_VERSION, type: "signal" });
        } else {
          takenDirect.push(take(step, direct.buffer));
          takenRelayed.push(take(step, relayedBuffer));
          if (step.kind === "take-pending") ringed += (takenDirect.at(-1)?.match(/\(/g) ?? []).length;
          if (step.kind === "take-interrupt" && takenDirect.at(-1) !== "interrupt 0") interruptsSeen++;
          // The interrupt word is free again: the driver offers a waiting interrupt on its next pass; the broker
          // retries on its own timer until the module has taken the previous one.
          direct.offerInterrupts();
        }
        await waitFor(() => same(relayedBuffer, direct.buffer),
          `seed ${String(seed)} step ${String(index)} (${step.kind}): direct ${words(direct.buffer)}, relayed ${words(relayedBuffer)}`);
      }
      expect(takenRelayed).toEqual(takenDirect);
      // Neither path touched the process's mailbox: signals never complete a request.
      expect(Atomics.load(relayed.header, 0)).toBe(0);
      relayed.channel.close();
    }
    // The schedules exercise both a free interrupt word and one the module had not reset yet.
    expect(interruptsSeen).toBeGreaterThan(SEEDS * 5);
    expect(deferred).toBeGreaterThan(SEEDS);
    // And real-time arrivals that carried their details through the ring.
    expect(ringed).toBeGreaterThan(SEEDS * 10);
  }, 120_000);
});

/** Polls `check` on the event loop (the broker's interrupt retry runs every 4 ms) for at most a second. */
async function waitFor(check: () => boolean, failure: string): Promise<void> {
  for (let tries = 0; tries < 500; tries++) {
    if (check()) return;
    await new Promise(resolve => { setTimeout(resolve, 2); });
  }
  throw new Error(failure);
}
